import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { localCodexWorker } from "./agent-command.ts";
import { authorizeFix, createFixController, fixStatus } from "./fix-controller.ts";
import { createFixGit, runValidation } from "./fix-git.ts";
import type { FixConfig } from "./fix-store.ts";
import type { GitHubReader, PullRequestTarget } from "./github-api.ts";
import { object } from "./github-data.ts";
import { createReconciler } from "./reconcile.ts";
import { WorkflowStore } from "./store.ts";
import { createWorktreeManager } from "./worktree.ts";

export function parseFixConfig(value: unknown): FixConfig {
  const input = object(value);
  if (!input) throw new Error("The fix configuration must be an object.");
  function string(key: string, validate = (value: string) => Boolean(value.trim())) {
    const value = input![key];
    if (typeof value !== "string" || !validate(value))
      throw new Error(`Invalid fix setting ${key}.`);
    return value;
  }
  function strings(value: unknown, key: string): string[] {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 100 ||
      !value.every((item) => typeof item === "string" && item.trim() && !item.includes("\0"))
    )
      throw new Error(`Invalid fix setting ${key}. Supply a nonempty array of strings.`);
    return value as string[];
  }
  function integer(key: string, fallback: number, min: number, max: number) {
    const value = input![key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Fix setting ${key} must be between ${min} and ${max}.`);
    return value;
  }
  const allowedPaths = strings(input.allowedPaths, "allowedPaths");
  for (const scope of allowedPaths) {
    if (
      isAbsolute(scope) ||
      scope.includes("\\") ||
      scope
        .replace(/\/$/, "")
        .split("/")
        .some((part) => !part || [".", "..", ".git"].includes(part.toLowerCase()))
    )
      throw new Error(
        "Allowed paths must be literal repository-relative files or directories ending in /.",
      );
  }
  const requiredChecks = strings(input.requiredChecks, "requiredChecks");
  if (new Set(requiredChecks).size !== requiredChecks.length)
    throw new Error("Required check names must be unique.");
  if (!Array.isArray(input.validation) || !input.validation.length || input.validation.length > 20)
    throw new Error("Supply between one and twenty validation commands.");
  const ids = new Set();
  const validation = (input.validation as unknown[]).map((value) => {
    const command = object(value);
    const id = command?.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(id) || ids.has(id))
      throw new Error("Validation commands require unique IDs.");
    ids.add(id);
    return { id, argv: strings(command?.argv, id) };
  });
  return {
    repositoryDirectory: string("repositoryDirectory", isAbsolute),
    worktreeRoot: string("worktreeRoot", isAbsolute),
    codexHome: string("codexHome", isAbsolute),
    model: string("model"),
    localBranch: string("localBranch"),
    allowedPaths,
    requiredChecks,
    validation,
    maxCycles: integer("maxCycles", 3, 1, 3),
    maxOperationAttempts: integer("maxOperationAttempts", 2, 1, 5),
    ...(input.maxTotalTokens === undefined
      ? {}
      : { maxTotalTokens: integer("maxTotalTokens", 0, 1, 1_000_000_000) }),
    maxValidationRetries: integer("maxValidationRetries", 1, 0, 4),
    agentTimeoutMs: integer("agentTimeoutMs", 900_000, 1, 3_600_000),
    validationTimeoutMs: integer("validationTimeoutMs", 300_000, 1, 900_000),
  };
}

export async function runFixCommand(
  args: string[],
  dbPath: string,
  loadTargets: (path: string) => PullRequestTarget[],
  makeReader: (store: WorkflowStore, targets: PullRequestTarget[]) => GitHubReader,
): Promise<boolean> {
  const [command, workflowId, input] = args;
  if (
    !command ||
    !["--fix-status", "--fix-advance", "--fix-authorize", "--fix-publish"].includes(command)
  )
    return false;
  if (!workflowId || args.length !== (command === "--fix-status" ? 2 : 3))
    throw new Error(
      "Usage: --fix-status WORKFLOW_ID, --fix-advance WORKFLOW_ID CONFIG.json, --fix-authorize WORKFLOW_ID CYCLE_ID, or --fix-publish WORKFLOW_ID CYCLE_ID.",
    );
  const store = new WorkflowStore(dbPath);
  try {
    if (command === "--fix-authorize" || command === "--fix-publish") {
      authorizeFix(store, workflowId, input!, command === "--fix-publish");
    } else if (command === "--fix-advance") {
      const targets = loadTargets(input!);
      const target = targets.find(
        ({ repository, pullRequest }) => `${repository}#${pullRequest}` === workflowId,
      );
      if (!target) throw new Error("The workflow is missing from the configured GitHub PRs.");
      const rawConfig = object(JSON.parse(readFileSync(input!, "utf8")));
      const configured = parseFixConfig(rawConfig?.fix);
      const latest = store.fixes(workflowId).read().at(-1);
      const config =
        latest && !["finished", "proposed"].includes(latest.phase) ? latest.config : configured;
      const reader = makeReader(store, targets);
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const worktrees = createWorktreeManager(config);
        const reconcile = createReconciler(store, reader, () => config.requiredChecks);
        await createFixController({
          store,
          workflowId,
          config,
          worker: localCodexWorker(config),
          git: createFixGit(worktrees, `git@github.com:${target.repository}.git`),
          validate: runValidation,
          readPullRequest: () => reader.readPullRequest(target),
          refresh: () => reconcile(target),
          signal: abort.signal,
        }).advance();
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }
    console.info(JSON.stringify(fixStatus(store, workflowId)));
    return true;
  } finally {
    store.close();
  }
}
