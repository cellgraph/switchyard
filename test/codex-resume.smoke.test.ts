import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { AgentOperation } from "../src/agent-operation.ts";
import { WorkflowStore } from "../src/store.ts";
import { agentRepository, git } from "./fixtures/agent-repository.ts";

const run = promisify(execFile);

it.runIf(process.env.SWITCHYARD_CODEX_SMOKE === "1")(
  "resumes the same Codex thread and dirty worktree in a fresh controller process",
  async () => {
    const fixture = agentRepository();
    const store = new WorkflowStore(fixture.db);
    store.createWorkflow(fixture.workflow);
    store.close();

    try {
      const codexHome = join(fixture.root, "codex");
      mkdirSync(codexHome, { mode: 0o700 });
      const authFile = process.env.SWITCHYARD_SMOKE_AUTH_FILE;
      if (authFile) {
        const destination = join(codexHome, "auth.json");
        copyFileSync(authFile, destination);
        chmodSync(destination, 0o600);
      }
      if (!authFile && !process.env.OPENAI_API_KEY)
        throw new Error(
          "Set OPENAI_API_KEY or SWITCHYARD_SMOKE_AUTH_FILE for the live smoke test.",
        );
      const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
      async function controller(...args: string[]): Promise<string> {
        const { stdout } = await run(process.execPath, [entry, ...args], {
          env: { ...process.env, SWITCHYARD_DB_PATH: fixture.db },
          timeout: 90_000,
        }).catch((error: unknown) => {
          const failure = error as { stdout?: string; message?: string };
          throw new Error(failure.stdout?.trim() || failure.message);
        });
        return stdout.trim();
      }

      const nonce = randomUUID();
      const input = join(fixture.root, "request.json");
      const model = process.env.SWITCHYARD_SMOKE_MODEL;
      if (!model)
        throw new Error("Set SWITCHYARD_SMOKE_MODEL to a model available to your account.");
      const request = {
        ...fixture.request,
        repositoryDirectory: fixture.repo,
        worktreeRoot: fixture.worktrees,
        codexHome,
        model,
      };
      writeFileSync(
        input,
        JSON.stringify({
          ...request,
          prompt: `Remember the exact token ${nonce} for a follow-up turn. Write only the text first into first.txt in this working directory. Do not put the token in any file or commit. Do not change anything else.`,
        }),
      );
      const first = JSON.parse(await controller("--agent-turn", input)) as AgentOperation;
      expect(first.status).toBe("completed");
      const reference = first.evidence?.reference;
      expect(reference?.agent.id).toBeTruthy();
      expect(first.evidence?.workspace).toEqual({
        head: request.expectedHead,
        changedPaths: ["first.txt"],
      });

      expect(JSON.parse(await controller("--recover"))).toEqual({
        deliveries: 0,
        ambiguousOperations: 0,
      });
      writeFileSync(
        input,
        JSON.stringify({
          ...request,
          operationId: "follow-up",
          prompt:
            "Write the exact token I asked you to remember in the previous turn into second.txt in this working directory, with no other text. Keep first.txt intact. Do not commit or change anything else.",
        }),
      );
      const second = JSON.parse(await controller("--agent-turn", input)) as AgentOperation;
      expect(second.status).toBe("completed");
      expect(second.evidence?.reference).toEqual(reference);
      expect(second.evidence?.workspace).toEqual({
        head: request.expectedHead,
        changedPaths: ["first.txt", "second.txt"],
      });
      expect(readFileSync(join(reference!.worktree.path, "first.txt"), "utf8").trim()).toBe(
        "first",
      );
      expect(readFileSync(join(reference!.worktree.path, "second.txt"), "utf8").trim()).toBe(nonce);
      expect(git(fixture.repo, "status", "--porcelain")).toBe("");
      expect(git(fixture.repo, "worktree", "list").split("\n")).toHaveLength(2);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  200_000,
);
