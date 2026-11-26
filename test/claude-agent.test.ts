import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClaudeAgent } from "../src/claude-agent.ts";

const nativeId = "8a622bc1-5ccf-4eec-b7f0-51059b04db34";
const fixture = `
  const fs = require("node:fs");
  const prompt = fs.readFileSync(0, "utf8").trim();
  const args = process.argv.slice(2);
  const valueOf = (flag) => args[args.indexOf(flag) + 1];
  const id = args.includes("--resume") ? valueOf("--resume") : ${JSON.stringify(nativeId)};
  const emit = (message) => console.log(JSON.stringify(message));
  if (prompt === "auth stderr") {
    console.error("Not logged in: secret diagnostics");
    process.exitCode = 1;
  } else {
    emit({ type: "system", subtype: "init", session_id: id, tools: ["Bash"], permissionMode: "default" });
    const end = { type: "result", subtype: "success", is_error: false, session_id: id, result: "done" };
    if (prompt === "hold") {
      setInterval(() => {}, 1000);
    } else if (prompt === "partial") {
      emit({ type: "assistant", session_id: id });
    } else if (prompt === "incomplete") {
      emit({ ...end, result: undefined });
    } else if (prompt === "failure" || prompt === "auth result") {
      emit({ ...end, subtype: "error_during_execution", is_error: true, errors: [prompt === "failure" ? "secret diagnostics" : "Not logged in: secret diagnostics"] });
      process.exitCode = 1;
    } else if (prompt === "different session") {
      emit({ ...end, session_id: "wrong-id" });
    } else if (prompt === "interrupt CLI") {
      process.kill(process.ppid, "SIGKILL");
    } else {
      emit({
        ...end,
        result: JSON.stringify({ args, prompt, cwd: process.cwd(), profile: process.env.CLAUDE_CONFIG_DIR, inherited: process.env.NATIVE_FIXTURE }),
        ...(args.includes("--json-schema") && prompt !== "no schema result" ? { structured_output: { ok: true } } : {}),
      });
    }
  }
`;

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "switchyard-claude-"));
  writeFileSync(join(directory, "claude"), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  vi.stubEnv("PATH", [directory, process.env.PATH].join(delimiter));
  vi.stubEnv("NATIVE_FIXTURE", "configured");
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function adapter() {
  return createClaudeAgent({ provider: "claude-code", workingDirectory: directory });
}

function cli(...args: string[]) {
  const env = { ...process.env, SWITCHYARD_DB_PATH: join(directory, "local.sqlite") };
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  return spawnSync(process.execPath, [main, "agent", ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
}

it("starts through the native CLI with inherited configuration and schema passthrough", async () => {
  const local = createClaudeAgent({
    provider: "claude-code",
    workingDirectory: directory,
    model: "sonnet",
    configDirectory: "/native/profile",
  });
  const onSession = vi.fn();
  const outputSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const result = await local.start({ prompt: "from stdin", outputSchema, onSession });
  expect(result).toMatchObject({ outcome: "completed", structuredOutput: { ok: true } });
  expect(onSession).toHaveBeenCalledExactlyOnceWith(nativeId);
  expect(result.outcome === "completed" && JSON.parse(result.response)).toEqual({
    args: [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--json-schema",
      JSON.stringify(outputSchema),
    ],
    prompt: "from stdin",
    cwd: expect.stringMatching(/switchyard-claude-/),
    profile: "/native/profile",
    inherited: "configured",
  });
});

it("resumes directly by native ID and rejects a mismatched terminal session", async () => {
  const onSession = vi.fn();
  const local = adapter();
  const result = await local.resume(nativeId, { prompt: "continue", onSession });
  expect(result.outcome).toBe("completed");
  expect(result.outcome === "completed" && JSON.parse(result.response)).toMatchObject({
    args: ["--print", "--output-format", "stream-json", "--verbose", "--resume", nativeId],
    prompt: "continue",
  });
  expect(onSession).toHaveBeenCalledExactlyOnceWith(nativeId);
  expect((await local.resume(nativeId, { prompt: "different session", onSession })).outcome).toBe(
    "unknown",
  );
});

it("reports launch, native execution and authentication failures without raw diagnostics", async () => {
  const local = adapter();
  const onSession = vi.fn();
  expect(await local.start({ prompt: "failure", onSession })).toEqual({
    outcome: "failed",
    reason: "Claude Code reported a turn failure.",
  });
  expect(await local.start({ prompt: "auth result", onSession })).toEqual({
    outcome: "failed",
    reason: "Claude Code could not authenticate.",
  });
  expect(await local.start({ prompt: "auth stderr", onSession })).toEqual({
    outcome: "unknown",
    reason: "Claude Code reported an authentication error without a confirmed terminal result.",
  });
  vi.stubEnv("PATH", directory + "/missing");
  expect(await local.start({ prompt: "run", onSession })).toEqual({
    outcome: "not_started",
    reason: "Could not launch the Claude Code CLI.",
  });
});

it("distinguishes a zero exit with no terminal result from a terminal result with no response", async () => {
  const local = adapter();
  const onSession = vi.fn();
  expect((await local.start({ prompt: "partial", onSession })).outcome).toBe("unknown");
  expect(await local.start({ prompt: "incomplete", onSession })).toEqual({
    outcome: "failed",
    reason: "Claude Code omitted the required response.",
  });
});

it("requests native cancellation and keeps a missing outcome uncertain", async () => {
  const abort = new AbortController();
  const local = adapter();
  const turn = { prompt: "hold", signal: abort.signal, onSession: () => abort.abort() };
  expect(await local.start(turn)).toEqual({
    outcome: "unknown",
    reason: "Cancellation was requested without a complete Claude Code result.",
  });
  expect((await local.start(turn)).outcome).toBe("not_started");
});

it("runs, inspects, and continues local assignments across CLI processes without a PR", () => {
  const prompt = join(directory, "prompt");
  writeFileSync(prompt, "start");
  const first = cli(
    "run",
    "--provider",
    "claude-code",
    "--cwd",
    directory,
    "--prompt",
    prompt,
    "--execution",
    "first",
  );
  expect(first.status, first.stderr).toBe(0);
  expect(first.stderr).toBe('Execution ID: "first"\n');
  const started = JSON.parse(first.stdout);
  expect(started).toMatchObject({
    execution: { id: "first", assignmentId: "first", status: "completed" },
    session: { nativeId, placement: "local" },
    result: { outcome: "completed" },
  });
  const saved = cli("status", "first");
  expect(saved.status, saved.stderr).toBe(0);
  expect(JSON.parse(saved.stdout)).toEqual({
    execution: started.execution,
    session: started.session,
  });
  expect(JSON.parse(cli("recover").stdout)).toEqual({ unknownExecutions: 0 });

  writeFileSync(prompt, "continue");
  const second = cli("run", "--session", started.session.id, "--prompt", prompt);
  expect(second.status, second.stderr).toBe(0);
  const continued = JSON.parse(second.stdout);
  expect(second.stderr).toBe(`Execution ID: ${JSON.stringify(continued.execution.id)}\n`);
  expect(continued).toMatchObject({
    execution: { sessionId: started.session.id, status: "completed" },
    session: started.session,
  });
  writeFileSync(prompt, "partial");
  const uncertain = cli("run", "--session", started.session.id, "--prompt", prompt);
  expect(uncertain.status, uncertain.stderr).toBe(1);
  expect(JSON.parse(uncertain.stdout)).toMatchObject({
    execution: { sessionId: started.session.id, status: "unknown" },
    session: started.session,
  });
});

it("fails a confirmed turn with no structured output, blocks replay and permits continuation", () => {
  const prompt = join(directory, "prompt");
  const schema = join(directory, "schema.json");
  writeFileSync(prompt, "no schema result");
  writeFileSync(schema, '{"type":"object"}');
  const start = [
    "run",
    "--provider",
    "claude-code",
    "--cwd",
    directory,
    "--prompt",
    prompt,
    "--schema",
    schema,
  ];
  const result = cli(...start, "--execution", "first");
  expect(result.status).toBe(1);
  const recorded = JSON.parse(result.stdout);
  expect(recorded).toMatchObject({
    execution: { status: "failed", reason: "Claude Code omitted the required structured output." },
    session: { nativeId },
  });
  expect(recorded).not.toHaveProperty("result");
  expect(JSON.parse(cli("status", "first").stdout)).toEqual(recorded);
  const replay = cli(...start, "--execution", "retry", "--assignment", "first");
  expect(replay.status).toBe(1);
  expect(replay.stderr).toContain("Assignment already has a dispatched or unresolved attempt.");

  writeFileSync(prompt, "continue");
  const continued = cli("run", "--session", recorded.session.id, "--prompt", prompt);
  expect(continued.status, continued.stderr).toBe(0);
  expect(JSON.parse(continued.stdout)).toMatchObject({
    execution: { status: "completed" },
    session: recorded.session,
  });
});

it("reports a generated ID on stderr before dispatch even if the invocation is interrupted", () => {
  const prompt = join(directory, "prompt");
  writeFileSync(prompt, "interrupt CLI");
  const interrupted = cli(
    "run",
    "--provider",
    "claude-code",
    "--cwd",
    directory,
    "--prompt",
    prompt,
  );
  expect(interrupted.signal).toBe("SIGKILL");
  expect(interrupted.stdout).toBe("");
  const match = /^Execution ID: "([a-f0-9-]{36})"\n$/.exec(interrupted.stderr);
  expect(match).not.toBeNull();
  expect(JSON.parse(cli("recover").stdout)).toEqual({ unknownExecutions: 1 });
  expect(JSON.parse(cli("status", match![1]!).stdout)).toMatchObject({
    execution: { id: match![1], status: "unknown" },
  });
});
