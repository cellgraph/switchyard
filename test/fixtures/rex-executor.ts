import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentResult, AgentTurn } from "../../src/agent.ts";
import { runRemoteExecutor } from "../../src/remote-executor.ts";
import { earlyExitPrompt, runSdkEarlyExitTurn } from "./execution.ts";

await runRemoteExecutor(process.argv[2]!, process.env.REX_BLOCK, (context) => {
  async function execute(turn: AgentTurn, nativeId: string = randomUUID()): Promise<AgentResult> {
    if (turn.prompt === earlyExitPrompt)
      return runSdkEarlyExitTurn(join(context.workingDirectory, "early-exit-codex"), turn.prompt);
    turn.onSession(nativeId);
    if (turn.prompt === "inspect context")
      return { outcome: "completed", response: JSON.stringify(context) };
    if (turn.prompt === "wait for release" || turn.prompt === "wait then fail") {
      const release = join(process.argv[2]!, "release");
      writeFileSync(join(process.argv[2]!, "waiting"), "", { mode: 0o600 });
      try {
        while (!existsSync(release)) await delay(100, undefined, { signal: turn.signal });
      } catch (error) {
        if (!turn.signal?.aborted) throw error;
        writeFileSync(join(process.argv[2]!, "interrupted"), "", { mode: 0o600 });
        return { outcome: "unknown", reason: "Fixture interrupted before a native outcome." };
      }
      if (turn.prompt === "wait then fail")
        return { outcome: "failed", reason: "Fixture reported native failure." };
    }
    return { outcome: "completed", response: "fixture done", structuredOutput: { ok: true } };
  }
  return { start: execute, resume: (nativeId, turn) => execute(turn, nativeId) };
});
