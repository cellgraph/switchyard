import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { validRemoteKey, validRexId } from "./agent-config.ts";
import { validNativeId, type AgentAdapter, type AgentContext, type AgentResult } from "./agent.ts";
import { createNativeAgent } from "./native-agent.ts";
import { readCorrelation, readRequest, type RemoteEvidence } from "./remote-execution.ts";

function privateDirectory(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publish(directory: string, evidence: RemoteEvidence): void {
  const target = join(directory, "evidence.json");
  const temporary = target + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(evidence));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  syncDirectory(directory);
}

export async function runRemoteExecutor(
  directory: string,
  blockId: string | undefined,
  adapterFor: (context: AgentContext) => AgentAdapter = createNativeAgent,
): Promise<void> {
  if (
    !isAbsolute(directory) ||
    normalize(directory) !== directory ||
    !validRemoteKey(basename(directory)) ||
    !validRexId(blockId, "block") ||
    !privateDirectory(dirname(directory)) ||
    !privateDirectory(directory)
  )
    throw new Error("Invalid remote execution directory or Rex block.");

  // This marker outlives the process and is never removed by the executor.
  try {
    mkdirSync(join(directory, "claimed"), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  syncDirectory(directory);
  syncDirectory(dirname(directory));
  const path = join(directory, "request.json");
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0)
    throw new Error("Remote request file must be private.");
  const request = readRequest(JSON.parse(readFileSync(path, "utf8")));
  if (request.key !== basename(directory))
    throw new Error("Request key does not match its directory.");
  const correlation = readCorrelation(request);
  let nativeId = request.expectedNativeId;
  const evidence = () => ({ ...correlation, blockId, nativeId });
  publish(directory, evidence());
  unlinkSync(path);

  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let result: AgentResult;
    let conflictingSession = false;
    try {
      process.chdir(request.context.workingDirectory);
      if (
        request.context.configDirectory &&
        !statSync(request.context.configDirectory).isDirectory()
      )
        throw new Error("Invalid native configuration directory.");
    } catch {
      publish(directory, {
        ...evidence(),
        result: {
          outcome: "not_started",
          reason: "Remote working or config directory is unavailable.",
        },
      });
      return;
    }

    try {
      const adapter = adapterFor(request.context);
      const turn = {
        prompt: request.prompt,
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        signal: abort.signal,
        onSession(reportedId: string) {
          if (!validNativeId(reportedId) || (nativeId !== null && reportedId !== nativeId)) {
            conflictingSession = true;
            return;
          }
          if (nativeId === reportedId) return;
          nativeId = reportedId;
          publish(directory, evidence());
        },
      };
      result = nativeId ? await adapter.resume(nativeId, turn) : await adapter.start(turn);
    } catch {
      result = {
        outcome: "unknown",
        reason: "Native execution ended without a confirmed outcome.",
      };
    }
    if (
      conflictingSession ||
      (result.outcome === "completed" && nativeId === null) ||
      (result.outcome === "not_started" && nativeId !== request.expectedNativeId)
    )
      result = { outcome: "unknown", reason: "Could not confirm the native execution evidence." };
    publish(directory, { ...evidence(), result });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 3) throw new Error("Expected one execution directory.");
    await runRemoteExecutor(process.argv[2]!, process.env.REX_BLOCK);
  } catch {
    console.error("Remote executor could not publish a confirmed outcome.");
    process.exitCode = 1;
  }
}
