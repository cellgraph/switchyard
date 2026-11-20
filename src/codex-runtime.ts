import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentRuntime } from "./agent-operation.ts";
import { codexConfig, codexEnvironment, codexTurnPolicy } from "./codex-agent.ts";

const sdkModule = import.meta.resolve("@openai/codex-sdk");
const requireFromSdk = createRequire(sdkModule);

export function codexRuntime(model: string, homePath: string, apiKey?: string): AgentRuntime {
  if (!model.trim()) throw new Error("A Codex model must be configured.");
  if (!isAbsolute(homePath)) throw new Error("Codex home must be an absolute path.");
  const home = realpathSync(homePath);
  const stat = statSync(home, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Codex home must be a directory.");
  accessSync(home, constants.R_OK | constants.W_OK | constants.X_OK);
  const { version: sdkVersion } = JSON.parse(
    readFileSync(new URL("../package.json", sdkModule), "utf8"),
  ) as { version: string };
  const cli = join(
    dirname(requireFromSdk.resolve("@openai/codex/package.json")),
    "bin",
    "codex.js",
  );
  const env = codexEnvironment(home);
  function cliCommand(...args: string[]): string {
    return execFileSync(process.execPath, [cli, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  }
  let cliVersion: string;
  try {
    cliVersion = cliCommand("--version");
    if (cliVersion !== `codex-cli ${sdkVersion}`) throw new Error("Unexpected CLI version.");
  } catch {
    throw new Error("The bundled Codex CLI is unavailable or incompatible with the SDK.");
  }
  if (!apiKey) {
    try {
      cliCommand("login", "status");
    } catch {
      throw new Error("Codex credentials are missing or inaccessible.");
    }
  }
  const config = join(home, "config.toml");
  const configuration = createHash("sha256")
    .update(
      JSON.stringify([
        codexConfig,
        codexTurnPolicy,
        env,
        apiKey ? "api-key" : "profile",
        String(stat.dev),
        String(stat.ino),
        String(stat.birthtimeNs),
      ]),
    )
    .update(lstatSync(config, { throwIfNoEntry: false }) ? readFileSync(config) : "")
    .digest("hex");
  return { provider: "codex", model, sdkVersion, cliVersion, home, configuration };
}

export function codexSessionCheckpoint(
  home: string,
  threadId: string,
  workingDirectory: string,
): string {
  // The pinned CLI's rollout directory is the local resume source. A different layout
  // requires a compatibility update before Switchyard can authorize continuation.
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(threadId))
    throw new Error("Codex did not report a supported session ID.");
  const sessions = join(home, "sessions");
  const matches: string[] = [];
  function inspect(directory: string, depth: number): void {
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (depth && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) inspect(path, depth - 1);
      if (
        !depth &&
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(`-${threadId}.jsonl`)
      )
        matches.push(path);
    }
  }
  try {
    inspect(sessions, 3);
    const path = matches[0];
    if (matches.length !== 1 || !path) throw new Error("Missing or duplicate rollout.");
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.size > 64n * 1024n * 1024n) throw new Error("Unsupported rollout.");
    const contents = readFileSync(path);
    const firstLine = contents.indexOf(10);
    if (firstLine === -1) throw new Error("Missing session metadata.");
    const meta = JSON.parse(contents.subarray(0, firstLine).toString("utf8")) as {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
    if (
      meta.type !== "session_meta" ||
      meta.payload?.id !== threadId ||
      meta.payload.cwd !== workingDirectory
    )
      throw new Error("Rollout identity differs.");
    return createHash("sha256")
      .update(JSON.stringify([path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]))
      .update(contents)
      .digest("hex");
  } catch {
    throw new Error("Codex session is missing, inaccessible, or incompatible with this checkout.");
  }
}
