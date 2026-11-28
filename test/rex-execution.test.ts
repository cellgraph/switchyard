import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
let launchError: Error | undefined;
let disconnect: boolean;
let sessionLost: boolean;
let loseAck: boolean;
let hideEvidence: boolean;
let acknowledgementBlock: string | undefined;
let targetBlock: string | undefined;
let pauseStage: (() => Promise<void>) | undefined;
let pauseAck: (() => Promise<void>) | undefined;
let pauseBlockInspect: (() => Promise<void>) | undefined;
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
    if (pauseStage) await pauseStage();
    return "";
  }
  if (command === "run") {
    if (launchError) throw launchError;
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
    if (pauseAck) await pauseAck();
    return JSON.stringify({ block_ids: [acknowledgementBlock ?? blockId] });
  }
  if (command === "block" && args[4] === "inspect") {
    const blockId = args.at(-2)!;
    if (pauseBlockInspect) await pauseBlockInspect();
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
  launchError = undefined;
  acknowledgementBlock = undefined;
  targetBlock = undefined;
  pauseStage = pauseAck = undefined;
  pauseBlockInspect = undefined;
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

function subsystem(connection = store) {
  const executions = connection.agentExecutions();
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

it("can return after launch and recover the terminal result in a separate observation", async () => {
  const controller = subsystem();
  const launched = await controller.execute({
    ...intent("execution", "wait for release"),
    waitForResult: false,
  });
  expect(launched.execution).toMatchObject({
    status: "running",
    remote: { launchAuthorized: true },
  });
  expect(launched.result).toBeUndefined();
  const execution = await waiting("execution");
  await writeFile(join(statePath(execution), "release"), "");
  await vi.waitFor(async () => {
    expect(await controller.inspect("execution")).toMatchObject({
      execution: { status: "completed" },
      result: { outcome: "completed" },
    });
  });
  expect(runs.size).toBe(1);
});

it("fences a staged launch when fresh external confirmation fails", async () => {
  const controller = subsystem();
  const confirmLaunch = async () => {
    const execution = controller.executions.get("execution")!;
    await expect(stat(join(statePath(execution), "request.json"))).resolves.toBeDefined();
    throw new Error("Fixture no longer eligible.");
  };
  await expect(controller.execute({ ...intent(), confirmLaunch })).rejects.toThrow(
    "no longer eligible",
  );
  expect(controller.executions.get("execution")).toMatchObject({
    status: "not_started",
    remote: { launchAuthorized: false },
  });
  expect(runs.size).toBe(0);
});

it("releases a claim after its controller is killed after staging and retries under a new ID", async () => {
  const killed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { cp } from "node:fs/promises";
    import { basename, join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import { createAgentController } from "./src/agent-controller.ts";
    import { createRexExecution } from "./src/rex-execution.ts";
    import { WorkflowStore } from "./src/store.ts";

    const executions = new WorkflowStore(process.argv[1]).agentExecutions();
    const remote = createRexExecution(executions, async (_, args) => {
      if (args[3] !== "cp") throw new Error("Expected staging only");
      const [source, destination] = args.slice(-2);
      await cp(source, join(destination.slice(1), basename(source)), { recursive: true });
      process.kill(process.pid, "SIGKILL");
      await delay(60_000);
    });
    await createAgentController(executions, undefined, remote).execute(JSON.parse(process.argv[2]));
  `,
      db,
      JSON.stringify(intent()),
    ],
    { encoding: "utf8", env: { ...process.env, TMPDIR: root }, timeout: 4000 },
  );
  expect(killed.signal, killed.stderr).toBe("SIGKILL");
  const staged = store.agentExecutions().get("execution")!;
  expect(staged).toMatchObject({ status: "running", remote: { launchAuthorized: false } });
  await expect(stat(join(statePath(staged), "request.json"))).resolves.toBeDefined();

  store.close();
  store = new WorkflowStore(db);
  const restarted = subsystem();
  expect(await restarted.recover()).toMatchObject([
    { execution: { status: "not_started", remote: { launchAuthorized: false } } },
  ]);
  expect(await restarted.recover()).toEqual([]);
  expect((await restarted.execute(intent())).execution.status).toBe("not_started");
  expect(transport).not.toHaveBeenCalled();
  const retried = await restarted.execute(intent("retry"));
  expect(retried.execution).toMatchObject({
    status: "completed",
    remote: { launchAuthorized: true },
  });
  expect(retried.execution.remote?.key).not.toBe(staged.remote?.key);
  expect(runs.size).toBe(1);
});

it("leaves live staging alone and prevents dispatch once prelaunch recovery wins", async () => {
  const controller = subsystem();
  const staged = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  pauseStage = async () => {
    staged.resolve();
    await resume.promise;
  };
  const dispatch = controller.execute(intent());
  try {
    await staged.promise;
    const observerStore = new WorkflowStore(db);
    try {
      const observer = subsystem(observerStore);
      expect((await observer.inspect("execution")).execution.status).toBe("running");
      expect(await observer.recover()).toMatchObject([{ execution: { status: "running" } }]);
      await expect(observer.execute(intent("retry"))).rejects.toThrow("already has");
      expect(transport.mock.calls).toHaveLength(1);

      const owner = vi.spyOn(process, "kill").mockImplementationOnce(() => {
        throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
      });
      try {
        expect(await observer.recover()).toMatchObject([{ execution: { status: "not_started" } }]);
      } finally {
        owner.mockRestore();
      }
    } finally {
      observerStore.close();
    }
  } finally {
    resume.resolve();
    await dispatch;
  }
  expect((await dispatch).execution.status).toBe("not_started");
  expect(runs.size).toBe(0);
});

it("preserves launch authorization when recovery read staging state first", async () => {
  const dispatcher = subsystem();
  const { execution } = dispatcher.executions.claim(intent());
  const observerStore = new WorkflowStore(db);
  try {
    const observer = subsystem(observerStore);
    const probe = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      expect(dispatcher.executions.authorizeRemoteDispatch(execution.id)).toBe(true);
      throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
    });
    try {
      expect(await observer.recover()).toMatchObject([
        { execution: { status: "unknown", remote: { launchAuthorized: true } } },
      ]);
    } finally {
      probe.mockRestore();
    }
    expect(dispatcher.executions.authorizeRemoteDispatch(execution.id)).toBe(false);
    await expect(observer.execute(intent("retry"))).rejects.toThrow("already has");
    expect(runs.size).toBe(0);
  } finally {
    observerStore.close();
  }
});

it.each([20, 21])("rejects pre-Phase D database schema %s without upgrading it", (version) => {
  const database = join(root, "pre-phase-d.sqlite");
  new WorkflowStore(database).close();
  {
    using old = new DatabaseSync(database);
    old.exec(`PRAGMA user_version = ${version}`);
  }
  expect(() => new WorkflowStore(database)).toThrow("Unsupported Switchyard database");
  using old = new DatabaseSync(database, { readOnly: true });
  expect(old.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
});

it("reconciles a lost launch acknowledgement after restart without replay and retrieves the same result", async () => {
  loseAck = true;
  const first = subsystem();
  const launched = await first.execute(intent("execution", "wait for release"));
  expect(launched.execution).toMatchObject({
    status: "unknown",
    remote: { launchAuthorized: true, blockId: null },
  });
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

it("accepts correlated final evidence over a wrong acknowledgement after restart and session removal", async () => {
  acknowledgementBlock = "block:" + randomUUID();
  hideEvidence = true;
  const launched = await subsystem().execute(intent("execution", "wait for release"));
  expect(launched.execution).toMatchObject({
    status: "unknown",
    remote: { acknowledgedBlockId: acknowledgementBlock, blockId: null },
  });
  await waiting("execution");
  const [blockId] = runs.keys();
  await writeFile(join(statePath(launched.execution), "release"), "");
  await runs.get(blockId!)!.exited;
  hideEvidence = false;
  sessionLost = true;
  store.close();
  store = new WorkflowStore(db);

  const restarted = subsystem();
  const result = await restarted.inspect("execution");
  expect(result).toMatchObject({
    execution: {
      status: "completed",
      remote: {
        acknowledgedBlockId: acknowledgementBlock,
        blockId,
        blockConflict: expect.stringContaining("acknowledgement conflicts"),
        resultDigest: expect.any(String),
      },
    },
    observation: { process: { state: "unavailable" }, evidence: "valid" },
    result: { outcome: "completed", response: "fixture done" },
  });
  expect(await restarted.inspect("execution")).toEqual(result);
  expect(runs.size).toBe(1);
});

it("retains a late conflicting acknowledgement without changing concurrently accepted final evidence", async () => {
  acknowledgementBlock = "block:" + randomUUID();
  const launched = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  pauseAck = async () => {
    launched.resolve();
    await acknowledge.promise;
  };
  const dispatch = subsystem().execute(intent());
  let final;
  try {
    await launched.promise;
    const [blockId] = runs.keys();
    await runs.get(blockId!)!.exited;
    const observerStore = new WorkflowStore(db);
    try {
      final = await subsystem(observerStore).inspect("execution");
      expect(final.execution).toMatchObject({
        status: "completed",
        remote: { blockId, acknowledgedBlockId: null, resultDigest: expect.any(String) },
      });
    } finally {
      observerStore.close();
    }
  } finally {
    acknowledge.resolve();
    await dispatch;
  }
  expect(await dispatch).toEqual({
    ...final,
    execution: {
      ...final!.execution,
      remote: {
        ...final!.execution.remote,
        acknowledgedBlockId: acknowledgementBlock,
        blockConflict: expect.stringContaining("acknowledgement conflicts"),
      },
    },
  });
  expect(runs.size).toBe(1);
});

it("requires executor evidence to cancel even when an acknowledgement points to a matching running block", async () => {
  const controller = subsystem();
  const abort = new AbortController();
  hideEvidence = true;
  const dispatch = controller.execute({
    ...intent("execution", "wait for release"),
    signal: abort.signal,
  });
  try {
    const held = await waiting("execution");
    const [blockId] = runs.keys();
    expect(held.remote).toMatchObject({ acknowledgedBlockId: blockId, blockId: null });
    expect((await controller.cancel(held.id)).interruption).toBe("unavailable");
    expect(targetBlock).toBeUndefined();
  } finally {
    abort.abort();
    await dispatch;
  }
  expect(await dispatch).toMatchObject({ interruption: "unavailable" });
  expect(targetBlock).toBeUndefined();
  hideEvidence = false;
  expect((await controller.cancel("execution")).interruption).toBe("requested");
  expect(targetBlock).toBe([...runs.keys()][0]);
});

it("rejects a final file that conflicts with a previously correlated executor block", async () => {
  const controller = subsystem();
  loseAck = true;
  const { execution } = await controller.execute(intent("execution", "wait for release"));
  await waiting(execution.id);
  hideEvidence = false;
  const [blockId] = runs.keys();
  expect((await controller.inspect(execution.id)).execution.remote?.blockId).toBe(blockId);
  const path = join(statePath(execution), "evidence.json");
  const interim = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify({
      ...interim,
      blockId: "block:" + randomUUID(),
      result: { outcome: "completed", response: "conflicting block" },
    }),
  );
  expect(await controller.inspect(execution.id)).toMatchObject({
    execution: { status: "unknown", remote: { blockId, resultDigest: null } },
    observation: { evidence: "conflicting" },
  });
  await writeFile(join(statePath(execution), "release"), "");
  await runs.get(blockId!)!.exited;
  expect((await controller.inspect(execution.id)).execution.status).toBe("completed");
});

it("rechecks the final result before sending cancellation after a concurrent inspection", async () => {
  const controller = subsystem();
  loseAck = true;
  const { execution } = await controller.execute(intent("execution", "wait for release"));
  await waiting(execution.id);
  hideEvidence = false;
  const checking = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  pauseBlockInspect = async () => {
    checking.resolve();
    await resume.promise;
  };
  const cancel = controller.cancel(execution.id);
  try {
    await checking.promise;
    await writeFile(join(statePath(execution), "release"), "");
    await [...runs.values()][0]!.exited;
    expect((await controller.inspect(execution.id)).execution.status).toBe("completed");
  } finally {
    resume.resolve();
    await cancel;
  }
  expect(await cancel).toMatchObject({
    interruption: "unavailable",
    execution: { status: "completed" },
  });
  expect(targetBlock).toBeUndefined();
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
  expect(targetBlock).toBe(held.remote!.acknowledgedBlockId);
  await runs.get(targetBlock!)!.exited;
  expect((await controller.inspect(held.id)).execution.status).toBe("unknown");
});

it("interrupts a verified block when controller scratch storage is unavailable", async () => {
  const controller = subsystem();
  loseAck = true;
  const launched = await controller.execute(intent("execution", "wait for release"));
  await waiting("execution");
  loseAck = hideEvidence = false;
  const inspected = await controller.inspect(launched.execution.id);
  expect(inspected.observation.process.state).toBe("running");
  vi.stubEnv("TMPDIR", join(root, "missing-temp-dir"));
  try {
    expect(await controller.cancel(launched.execution.id)).toMatchObject({
      interruption: "requested",
      observation: { evidence: "unavailable" },
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(targetBlock).toBe(inspected.execution.remote?.blockId);
  await runs.get(targetBlock!)!.exited;
  expect((await controller.inspect(launched.execution.id)).execution.status).toBe("unknown");
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

it("permits retry after an affirmative local launch failure", async () => {
  const controller = subsystem();
  launchError = Object.assign(new Error("fixture executable missing"), {
    code: "ENOENT",
    syscall: "spawn " + rex.executable,
  });
  expect((await controller.execute(intent())).execution).toMatchObject({
    status: "not_started",
    reason: "Could not launch the local Rex client.",
  });
  expect(runs.size).toBe(0);
  launchError = undefined;
  expect((await controller.execute(intent("retry"))).execution.status).toBe("completed");
});

it.each([
  ["dispatch", "available", "completed"],
  ["dispatch", "unavailable", "completed"],
  ["inspect", "available", "completed"],
  ["inspect", "available", "failed"],
])(
  "%s rechecks the %s final file after concurrent recovery records %s",
  async (operation, availability, outcome) => {
    const controller = subsystem();
    const prompt = outcome === "failed" ? "wait then fail" : "wait for release";
    const evidence = {
      execution: { status: outcome },
      observation: { evidence: "valid" },
      ...(outcome === "completed" ? { result: { structuredOutput: { ok: true } } } : {}),
    };
    if (operation === "inspect") {
      loseAck = true;
      await controller.execute(intent("execution", prompt));
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
        : controller.execute(intent("execution", prompt));
    const checked = observing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await copied.promise;
      const held = await waiting("execution");
      await writeFile(join(statePath(held), "release"), "");
      await [...runs.values()][0]!.exited;
      expect(await controller.inspect(held.id)).toMatchObject(evidence);
      hideEvidence = availability === "unavailable";
    } finally {
      resume.resolve();
    }
    if (availability === "available") {
      expect(await checked).toMatchObject({ value: evidence });
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
