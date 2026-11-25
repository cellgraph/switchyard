# Claude Code execution

Switchyard can use Claude Code for an explicit `--agent-turn` request or as the implementation provider in a per-PR `fix` or `fixes` entry. Add these settings alongside the existing checkout and workflow settings. Supply a model ID or alias available to your Anthropic API account.

```json
{
  "provider": "claude-code",
  "model": "MODEL_AVAILABLE_TO_YOUR_ACCOUNT",
  "claude": {
    "executable": "/absolute/path/to/claude",
    "home": "/absolute/path/to/private/claude-profile",
    "timeoutMs": 900000,
    "maxBudgetUsd": 2
  }
}
```

Use the trusted, native Claude Code CLI version **2.1.330** on an unmanaged Linux or macOS host. The pin covers the restricted tool behavior, stream format, and transcript format. Set up an empty controller-owned profile directory with `mkdir -m 700 /absolute/path/to/private/claude-profile`. Keep the profile outside worktrees and reserve it for Switchyard. Supply an unmanaged Anthropic Console API key as `ANTHROPIC_API_KEY` in the controller's private environment. The launcher relays only that credential using Claude Code's supported key helper and a fixed executable. Use the provider's own authentication setup for the key. CLI subscriptions and managed Claude installations are outside this profile. Switchyard refuses known endpoint-managed and cached remote policy sources. The helper authentication profile receives no server-managed settings. [CLI reference](https://code.claude.com/docs/en/cli-reference) · [Managed settings](https://code.claude.com/docs/en/managed-settings) · [Server-managed settings](https://code.claude.com/docs/en/server-managed-settings)

Omit `codexHome` for Claude Code requests. A request without `provider` or with `"provider": "codex"` uses the existing Codex profile settings. `timeoutMs` defaults to 15 minutes and accepts 1 ms through 1 hour. The fix controller also applies its own `agentTimeoutMs` limit. The earlier limit wins. `maxBudgetUsd` is an optional positive USD estimate limit enforced by Claude Code per invocation. An authenticated account must be able to call the configured model.

## Current permissions

The setup and smoke tests in this guide describe the shipped API-key adapter. [ADR-0005](adr/0005-trusted-execution-environments.md) sets the direction for the [proposed subscription follow-up](plans/002-claude-code-authentication.md). Keep using the current flags and profile requirements for this version.

Claude Code's OS sandbox wraps its Bash tool. This adapter uses restricted mode and a file-tool allowlist, with Bash and other command, browser, subagent, and network tools excluded. It uses `dontAsk` with no permission responder, disables custom hooks and connectors, loads no user or repository settings, and supplies an empty MCP configuration by using strict MCP mode with no servers. Switchyard checks that the initialization frame reports the expected checkout, executable version, key source, permissions, and tools before accepting evidence. The CLI itself communicates with Anthropic. [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) · [Claude Code permissions](https://code.claude.com/docs/en/permissions)

The configured `--tools` list is an upper bound of `Read`, `Glob`, `Grep`, `Edit`, and `Write`. The native 2.1.330 CLI reported an effective set of `Edit` and `Read` with these flags, plus `StructuredOutput` when a schema was supplied. Plan fixes around the observed native tools. The mock CLI tests exercise Switchyard's policy checks. Use the native initialization frame to verify availability.

For fixes, Switchyard translates the approved `allowedPaths` into anchored edit rules and rechecks the resulting candidate against the same scope. Claude Code accepts path segments made of ASCII letters, numbers, underscores, and `@.+-`. A file scope can overlap a directory scope that already covers it. Otherwise an ancestor of another scope must be configured as a directory. Standalone turns can edit ordinary files in their workflow checkout. The provider reserves Git metadata and Claude settings. Use a checkout without symlinks, hard links, nested mounts, or special files. Switchyard rejects linked files, cross-device entries, and special files. As with Codex, trust the local controller account, installed binary, host administrator, and checkout filesystem. Give secrets to the controller outside the worktree. Configure validation commands in Switchyard for fixes that need shell execution.

## Evidence and restart

Review `--agent-status OPERATION_ID` for the configured provider and model, the CLI-reported model where available, the session identifier, the outcome, and bounded, sanitized diagnostics. The result can include input and output token counts for this invocation. The input count includes reported cache tokens for the fix controller's token budget. `sessionCostUsd` is Claude Code's cumulative estimate for the session, including restored spend. Use the latest value for a session total. Prompts, raw streams, arbitrary model text, and credentials stay out of operation records and logs. Claude Code's own transcripts can contain prompts, tool inputs and results, and patches. Keep the profile private. [Claude Code usage and cost](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

A completed invocation requires matching initialization and terminal result frames, a clean process exit, successful Git observation, and a transcript checkpoint in the configured profile. Switchyard resumes only a recorded active session with the same runtime, worktree identity, checkout content, and transcript file and digest. It passes the exact transcript path to Claude Code. Transcripts over 64 MiB or project paths over 200 encoded characters require operator inspection. Preserve the original profile and install when restarting. [Claude Code session storage](https://code.claude.com/docs/en/agent-sdk/sessions)

Cancellation and timeout send SIGTERM to the provider process group. Switchyard retains the operation claim until the CLI closes and the group is gone or has been sent SIGKILL after a short grace period. A signaling failure leaves an unknown outcome for inspection. Missing or inconsistent evidence, a changed transcript or checkout, and interrupted turns hold the workflow. A hard controller crash can leave the CLI alive. Recovery detects lost operation owners and holds the worktree even if it finds a transcript or edits, since those cannot confirm the operation's outcome. Inspect the worktree, transcript, and local processes before making a manual decision. Use a fresh workflow binding for a provider change. Keep existing claim, review, validation, and publication gates.

## Manual smoke test

Use a disposable, reconciled PR with an `awaiting_review` workflow in a test database and its head available in a trusted clone. Use a fresh private profile and worktree root. Enable the real API key in the controller environment. Each `npm start` invocation runs a new controller process.

1. Use the [agent request example](agent-sessions.md), substituting the Claude Code settings above. Have Claude remember an arbitrary test marker and replace the content of one existing tracked file with `first`. Ask it to keep the marker out of the checkout. Run `npm start -- --agent-turn request.json`. Verify exit zero and inspect the recorded provider, session, usage and changed paths. Confirm the primary checkout stays clean.
2. Run `npm start -- --recover`. Submit a new operation ID with both head SHAs from the first turn and otherwise identical settings. Ask Claude to replace `first` with the remembered marker, without putting the marker in the new prompt. Verify the same session and checkout identity, and read the tracked file to confirm the marker.
3. In another disposable workflow, use a short `timeoutMs` or interrupt the controller after a session is reported. Inspect the terminal operation and held binding. Run recovery and submit the same request ID. Verify Switchyard returns the saved result without replaying the turn.
4. For a disposable bounded fix, authorize only one tracked path. Include another tracked path and a harmless file next to the worktree as boundary checks. Confirm the agent can edit the approved path and that attempts to access the sibling file or edit the other path are denied. Inspect the operation and leave publication unauthorized.

Automated CI substitutes local mock CLI processes and needs no Anthropic credentials.

### Verify the effective native tools

From the Switchyard checkout, set `SMOKE_CLAUDE` to the absolute native executable path, `SMOKE_CHECKOUT` to a disposable checkout, `SMOKE_PROFILE` to a separate empty private directory, and `SMOKE_MODEL` to the configured model. Export these variables alongside the API key. Run the plain and structured probes below. Save the two output lines with the smoke-test record. Expect `Edit` and `Read` for the plain probe and `Edit`, `Read`, and `StructuredOutput` for the schema probe. Investigate a different tool set before enabling the provider. The probe prints only the CLI version and tool names from each initialization frame.

```sh
node --input-type=module <<'JS'
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { assertClaudePolicy, claudeEnvironment } from "./src/claude-runtime.ts";

const { SMOKE_CLAUDE, SMOKE_CHECKOUT, SMOKE_PROFILE, SMOKE_MODEL, ANTHROPIC_API_KEY } = process.env;
if (![SMOKE_CLAUDE, SMOKE_CHECKOUT, SMOKE_PROFILE, SMOKE_MODEL, ANTHROPIC_API_KEY].every(Boolean))
  throw new Error("Missing native smoke-test configuration.");
const home = realpathSync(SMOKE_PROFILE);
assertClaudePolicy(home);
const settings = {
  apiKeyHelper: "/usr/bin/printenv SWITCHYARD_CLAUDE_API_KEY",
  disableAllHooks: true,
  disableClaudeAiConnectors: true,
  permissions: {
    deny: ["Edit(.git)", "Read(.git)", "Edit(.claude)"],
    disableBypassPermissionsMode: "disable",
    disableAutoMode: "disable",
  },
};
const flags = [
  "--print", "--output-format", "stream-json", "--verbose",
  "--bare", "--restricted", "--safe-mode", "--setting-sources", "",
  "--disable-slash-commands", "--no-chrome", "--strict-mcp-config",
  "--tools", "Read,Glob,Grep,Edit,Write", "--allowedTools", "Edit(./**)",
  "--permission-mode", "dontAsk", "--permission-prompts", "none",
  "--settings", JSON.stringify(settings), "--model", SMOKE_MODEL,
];
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
for (const [mode, extra] of [["plain", []], ["schema", ["--json-schema", JSON.stringify(schema)]]]) {
  const { stdout, status } = spawnSync(SMOKE_CLAUDE, [...flags, ...extra], {
    cwd: realpathSync(SMOKE_CHECKOUT),
    env: { ...claudeEnvironment(home), SWITCHYARD_CLAUDE_API_KEY: ANTHROPIC_API_KEY },
    input: 'Reply with {"ok":true} and leave the checkout alone.',
    encoding: "utf8",
    timeout: 60_000,
  });
  if (status !== 0) throw new Error(`Native ${mode} probe failed.`);
  let init;
  try {
    init = stdout.trim().split("\n").map((line) => JSON.parse(line))
      .find(({ type, subtype }) => type === "system" && subtype === "init");
  } catch {
    throw new Error(`Native ${mode} probe returned invalid stream data.`);
  }
  if (init?.claude_code_version !== "2.1.330" || !Array.isArray(init.tools))
    throw new Error(`Native ${mode} initialization evidence is missing or incompatible.`);
  console.log(JSON.stringify({ mode, version: init.claude_code_version, tools: init.tools.sort() }));
}
JS
```
