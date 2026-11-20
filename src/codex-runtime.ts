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
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRuntime, AgentSessionCheckpoint } from "./agent-operation.ts";
import { codexConfig, codexEnvironment, codexTurnPolicy } from "./codex-agent.ts";

const sdkModule = import.meta.resolve("@openai/codex-sdk");
const requireFromSdk = createRequire(sdkModule);

export function codexConfigFingerprint(home: string, systemDirectory = "/etc/codex"): string {
  const profiles = readdirSync(home)
    .filter((name) => name.endsWith(".config.toml"))
    .sort();
  const sources = [
    ...["config.toml", "requirements.toml", "managed_config.toml"].map((name) =>
      join(systemDirectory, name),
    ),
    ...["config.toml", ...profiles].map((name) => join(home, name)),
  ];
  const hash = createHash("sha256");
  for (const path of sources) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.size > 1024 * 1024))
      throw new Error("Codex configuration is not a supported regular file.");
    hash.update(
      JSON.stringify([
        path,
        stat ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
      ]),
    );
  }
  return hash.digest("hex");
}

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
      env: apiKey ? { ...env, CODEX_API_KEY: apiKey } : env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  }
  let cliVersion: string;
  try {
    cliVersion = cliCommand("--version");
    if (sdkVersion !== "0.171.0" || cliVersion !== `codex-cli ${sdkVersion}`)
      throw new Error("Unexpected CLI version.");
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
  let requirements: unknown;
  try {
    const startup = JSON.parse(
      cliCommand(
        "app-server",
        "--print-startup-config",
        "-c",
        `sqlite_home=${JSON.stringify(home)}`,
      ),
    ) as {
      appServerVersion?: string;
      configRequirements?: { requirements?: { sqliteHome?: unknown } | null };
    };
    if (
      startup.appServerVersion !== sdkVersion ||
      startup.configRequirements?.requirements === undefined
    )
      throw new Error("Unknown startup config format.");
    requirements = startup.configRequirements.requirements;
    // Managed SQLite requirements override even CLI configuration.
    if (startup.configRequirements.requirements?.sqliteHome != null)
      throw new Error("Managed Codex SQLite location.");
  } catch {
    throw new Error("Could not verify Codex startup requirements and SQLite location.");
  }
  const configuration = createHash("sha256")
    .update(
      JSON.stringify([
        codexConfig,
        requirements,
        codexTurnPolicy,
        env,
        apiKey ? "api-key" : "profile",
        String(stat.dev),
        String(stat.ino),
        String(stat.birthtimeNs),
      ]),
    )
    .update(codexConfigFingerprint(home))
    .digest("hex");
  return { provider: "codex", model, sdkVersion, cliVersion, home, configuration };
}

export function codexSessionCheckpoint(
  home: string,
  threadId: string,
  workingDirectory: string,
): AgentSessionCheckpoint {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(threadId))
    throw new Error("Codex did not report a supported session ID.");
  try {
    // Codex 0.171.0 prefers SQLite's selected path to a filesystem scan.
    // Require that selection even for legacy threads, where Codex can fall back.
    const statePath = join(home, "state_5.sqlite");
    if (!lstatSync(statePath).isFile()) throw new Error("Codex state database is unavailable.");
    const state = new DatabaseSync(statePath, { readOnly: true, timeout: 5_000 });
    let selected: { rollout_path: string; archived: number } | undefined;
    try {
      selected = state
        .prepare("SELECT rollout_path, archived FROM threads WHERE id=?")
        .get(threadId) as typeof selected;
    } finally {
      state.close();
    }
    const path = selected?.rollout_path;
    if (!path || selected?.archived !== 0 || !isAbsolute(path) || realpathSync(path) !== path)
      throw new Error("Codex did not select an active rollout.");
    const parts = relative(join(home, "sessions"), path).split(sep);
    if (
      parts.length !== 4 ||
      !/^\d{4}$/.test(parts[0]!) ||
      !/^\d{2}$/.test(parts[1]!) ||
      !/^\d{2}$/.test(parts[2]!) ||
      !parts[3]!.startsWith("rollout-") ||
      !parts[3]!.endsWith(`-${threadId}.jsonl`)
    )
      throw new Error("Unsupported Codex rollout path.");
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
    return {
      identity: JSON.stringify([
        path,
        String(stat.dev),
        String(stat.ino),
        String(stat.birthtimeNs),
      ]),
      digest: createHash("sha256").update(contents).digest("hex"),
    };
  } catch {
    throw new Error("Codex session is missing, inaccessible, or incompatible with this checkout.");
  }
}
