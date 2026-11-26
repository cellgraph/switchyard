import { spawnSync } from "node:child_process";

export const executionContext = { provider: "codex", workingDirectory: "/fixture" } as const;

export function runSdkWithEarlyExit(dbPath: string, executable: string) {
  const controller = new URL("../../src/agent-controller.ts", import.meta.url).href;
  const store = new URL("../../src/store.ts", import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { Codex } from "@openai/codex-sdk";
        import { createAgentController } from ${JSON.stringify(controller)};
        import { WorkflowStore } from ${JSON.stringify(store)};
        const store = new WorkflowStore(process.argv[1]);
        let sdkError;
        const controller = createAgentController(store.agentExecutions(), () => ({
          async start(turn) {
            const sdk = new Codex({ codexPathOverride: process.argv[2], env: {} });
            try {
              const { events } = await sdk.startThread().runStreamed(turn.prompt);
              for await (const event of events) {
                throw new Error("Unexpected SDK event: " + event.type);
              }
            } catch (error) {
              sdkError = error;
              throw error;
            }
            throw new Error("SDK stream ended without reporting the fixture failure.");
          },
        }));
        const run = await controller.execute({
          id: "early-exit", assignmentId: "sdk-assignment", prompt: "x".repeat(4 * 1024 * 1024),
          context: ${JSON.stringify(executionContext)},
        });
        // The controller translates any adapter exception to unknown. Verify the actual SDK error.
        assert.ok(sdkError instanceof Error, "Expected the SDK to reject");
        assert.ok(
          sdkError.message.trimEnd() === "Codex Exec exited with code 2:" ||
            (sdkError.code === "EPIPE" && sdkError.syscall === "write"),
          "Unexpected SDK rejection: " + sdkError.message,
        );
        console.log(JSON.stringify(run));
        store.close();
      `,
      dbPath,
      executable,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}

export function crashAfterSession(dbPath: string) {
  const controller = new URL("../../src/agent-controller.ts", import.meta.url).href;
  const store = new URL("../../src/store.ts", import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { createAgentController } from ${JSON.stringify(controller)};
        import { WorkflowStore } from ${JSON.stringify(store)};
        const store = new WorkflowStore(process.argv[1]);
        const controller = createAgentController(store.agentExecutions(), () => ({
          start(turn) {
            turn.onSession("crashed-native-id");
            process.kill(process.pid, "SIGKILL");
          },
        }));
        await controller.execute({
          id: "interrupted", assignmentId: "interrupted", prompt: "run",
          context: ${JSON.stringify(executionContext)},
        });
      `,
      dbPath,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
}
