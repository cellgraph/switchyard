import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { record, validRexId, type RexPlacement } from "./agent-config.ts";
import type { createAgentStore, ExecutionRecord, SessionRecord } from "./agent-store.ts";
import type { AgentResult, AgentTurn } from "./agent.ts";
import { readEvidence, type ExecutionCorrelation } from "./remote-execution.ts";

type RexCommand = (binary: string, args: string[]) => Promise<string>;
const exec = promisify(execFile);
const blockLabel = (key: string) => "Switchyard " + key;

async function runRex(binary: string, args: string[]): Promise<string> {
  const { stdout } = await exec(binary, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  return stdout;
}

type ProcessEvidence =
  | { state: "unavailable" }
  | { state: "running" }
  | { state: "exited"; exitCode: number; signal?: string };

async function temporary<T>(useDirectory: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "switchyard-rex-"));
  try {
    return await useDirectory(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createRexExecution(
  executions: ReturnType<typeof createAgentStore>,
  run: RexCommand = runRex,
) {
  function command(rex: RexPlacement, ...args: string[]): Promise<string> {
    return run(rex.executable, ["--autostart=false", "-S", rex.endpoint, ...args]);
  }

  function attempt(id: string) {
    const execution = executions.get(id);
    if (!execution?.remote) throw new Error("Remote execution record not found.");
    const session = executions.session(execution.sessionId)!;
    const rex = session.rex!;
    const correlation: ExecutionCorrelation = {
      version: 1,
      key: execution.remote.key,
      executionId: execution.id,
      assignmentId: execution.assignmentId,
      sessionId: execution.sessionId,
      expectedNativeId: execution.remote.expectedNativeId,
    };
    return {
      execution,
      session,
      rex,
      correlation,
      directory: posix.join(rex.stateDirectory, correlation.key),
    };
  }

  function hold(id: string, reason: string): void {
    executions.recordRemote(id, { outcome: { outcome: "unknown", reason } });
  }

  async function processEvidence(
    rex: RexPlacement,
    blockId: string | null,
  ): Promise<ProcessEvidence> {
    if (!blockId) return { state: "unavailable" };
    try {
      const reply = record(
        JSON.parse(
          await command(rex, "block", "call", "-s", rex.session, "-b", blockId, "process", "{}"),
        ),
      );
      const exit = record(reply?.last_exit);
      if (typeof exit?.exit_code === "number" && Number.isInteger(exit.exit_code))
        return {
          state: "exited",
          exitCode: exit.exit_code,
          ...(typeof exit.signal === "string" ? { signal: exit.signal } : {}),
        };
      if (reply?.last_exit === null && Number.isInteger(record(reply.child)?.pid))
        return { state: "running" };
    } catch {
      // A missing block or a broken connection cannot establish process exit.
    }
    return { state: "unavailable" };
  }

  async function inspect(
    id: string,
    reread = true,
  ): Promise<{
    execution: ExecutionRecord;
    session: SessionRecord;
    observation: { process: ProcessEvidence; evidence: "valid" | "unavailable" | "conflicting" };
    result?: Extract<AgentResult, { outcome: "completed" }>;
  }> {
    const { execution, rex, correlation, directory } = attempt(id);
    const blockId = execution.remote!.blockId;
    let process = await processEvidence(rex, blockId);
    const read = () =>
      temporary(async (local) => {
        const path = join(local, "evidence.json");
        try {
          // Rex can transfer through another session on this endpoint if the original block is gone.
          await command(rex, "cp", ":" + posix.join(directory, "evidence.json"), path);
        } catch {
          return { state: "unavailable" } as const;
        }
        const raw = await readFile(path);
        try {
          const evidence = readEvidence(JSON.parse(raw.toString("utf8")), correlation);
          return {
            state: "valid",
            evidence,
            digest: createHash("sha256").update(raw).digest("hex"),
          } as const;
        } catch {
          return { state: "conflicting" } as const;
        }
      });
    let observed = await read();
    if (!blockId && observed.state === "valid") {
      const observedBlock = observed.evidence.blockId;
      process = await processEvidence(rex, observedBlock);
      // If the executor exited since the first read, a final atomic replacement may be available.
      if (process.state === "exited" && !observed.evidence.result) {
        const latest = await read();
        if (latest.state === "valid" && latest.evidence.blockId !== observedBlock)
          observed = { state: "conflicting" };
        else if (latest.state !== "unavailable") observed = latest;
      }
    }

    let result;
    let finalObserved = false;
    let state: "valid" | "unavailable" | "conflicting" = observed.state;
    if (observed.state === "valid") {
      const { evidence, digest } = observed;
      const accepted = executions.recordRemote(id, {
        blockId: evidence.blockId,
        nativeId: evidence.nativeId,
        ...(evidence.result ? { outcome: evidence.result, digest } : {}),
      });
      if (!accepted) state = "conflicting";
      else if (evidence.result) {
        finalObserved = true;
        if (evidence.result.outcome === "completed") result = evidence.result;
      }
    }

    if (state === "conflicting") hold(id, "Remote execution evidence conflicts with the claim.");
    else if (process.state !== "running" && !finalObserved)
      hold(
        id,
        process.state === "exited"
          ? "The Rex process exited without a confirmed native outcome."
          : "Could not confirm the Rex process or native outcome.",
      );

    const saved = attempt(id);
    // A concurrent observer can commit final evidence while this read holds an interim snapshot.
    if (
      reread &&
      !finalObserved &&
      !execution.remote!.resultDigest &&
      saved.execution.remote!.resultDigest
    )
      return inspect(id, false);
    return {
      execution: saved.execution,
      session: saved.session,
      observation: { process, evidence: state },
      ...(result ? { result } : {}),
    };
  }

  async function cancel(id: string) {
    const inspected = await inspect(id);
    const { execution, rex } = attempt(id);
    const blockId = execution.remote!.blockId;
    if (
      !blockId ||
      (execution.status !== "running" && execution.status !== "unknown") ||
      inspected.observation.evidence === "conflicting" ||
      inspected.observation.process.state !== "running"
    )
      return { ...inspected, interruption: "unavailable" as const };
    try {
      const reply = record(
        JSON.parse(await command(rex, "block", "inspect", "-s", rex.session, blockId, "--json")),
      );
      const block = record(reply?.block);
      if (
        reply?.session_id !== rex.session ||
        block?.block_id !== blockId ||
        block.label !== blockLabel(execution.remote!.key)
      )
        return { ...inspected, interruption: "unavailable" as const };
    } catch {
      return { ...inspected, interruption: "unavailable" as const };
    }
    try {
      await command(rex, "send-key", "-s", rex.session, "-b", blockId, "ctrl+c");
    } catch {
      return { ...(await inspect(id)), interruption: "unconfirmed" as const };
    }
    return { ...(await inspect(id)), interruption: "requested" as const };
  }

  return {
    inspect,
    cancel,
    async recover() {
      const observations = [];
      for (const id of executions.unresolvedRemote()) {
        const { execution, observation } = await inspect(id);
        observations.push({ execution, observation });
      }
      return observations;
    },
    async dispatch(
      execution: ExecutionRecord,
      session: SessionRecord,
      { prompt, outputSchema, signal }: Pick<AgentTurn, "prompt" | "outputSchema" | "signal">,
    ) {
      const id = execution.id;
      const { rex, correlation, directory } = attempt(id);
      const notStarted = (reason: string) => {
        executions.recordRemote(id, { outcome: { outcome: "not_started", reason } });
        return { execution: executions.get(id)!, session: executions.session(session.id)! };
      };

      if (signal?.aborted) return notStarted("Canceled before Rex dispatch.");
      try {
        await temporary(async (local) => {
          const source = join(local, correlation.key);
          await mkdir(source, { mode: 0o700 });
          await writeFile(
            join(source, "request.json"),
            JSON.stringify({ ...correlation, context: session.context, prompt, outputSchema }),
            { mode: 0o600 },
          );
          await command(rex, "cp", "-s", rex.session, "-r", source, ":" + rex.stateDirectory + "/");
        });
      } catch {
        return notStarted("Could not stage the Rex request before dispatch.");
      }
      if (signal?.aborted) return notStarted("Canceled before Rex dispatch.");

      let ack: unknown;
      try {
        ack = JSON.parse(
          await command(
            rex,
            "run",
            "-s",
            rex.session,
            "--json",
            "--shell=none",
            "--keep-open",
            "--focus=false",
            "--label",
            blockLabel(correlation.key),
            "--",
            rex.node,
            rex.executor,
            directory,
          ),
        );
      } catch {
        // Failure to receive a usable acknowledgement does not authorize a second launch.
      }
      const blocks = record(ack)?.block_ids;
      const blockId = Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : undefined;
      if (validRexId(blockId, "block") && !executions.recordRemote(id, { blockId }))
        hold(id, "The Rex launch acknowledgement conflicts with the recorded block.");

      for (;;) {
        const stopping = signal?.aborted;
        const inspected = stopping ? await cancel(id) : await inspect(id);
        if (!stopping && signal?.aborted) continue;
        if (inspected.execution.status === "completed" && !inspected.result)
          throw new Error(
            "The execution completed but its correlated Rex result is unavailable. Inspect the same execution.",
          );
        if (
          stopping ||
          (inspected.execution.status !== "running" &&
            (inspected.execution.status !== "unknown" ||
              inspected.execution.remote?.resultDigest)) ||
          inspected.observation.process.state !== "running" ||
          inspected.observation.evidence === "conflicting"
        )
          return inspected;
        await delay(1500, undefined, { signal }).catch((error: unknown) => {
          if (!signal?.aborted) throw error;
        });
      }
    },
  };
}
