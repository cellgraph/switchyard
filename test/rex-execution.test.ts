import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RexPlacement } from "../src/agent-config.ts";
import { createAgentController } from "../src/agent-controller.ts";
import type { ExecutionRecord } from "../src/agent-store.ts";
import { createRexExecution } from "../src/rex-execution.ts";
import { WorkflowStore } from "../src/store.ts";
import { earlyExitPrompt, earlyExitStub } from "./fixtures/execution.ts";

let root: string;
let db: string;
let store: WorkflowStore;
let rex: RexPlacement;
let runs: Map<
  string,
  { child: ChildProcess; exited: Promise<void>; stderr: string; label: string }
>;
let stageFails: boolean;
let disconnect: boolean;
let sessionLost: boolean;
let loseAck: boolean;
let hideEvidence: boolean;
let targetBlock: string | undefined;
let pauseRead: (() => Promise<void>) | undefined;
let pauseProcess: (() => Promise<void>) | undefined;
const context = () => ({ provider: "codex" as const, workingDirectory: root });
const intent = (id = "execution", prompt = "offline fixture") => ({
  id,
  assignmentId: "assignment",
  agentName: "reviewer",
  context: context(),
  rex,
  prompt,
});

function statePath(execution: ExecutionRecord) {
  return join(rex.stateDirectory, execution.remote!.key);
}

const transport = vi.fn(async (binary: string, args: string[]) => {
  expect(binary).toBe(rex.executable);
  expect(args.slice(0, 3)).toEqual(["--autostart=false", "-S", rex.endpoint]);
  const executions = store.agentExecutions();
  expect(executions.get("execution")?.remote?.key).toBeDefined();
  const command = args[3];
  if (disconnect) throw new Error("transport unavailable");
  if (sessionLost && args.includes(rex.session)) throw new Error("Rex session not found");
  if (command === "cp") {
    const [source, destination] = args.slice(-2) as [string, string];
    if (source.startsWith(":")) {
      if (hideEvidence) throw new Error("remote evidence unavailable");
      await cp(source.slice(1), destination);
      if (pauseRead) {
        const pause = pauseRead;
        pauseRead = undefined;
        await pause();
      }
      return "";
    }
    if (stageFails) throw new Error("failed to stage");
    await cp(source, join(destination.slice(1), basename(source)), { recursive: true });
    return "";
  }
  if (command === "run") {
    const blockId = "block:" + randomUUID();
    const position = args.indexOf("--");
    const [node, executor, directory] = args.slice(position + 1) as [string, string, string];
    const child = spawn(node, [executor, directory], {
      env: { ...process.env, REX_BLOCK: blockId },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const label = args[args.indexOf("--label") + 1]!;
    const entry = { child, exited: once(child, "close").then(() => {}), stderr: "", label };
    runs.set(blockId, entry);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      entry.stderr += chunk;
    });
    if (loseAck) {
      hideEvidence = true;
      throw new Error("lost launch acknowledgement");
    }
    return JSON.stringify({ block_ids: [blockId] });
  }
  if (command === "block" && args[4] === "inspect") {
    const blockId = args.at(-2)!;
    return JSON.stringify({
      session_id: rex.session,
      block: { block_id: blockId, label: runs.get(blockId)?.label },
    });
  }
  const blockId = args[args.indexOf("-b") + 1]!;
  const entry = runs.get(blockId);
  if (!entry) throw new Error("block not found");
  if (command === "block") {
    if (pauseProcess) {
      const pause = pauseProcess;
      pauseProcess = undefined;
      await pause();
    }
    const { child } = entry;
    return JSON.stringify(
      child.exitCode !== null || child.signalCode
        ? { last_exit: { exit_code: child.exitCode ?? -1, signal: child.signalCode } }
        : { last_exit: null, child: { pid: child.pid } },
    );
  }
  if (command === "send-key") {
    targetBlock = blockId;
    expect(args.at(-1)).toBe("ctrl+c");
    entry.child.kill("SIGINT");
    return "";
  }
  throw new Error("Unexpected command.");
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "switchyard-rex-test-"));
  db = join(root, "controller.sqlite");
  store = new WorkflowStore(db);
  rex = {
    endpoint: "ssh://agent@execution.example/run/user/1000/rex/server.sock",
    session: "session:" + randomUUID(),
    executable: "/fixture/rex",
    node: process.execPath,
    executor: fileURLToPath(new URL("fixtures/rex-executor.ts", import.meta.url)),
    stateDirectory: join(root, "remote"),
  };
  await mkdir(rex.stateDirectory, { mode: 0o700 });
  runs = new Map();
  stageFails = disconnect = sessionLost = loseAck = hideEvidence = false;
  targetBlock = undefined;
  pauseRead = undefined;
  pauseProcess = undefined;
  transport.mockClear();
});

afterEach(async () => {
  for (const { child, exited } of runs.values()) {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    await exited;
  }
  store.close();
  await rm(root, { recursive: true, force: true });
});

function subsystem() {
  const executions = store.agentExecutions();
  const remote = createRexExecution(executions, transport);
  const local = vi.fn(() => {
    throw new Error("Remote assignment reached local adapter.");
  });
  return { ...createAgentController(executions, local, remote), ...remote, executions, local };
}

async function waiting(id: string): Promise<ExecutionRecord> {
  return vi.waitFor(async () => {
    const execution = store.agentExecutions().get(id)!;
    expect(execution).toBeTruthy();
    await stat(join(statePath(execution), "waiting"));
    return execution;
  });
}

it("reconciles a lost launch acknowledgement after restart without replay and retrieves the same result", async () => {
  loseAck = true;
  const first = subsystem();
  const launched = await first.execute(intent("execution", "wait for release"));
  expect(launched.execution).toMatchObject({ status: "unknown", remote: { blockId: null } });
  await waiting("execution");
  expect(first.local).not.toHaveBeenCalled();
  const blockId = [...runs.keys()][0]!;
  store.close();
  store = new WorkflowStore(db);
  const restarted = subsystem();
  loseAck = hideEvidence = false;
  expect(await restarted.recover()).toMatchObject([
    {
      execution: { status: "unknown", remote: { blockId } },
      observation: { process: { state: "running" } },
    },
  ]);
  expect(await restarted.execute(intent())).not.toHaveProperty("result");
  await expect(restarted.execute(intent("retry"))).rejects.toThrow("already has");
  await writeFile(join(statePath(launched.execution), "release"), "");
  await runs.get(blockId)!.exited;
  sessionLost = true;
  const recovered = await restarted.recover();
  expect(recovered).toMatchObject([
    {
      execution: { status: "completed", remote: { blockId } },
      observation: { process: { state: "unavailable" }, evidence: "valid" },
    },
  ]);
  const result = await restarted.inspect("execution");
  expect(result).toMatchObject({
    session: { id: launched.session.id, agentName: "reviewer", placement: "rex" },
    result: { outcome: "completed", structuredOutput: { ok: true } },
  });
  expect(await restarted.inspect("execution")).toEqual(result);
  expect(runs.size).toBe(1);
});

it("cancels only the correlated block and preserves unknown when cancellation yields no known outcome", async () => {
  loseAck = true;
  const controller = subsystem();
  const one = await controller.execute(intent("execution", "wait for release"));
  const two = await controller.execute({
    ...intent("other", "wait for release"),
    assignmentId: "other",
  });
  await waiting("execution");
  await waiting("other");
  hideEvidence = false;
  const [firstBlock, secondBlock] = runs.keys();
  const evidencePath = join(statePath(one.execution), "evidence.json");
  const evidence = await readFile(evidencePath, "utf8");
  runs.get(firstBlock!)!.label = runs.get(secondBlock!)!.label;
  expect((await controller.cancel(one.execution.id)).interruption).toBe("unavailable");
  expect(targetBlock).toBeUndefined();
  runs.get(firstBlock!)!.label = "Switchyard " + one.execution.remote!.key;
  expect(await readFile(evidencePath, "utf8")).toBe(evidence);
  const cancelled = await controller.cancel(one.execution.id);
  expect(cancelled.interruption).toBe("requested");
  expect(targetBlock).toBe(firstBlock);
  await runs.get(firstBlock!)!.exited;
  expect(await controller.inspect(one.execution.id)).toMatchObject({
    execution: { status: "unknown" },
    observation: { process: { state: "exited" } },
  });
  expect(await controller.inspect(two.execution.id)).toMatchObject({
    observation: { process: { state: "running" } },
  });
  expect(runs.get(secondBlock!)!.child.exitCode).toBeNull();
  await expect(stat(join(statePath(one.execution), "interrupted"))).resolves.toBeDefined();
});

it("requests cancellation if interruption arrives during a failed Rex poll", async () => {
  const controller = subsystem();
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  pauseProcess = async () => {
    entered.resolve();
    await resume.promise;
    throw new Error("Rex process query interrupted");
  };
  const dispatched = controller.execute({
    ...intent("execution", "wait for release"),
    signal: abort.signal,
  });
  const held = await waiting("execution");
  await entered.promise;
  abort.abort();
  resume.resolve();
  expect(await dispatched).toMatchObject({ interruption: "requested" });
  expect(targetBlock).toBe(held.remote!.blockId);
  await runs.get(targetBlock!)!.exited;
  expect((await controller.inspect(held.id)).execution.status).toBe("unknown");
});

it("holds after connection loss and rejects corrupted or rewritten correlated evidence", async () => {
  const controller = subsystem();
  const initial = await controller.execute(intent());
  expect(initial.execution.status).toBe("completed");
  const path = join(statePath(initial.execution), "evidence.json");
  const original = await readFile(path, "utf8");
  for (const changed of [
    { ...JSON.parse(original), sessionId: randomUUID() },
    { ...JSON.parse(original), assignmentId: "unrelated" },
    { ...JSON.parse(original), result: { outcome: "completed", response: "changed" } },
  ]) {
    await writeFile(path, JSON.stringify(changed));
    const inspected = await controller.inspect(initial.execution.id);
    expect(inspected.observation.evidence).toBe("conflicting");
    expect(inspected).not.toHaveProperty("result");
    expect(inspected.execution).toEqual(initial.execution);
  }
  await writeFile(path, original);
  disconnect = true;
  expect(await controller.inspect(initial.execution.id)).toMatchObject({
    execution: { status: "completed" },
    observation: { evidence: "unavailable" },
  });
  disconnect = false;
  expect(await controller.inspect(initial.execution.id)).toMatchObject({
    result: { outcome: "completed", response: "fixture done" },
  });
  const duplicate = spawn(rex.node, [rex.executor, statePath(initial.execution)], {
    env: { ...process.env, REX_BLOCK: "block:" + randomUUID() },
  });
  expect(await once(duplicate, "close")).toEqual([0, null]);
  expect(await readFile(path, "utf8")).toBe(original);
});

it("permits explicit retry only after a known prelaunch failure", async () => {
  const controller = subsystem();
  stageFails = true;
  const failedStage = await controller.execute(intent());
  expect(failedStage.execution.status).toBe("not_started");
  expect(runs.size).toBe(0);
  stageFails = false;
  const unavailableDirectory = await controller.execute({
    ...intent("bad-directory"),
    context: { ...context(), workingDirectory: join(root, "absent") },
  });
  expect(unavailableDirectory.execution).toMatchObject({
    status: "not_started",
    reason: "Remote working or config directory is unavailable.",
  });
  expect((await controller.execute(intent("retry"))).execution.status).toBe("completed");
});

it("records local staging failure as known non-execution before contacting Rex", async () => {
  const controller = subsystem();
  vi.stubEnv("TMPDIR", join(root, "missing-temp-dir"));
  try {
    expect((await controller.execute(intent())).execution).toMatchObject({
      status: "not_started",
      reason: "Could not stage the Rex request before dispatch.",
    });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
  expect((await controller.execute(intent("retry"))).execution.status).toBe("completed");
});

it.each([
  ["dispatch", "available"],
  ["dispatch", "unavailable"],
  ["inspect", "available"],
])(
  "%s rechecks the final file after concurrent recovery when it is %s",
  async (operation, availability) => {
    const controller = subsystem();
    if (operation === "inspect") {
      loseAck = true;
      await controller.execute(intent("execution", "wait for release"));
      await waiting("execution");
      loseAck = hideEvidence = false;
      expect(await controller.inspect("execution")).toMatchObject({
        execution: { remote: { blockId: expect.any(String) } },
      });
    }
    const copied = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    pauseRead = async () => {
      copied.resolve();
      await resume.promise;
    };
    const observing =
      operation === "inspect"
        ? controller.inspect("execution")
        : controller.execute(intent("execution", "wait for release"));
    const checked = observing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await copied.promise;
      const held = await waiting("execution");
      await writeFile(join(statePath(held), "release"), "");
      await [...runs.values()][0]!.exited;
      expect(await controller.inspect(held.id)).toMatchObject({
        execution: { status: "completed" },
        result: { structuredOutput: { ok: true } },
      });
      hideEvidence = availability === "unavailable";
    } finally {
      resume.resolve();
    }
    if (availability === "available") {
      expect(await checked).toMatchObject({
        value: {
          execution: { status: "completed" },
          result: { structuredOutput: { ok: true } },
        },
      });
    } else {
      expect(await checked).toEqual({
        error: new Error(
          "The execution completed but its correlated Rex result is unavailable. Inspect the same execution.",
        ),
      });
      expect(controller.executions.get("execution")?.status).toBe("completed");
    }
    expect(runs.size).toBe(1);
  },
);

it("contains the pinned SDK child crash with the original durable claim and a single native launch", async () => {
  const stub = join(root, "early-exit-codex");
  await writeFile(stub, earlyExitStub, { mode: 0o700 });
  const controller = subsystem();
  const outcome = await controller.execute(intent("execution", earlyExitPrompt));
  expect(outcome.execution).toMatchObject({
    status: "unknown",
    remote: { blockId: expect.any(String) },
  });
  const run = runs.get(outcome.execution.remote!.blockId!)!;
  await run.exited;
  const inspection = await controller.inspect(outcome.execution.id);
  expect(inspection.observation.process).toMatchObject({ state: "exited" });
  // Some hosts let the SDK catch the child exit before the unhandled stdin error.
  if (run.child.exitCode === 1) expect(run.stderr).toMatch(/^Error: write EPIPE$/m);
  else expect(run.child.exitCode).toBe(0);
  expect(await readFile(stub + ".started", "utf8")).toBe("started\n");
  expect(await controller.execute(intent())).toMatchObject({ execution: outcome.execution });
  await expect(controller.execute(intent("retry"))).rejects.toThrow("already has");
  await controller.recover();
  expect(controller.executions.get(outcome.execution.id)).toEqual(outcome.execution);
  expect(runs.size).toBe(1);
});
