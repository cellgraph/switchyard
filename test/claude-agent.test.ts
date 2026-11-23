import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAgentWorker, localCodexWorker } from "../src/agent-command.ts";
import { parseAgentConfig } from "../src/agent-config.ts";
import { createAgentController } from "../src/agent-controller.ts";
import { claudeEditRules, createClaudeAgent } from "../src/claude-agent.ts";
import {
  claudeExecutableIdentity,
  claudeSessionCheckpoint,
  claudeTranscript,
  claudeVersion,
} from "../src/claude-runtime.ts";
import { parseFixConfig } from "../src/config.ts";
import { WorkflowStore } from "../src/store.ts";
import { agentRepository, git } from "./fixtures/agent-repository.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync(path: string, options?: Parameters<typeof fs.lstatSync>[1]) {
      // Use an unmanaged host fixture even when the developer's machine has MDM policy.
      if (
        /^\/(?:etc\/claude-code|Library\/(?:Application Support\/ClaudeCode|Managed Preferences))\//.test(
          path,
        )
      )
        return undefined;
      return fs.lstatSync(path, options);
    },
  };
});

const secret = "fake-anthropic-secret";
function fakeCli(root: string) {
  const executable = join(root, "claude");
  writeFileSync(
    executable,
    `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === "--version") {
  console.log(${JSON.stringify(claudeVersion + " (Claude Code)")});
  process.exit(0);
}
const home = process.env.CLAUDE_CONFIG_DIR;
const resume = args.includes("--resume");
const id = resume ? basename(option("--resume"), ".jsonl") : option("--session-id");
const cwd = process.cwd();
const transcript = join(home, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), id + ".jsonl");
let prompt = "";
process.stdin.setEncoding("utf8").on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  appendFileSync(join(home, "launches"), JSON.stringify({ args, cwd, keys: Object.keys(process.env), prompt }) + "\\n");
  const emit = (event) => console.log(JSON.stringify({ session_id: id, ...event }));
  if (prompt === "bad stream") return console.log("raw sensitive stderr " + process.env.SWITCHYARD_CLAUDE_API_KEY);
  emit({
    type: "system", subtype: "init", permissionMode: "dontAsk",
    model: "claude-resolved-test", tools: prompt === "unsafe" ? ["Bash"] : ["Read", "Edit"],
    mcp_servers: [], cwd, additional_directories: [], apiKeySource: "apiKeyHelper", claude_code_version: ${JSON.stringify(claudeVersion)},
  });
  if (prompt === "unsafe") return;
  if (prompt === "wait") {
    process.on("SIGTERM", () => {});
    return setInterval(() => {}, 1000);
  }
  if (prompt === "wait with child") {
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e",
      'process.on("SIGTERM", () => {});' +
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, group: process.ppid }));' +
      'setInterval(() => {}, 1000);',
      join(home, "ready-child"),
    ], { stdio: "ignore" });
    child.unref();
    return setInterval(() => {}, 1000);
  }
  if (prompt === "signal") return process.kill(process.pid, "SIGKILL");
  if (prompt === "trailing crash") process.exitCode = 2;
  if (prompt === "no result") return;
  if (prompt === "auth failure") {
    console.error("invalid x-api-key: " + process.env.SWITCHYARD_CLAUDE_API_KEY);
    emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["sensitive diagnostic"] });
    process.exitCode = 1;
    return;
  }
  mkdirSync(dirname(transcript), { recursive: true });
  appendFileSync(transcript, JSON.stringify({ type: "user", sessionId: id, cwd, prompt }) + "\\n");
  if (prompt.startsWith("edit")) writeFileSync(join(cwd, "tracked.txt"), prompt);
  emit({
    type: "result", subtype: "success", is_error: false,
    ...(prompt === "wrong session" ? { session_id: "different" } : {}),
    permission_denials: prompt === "denied" ? [{ input: "sensitive tool input" }] : [],
    result: "result with " + process.env.SWITCHYARD_CLAUDE_API_KEY,
    ...(prompt === "missing structured" ? {} : { structured_output: { value: process.env.SWITCHYARD_CLAUDE_API_KEY } }),
    usage: { input_tokens: resume ? 50 : 10, output_tokens: resume ? 19 : 2 },
    ...(prompt === "missing invocation usage" ? {} : {
      model_usage_since_last_result: {
        "claude-resolved-test": { inputTokens: 7, outputTokens: 1, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
        "claude-other-model": { inputTokens: 3, outputTokens: 1 },
      }
    }),
    total_cost_usd: resume ? 0.09 : 0.04,
  });
});
`,
    { mode: 0o700 },
  );
  return executable;
}

describe("Claude Code local provider", () => {
  let root: string;
  let home: string;
  let workingDirectory: string;
  let executable: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-claude-")));
    home = join(root, "profile");
    workingDirectory = join(root, "checkout");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(workingDirectory);
    executable = fakeCli(root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function session(timeoutMs = 4_000) {
    return createClaudeAgent(
      {
        executable,
        executableIdentity: claudeExecutableIdentity(executable),
        home,
        model: "configured-model",
        timeoutMs,
        maxBudgetUsd: 0.25,
        allowedPaths: ["tracked.txt", "src/"],
      },
      secret,
    ).startSession({ workingDirectory });
  }

  function launches() {
    return readFileSync(join(home, "launches"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("validates provider settings and preserves the legacy Codex selection and configuration ID", () => {
    const repo = { repositoryDirectory: workingDirectory, worktreeRoot: root };
    const codex = { model: "legacy-model", codexHome: home };
    const legacy = parseAgentConfig(codex);
    expect(legacy).toEqual(codex);
    expect(parseAgentConfig({ ...codex, provider: "codex" })).toEqual(legacy);
    expect(localAgentWorker({ ...repo, ...legacy }).configurationId).toBe(
      localCodexWorker({ ...repo, ...codex }).configurationId,
    );
    expect(() => parseAgentConfig({ ...codex, provider: "unknown" })).toThrow("Unsupported");
    const config = {
      provider: "claude-code",
      model: "configured-model",
      claude: { executable, home },
    };
    expect(parseAgentConfig(config)).toMatchObject({ claude: { timeoutMs: 900_000 } });
    expect(() => parseAgentConfig({ ...config, codexHome: home })).toThrow("mixed");
    expect(() => parseAgentConfig({ ...config, model: "--settings" })).toThrow("model");
    expect(() => parseAgentConfig({ ...config, claude: { executable: "claude", home } })).toThrow(
      "absolute",
    );
    expect(() =>
      parseAgentConfig({ ...config, claude: { executable, home, timeoutMs: 0 } }),
    ).toThrow("timeoutMs");
    expect(() =>
      parseAgentConfig({ ...config, claude: { executable, home, maxBudgetUsd: Infinity } }),
    ).toThrow("maxBudgetUsd");
    const fix = {
      ...config,
      ...repo,
      localBranch: "fix/test",
      requiredChecks: ["CI"],
      validation: [{ id: "test", argv: ["true"] }],
    };
    expect(parseFixConfig({ ...fix, allowedPaths: ["src/"] }).provider).toBe("claude-code");
    expect(() => parseFixConfig({ ...fix, allowedPaths: ["*.txt"] })).toThrow("literal");
  });

  it("preserves recursive permission when an exact scope overlaps it", () => {
    const rules = claudeEditRules(["src", "src/", "src/component.ts", "outside.txt"]);
    expect(rules.allow).toEqual([
      "Edit(/src)",
      "Edit(/src/**)",
      "Edit(/src/component.ts)",
      "Edit(/outside.txt)",
    ]);
    expect(rules.deny).toContain("Edit(/outside.txt/**)");
    expect(rules.deny).not.toContain("Edit(/src/**)");
    expect(rules.deny).not.toContain("Edit(/src/component.ts/**)");
    expect(() => claudeEditRules(["src", "src/file.ts"])).toThrow("ancestor");
  });

  it("launches headlessly with an allowlisted environment and returns sanitized structured evidence", async () => {
    vi.stubEnv("GITHUB_TOKEN", "unrelated-secret");
    const current = session();
    const onEvent = vi.fn();
    const schema = { type: "object" };
    const result = await current.runTurn({
      prompt: "--a prompt, never an argument",
      outputSchema: schema,
      onEvent,
    });
    expect(result).toEqual({
      outcome: "completed",
      response: "result with [redacted]",
      structuredOutput: { value: "[redacted]" },
      usage: {
        inputTokens: 17,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
      model: "claude-resolved-test",
      sessionCostUsd: 0.04,
    });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({
      provider: "claude-code",
      kind: "session_started",
      data: null,
    });
    const [{ args, keys, prompt, cwd }] = launches();
    expect(args).toEqual(
      expect.arrayContaining([
        "--restricted",
        "--bare",
        "--safe-mode",
        "--strict-mcp-config",
        "--no-chrome",
        "--disable-slash-commands",
        "--print",
        "stream-json",
        "dontAsk",
        "--permission-prompts",
        "none",
        "Read,Glob,Grep,Edit,Write",
        "Edit(/tracked.txt),Edit(/src/**)",
        "configured-model",
        "0.25",
        JSON.stringify(schema),
        "--session-id",
        current.reference?.id,
      ]),
    );
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(keys).toContain("SWITCHYARD_CLAUDE_API_KEY");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toMatchObject({
      apiKeyHelper: "/usr/bin/printenv SWITCHYARD_CLAUDE_API_KEY",
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
      permissions: { deny: ["Edit(.git)", "Read(.git)", "Edit(.claude)", "Edit(/tracked.txt/**)"] },
    });
    expect(keys).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(args)).not.toContain(secret);
    expect(args).not.toContain(prompt);
    expect(cwd).toBe(workingDirectory);
  });

  it.each([
    ["bad stream", "unknown", "invalid session, policy, or stream"],
    ["unsafe", "unknown", "invalid session, policy, or stream"],
    ["wrong session", "unknown", "invalid session, policy, or stream"],
    ["no result", "unknown", "without verified completion"],
    ["trailing crash", "unknown", "without verified completion"],
    ["auth failure", "failed", "could not authenticate"],
    ["denied", "failed", "denied tool calls"],
    ["missing structured", "failed", "omitted the requested structured output"],
    ["signal", "interrupted", "was terminated"],
  ])("holds %s without exposing raw diagnostics", async (prompt, outcome, reason) => {
    const result = await session().runTurn({ prompt, outputSchema: {} });
    expect(result).toMatchObject({ outcome, reason: expect.stringContaining(reason) });
    expect(JSON.stringify(result)).not.toMatch(/sensitive|fake-anthropic-secret/);
  });

  it("does not use cumulative token counts when invocation usage is unavailable", async () => {
    const result = await session().runTurn({ prompt: "missing invocation usage" });
    expect(result).toMatchObject({ outcome: "completed", sessionCostUsd: 0.04 });
    expect(result).not.toHaveProperty("usage");
  });

  it("bounds timeouts and cancellation, keeping an observed session reference", async () => {
    const timeout = session(1_000);
    expect(await timeout.runTurn({ prompt: "wait" })).toMatchObject({
      outcome: "interrupted",
      reason: expect.stringContaining("timed out"),
    });
    expect(timeout.reference?.provider).toBe("claude-code");
    const abort = new AbortController();
    const canceled = await session().runTurn({
      prompt: "wait",
      signal: abort.signal,
      onEvent: () => abort.abort(),
    });
    expect(canceled).toMatchObject({
      outcome: "interrupted",
      reason: expect.stringContaining("canceled"),
    });
    await session().runTurn({ prompt: "never launched", signal: abort.signal });
    expect(launches()).toHaveLength(2);
  });

  it("keeps the operation claim until cancellation reaches a child with independent stdio", async () => {
    const fixture = agentRepository();
    const store = new WorkflowStore(fixture.db);
    const abort = new AbortController();
    let child: { pid: number; group: number } | undefined;
    let childExited = false;
    const claimAtForce: (string | undefined)[] = [];
    const kill = process.kill;
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (child && pid === -child.group && sig === "SIGKILL")
        claimAtForce.push(store.agentOperations().get(fixture.request.operationId)?.status);
      return kill(pid, sig);
    });
    try {
      store.createWorkflow(fixture.workflow);
      vi.stubEnv("ANTHROPIC_API_KEY", secret);
      const worker = localAgentWorker({
        provider: "claude-code",
        model: "configured-model",
        repositoryDirectory: fixture.repo,
        worktreeRoot: fixture.worktrees,
        claude: { executable, home, timeoutMs: 4_000 },
      });
      const turn = createAgentController(store, worker).runTurn(
        { ...fixture.request, prompt: "wait with child" },
        abort.signal,
      );
      try {
        const started = await vi.waitFor(
          () =>
            JSON.parse(readFileSync(join(home, "ready-child"), "utf8")) as NonNullable<
              typeof child
            >,
          { timeout: 2_000 },
        );
        child = started;
        expect(store.agentOperations().get(fixture.request.operationId)?.status).toBe("running");
        abort.abort();
        expect(await turn).toMatchObject({ status: "interrupted" });
        expect(claimAtForce).toEqual(["running"]);
        await vi.waitFor(() => {
          const ps = spawnSync("ps", ["-o", "stat=", "-p", String(started.pid)], {
            encoding: "utf8",
          });
          if (ps.error) throw ps.error;
          // An orphan can stay in the process table as a zombie until its adopter reaps it.
          expect(ps.stdout.trim()).toMatch(/^(?:Z|$)/);
        });
        childExited = true;
        expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
      } finally {
        abort.abort();
        await turn;
      }
    } finally {
      signal.mockRestore();
      store.close();
      rmSync(fixture.root, { recursive: true, force: true });
      if (child && !childExited) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch (error) {
          expect(error).toMatchObject({ code: "ESRCH" });
        }
      }
    }
  }, 10_000);

  it.each(["symbolic", "hard"])(
    "rejects a worktree containing a %s link before launch",
    async (link) => {
      const target = join(root, "outside");
      writeFileSync(target, "untouched");
      (link === "symbolic" ? symlinkSync : linkSync)(target, join(workingDirectory, "alias"));
      expect(await session().runTurn({ prompt: "edit" })).toMatchObject({
        outcome: "failed",
        reason: expect.stringContaining("without links"),
      });
      expect(readFileSync(target, "utf8")).toBe("untouched");
    },
  );

  it("checks runtime availability and credentials before dispatch", () => {
    const config = parseAgentConfig({
      provider: "claude-code",
      model: "model",
      claude: { executable, home },
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const repo = { repositoryDirectory: workingDirectory, worktreeRoot: root };
    expect(() => localAgentWorker({ ...repo, ...config }).runtime()).toThrow("ANTHROPIC_API_KEY");
    vi.stubEnv("ANTHROPIC_API_KEY", secret);
    writeFileSync(join(home, "remote-settings.json"), "{}");
    expect(() => localAgentWorker({ ...repo, ...config }).runtime()).toThrow("managed settings");
    rmSync(join(home, "remote-settings.json"));
    rmSync(executable);
    expect(() => localAgentWorker({ ...repo, ...config }).runtime()).toThrow(
      "unavailable or incompatible",
    );
  });

  it("records an actionable checkout preflight failure without launching the CLI", async () => {
    const fixture = agentRepository();
    const store = new WorkflowStore(fixture.db);
    try {
      symlinkSync("tracked.txt", join(fixture.repo, "alias"));
      git(fixture.repo, "add", "alias");
      git(
        fixture.repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Add a symlink",
      );
      const head = git(fixture.repo, "rev-parse", "HEAD");
      store.createWorkflow({ ...fixture.workflow, headSha: head });
      vi.stubEnv("ANTHROPIC_API_KEY", secret);
      const worker = localAgentWorker({
        provider: "claude-code",
        model: "configured-model",
        repositoryDirectory: fixture.repo,
        worktreeRoot: fixture.worktrees,
        claude: { executable, home, timeoutMs: 4_000 },
      });
      const result = await createAgentController(store, worker).runTurn({
        ...fixture.request,
        expectedHead: head,
        expectedPullRequestHead: head,
      });
      expect(result).toMatchObject({
        status: "completed",
        error: expect.stringContaining("requires a worktree without links"),
        evidence: { agent: { outcome: "failed" } },
      });
      expect(store.agentOperations().session(fixture.workflow.id)?.status).toBe("held");
      expect(() => launches()).toThrow();
    } finally {
      store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["resume", "modified transcript", "interrupted", "changed provider"])(
    "uses durable operation and worktree evidence for %s",
    async (scenario) => {
      const fixture = agentRepository();
      const config = {
        provider: "claude-code",
        model: "configured-model",
        claude: { executable, home },
        repositoryDirectory: fixture.repo,
        worktreeRoot: fixture.worktrees,
      };
      const worker = () =>
        localAgentWorker({
          ...parseAgentConfig(config),
          repositoryDirectory: fixture.repo,
          worktreeRoot: fixture.worktrees,
        });
      vi.stubEnv("ANTHROPIC_API_KEY", secret);
      let store = new WorkflowStore(fixture.db);
      try {
        store.createWorkflow(fixture.workflow);
        const first = await createAgentController(store, worker()).runTurn({
          ...fixture.request,
          prompt: scenario === "interrupted" ? "signal" : "edit first",
        });
        const binding = store.agentOperations().session(fixture.workflow.id)!;
        expect(first.evidence?.runtime).toMatchObject({
          provider: "claude-code",
          model: "configured-model",
        });
        expect(binding.reference?.agent.provider).toBe("claude-code");
        expect(JSON.stringify(first)).not.toMatch(/result with|fake-anthropic-secret|edit first/);
        const second = { ...fixture.request, operationId: "follow-up", prompt: "edit second" };
        store.close();
        store = new WorkflowStore(fixture.db);
        expect(store.recover().ambiguousOperations).toBe(0);
        if (scenario === "interrupted") {
          expect(first.status).toBe("interrupted");
          expect(binding.status).toBe("held");
          expect(
            await createAgentController(store, worker()).runTurn({
              ...fixture.request,
              prompt: "signal",
            }),
          ).toMatchObject({ status: "interrupted" });
          await expect(createAgentController(store, worker()).runTurn(second)).rejects.toThrow();
          expect(launches()).toHaveLength(1);
          return;
        }
        expect(first).toMatchObject({
          status: "completed",
          error: null,
          evidence: { sessionCostUsd: 0.04 },
        });
        const { agent, worktree } = binding.reference!;
        const transcript = claudeTranscript(home, agent.id, worktree.path);
        if (scenario === "modified transcript") appendFileSync(transcript, "{}\n");
        const nextWorker =
          scenario === "changed provider"
            ? { ...worker(), runtime: () => ({ ...binding.runtime!, provider: "codex" }) }
            : worker();
        const next = await createAgentController(store, nextWorker).runTurn(second);
        if (scenario === "resume") {
          expect(next).toMatchObject({
            status: "completed",
            error: null,
            evidence: { usage: { inputTokens: 17, outputTokens: 2 }, sessionCostUsd: 0.09 },
          });
          expect(next.evidence?.reference).toEqual(binding.reference);
          expect(launches()[1].args).toEqual(expect.arrayContaining(["--resume", transcript]));
          expect(claudeSessionCheckpoint(home, agent.id, worktree.path).digest).not.toBe(
            binding.checkpoint?.session.digest,
          );
          expect(readFileSync(join(worktree.path, "tracked.txt"), "utf8")).toBe("edit second");
          expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("original\n");
        } else {
          expect(next.status).toBe("manual_reconciliation");
          expect(launches()).toHaveLength(1);
        }
      } finally {
        store.close();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
