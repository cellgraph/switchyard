import { spawnSync } from "node:child_process";

export const executionContext = { provider: "codex", workingDirectory: "/fixture" } as const;

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
