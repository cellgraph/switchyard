import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import type { ClaudeSettings } from "./agent-config.ts";
import type { AgentRuntime, AgentSessionCheckpoint } from "./agent-operation.ts";
import { object } from "./github-data.ts";

export const claudeProvider = "claude-code";
export const claudeVersion = "2.1.330";
// Bump when the launch policy changes to prevent resuming across permission changes.
const claudePolicyVersion = 1;
export const claudeSessionId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const managedDirectory =
  process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";

export function claudeEnvironment(home: string) {
  return {
    HOME: home,
    CLAUDE_CONFIG_DIR: home,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
  };
}

export function assertClaudePolicy(home: string) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Claude Code execution is supported on macOS and Linux.");
  // Managed hooks, plugins, and permission rules can override the CLI restrictions.
  for (const path of [
    ...["managed-settings.json", "managed-settings.d", "managed-mcp.json"].map((name) =>
      join(managedDirectory, name),
    ),
    ...(process.platform === "darwin"
      ? [
          "/Library/Managed Preferences/com.anthropic.claudecode.plist",
          `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudecode.plist`,
        ]
      : []),
    join(home, "remote-settings.json"),
  ]) {
    if (lstatSync(path, { throwIfNoEntry: false }))
      throw new Error("Claude Code managed settings are incompatible with Switchyard execution.");
  }
}

function identity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return JSON.stringify([path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
}

export function claudeExecutableIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  return JSON.stringify([identity(path), String(stat.size), String(stat.mtimeNs)]);
}

export function claudeRuntime(model: string, settings: ClaudeSettings, key: string | undefined) {
  if (!key?.trim())
    throw new Error("Claude Code requires ANTHROPIC_API_KEY in the controller environment.");
  let home: string;
  try {
    home = realpathSync(settings.home);
    const stat = lstatSync(home);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Private profile required.");
    accessSync(home, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(
      "Claude Code requires an accessible profile directory owned by the controller with mode 0700.",
    );
  }
  assertClaudePolicy(home);
  let executable: string;
  let executableIdentity: string;
  let cliVersion: string;
  try {
    executable = realpathSync(settings.executable);
    if (!lstatSync(executable).isFile()) throw new Error("Expected a regular file.");
    executableIdentity = claudeExecutableIdentity(executable);
    cliVersion = execFileSync(executable, ["--version"], {
      cwd: home,
      env: claudeEnvironment(home),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4096,
      killSignal: "SIGKILL",
    }).trim();
    if (cliVersion !== `${claudeVersion} (Claude Code)`) throw new Error("Unsupported version.");
  } catch {
    throw new Error(
      `Claude Code CLI is unavailable or incompatible. Install version ${claudeVersion}.`,
    );
  }
  const runtime: AgentRuntime = {
    provider: claudeProvider,
    model,
    sdkVersion: "none",
    cliVersion,
    home,
    configuration: createHash("sha256")
      .update(
        JSON.stringify([
          claudePolicyVersion,
          identity(home),
          executableIdentity,
          claudeEnvironment(home),
          settings,
        ]),
      )
      .digest("hex"),
  };
  return { runtime, executable, executableIdentity };
}

export function claudeTranscript(home: string, id: string, directory: string): string {
  const project = directory.replace(/[^a-zA-Z0-9]/g, "-");
  if (!claudeSessionId.test(id) || project.length > 200)
    throw new Error("Claude Code session ID or project path is unsupported.");
  return join(home, "projects", project, `${id}.jsonl`);
}

export function claudeSessionCheckpoint(
  home: string,
  id: string,
  directory: string,
): AgentSessionCheckpoint {
  const path = claudeTranscript(home, id, directory);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 64 * 1024 * 1024 ||
      realpathSync(path) !== path
    )
      throw new Error("Unsupported transcript.");
    const bytes = readFileSync(path);
    const records = bytes.toString("utf8").split("\n");
    if (
      !records.some((line) => {
        const record = line ? object(JSON.parse(line)) : undefined;
        return (
          record?.sessionId === id &&
          record.cwd === directory &&
          (record.type === "user" || record.type === "assistant")
        );
      })
    )
      throw new Error("Missing session identity.");
    return { identity: identity(path), digest: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    throw new Error(
      "Claude Code transcript is missing, inaccessible, or incompatible with this checkout.",
    );
  }
}

export function assertClaudeWorkspace(home: string, directory: string) {
  const path = relative(home, directory);
  const parent = relative(directory, home);
  const outside = (name: string) => name === ".." || name.startsWith(`..${sep}`);
  if (!outside(path) || !outside(parent))
    throw new Error("The Claude Code profile and worktree must not overlap.");
}
