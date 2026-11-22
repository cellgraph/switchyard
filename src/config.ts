import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FixConfig } from "./fix-store.ts";
import type { PullRequestTarget } from "./github-api.ts";
import { object, positiveInteger, repositoryName } from "./github-data.ts";

export function workflowKey(target: PullRequestTarget): string {
  return `${target.repository}#${target.pullRequest}`;
}

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

export function loadConfig(path: string) {
  const raw = readFileSync(path, "utf8");
  let config: Record<string, unknown> | undefined;
  try {
    config = object(JSON.parse(raw));
  } catch {
    throw new Error("Switchyard configuration is not valid JSON.");
  }
  if (!Array.isArray(config?.repositories) || !config.repositories.length)
    throw new Error("Configuration requires a non-empty repositories array.");
  const targets: PullRequestTarget[] = [];
  const seen = new Set<string>();
  for (const value of config.repositories as unknown[]) {
    const entry = object(value);
    const repository = repositoryName(entry?.repository);
    const installationId = entry?.installationId;
    const pullRequests = entry?.pullRequests;
    if (
      !repository ||
      !positiveInteger(installationId) ||
      !Array.isArray(pullRequests) ||
      !pullRequests.length ||
      !pullRequests.every(positiveInteger)
    )
      throw new Error(
        "Each repository needs an owner/name, installationId, and positive PR numbers.",
      );
    for (const pullRequest of pullRequests) {
      const id = `${repository}#${pullRequest}`;
      if (seen.has(id)) throw new Error(`Duplicate configured pull request ${id}.`);
      seen.add(id);
      targets.push({ repository, installationId, pullRequest });
    }
  }
  const interval = config.reconcileIntervalMs ?? 60_000;
  if ((interval !== 0 && !positiveInteger(interval)) || interval > 2_147_483_647)
    throw new Error("reconcileIntervalMs must be between 0 and 2147483647.");
  const fixes = new Map<string, FixConfig>();
  if (config.fix !== undefined) {
    if (targets.length !== 1 || config.fixes !== undefined)
      throw new Error("A top-level fix requires one configured pull request and no fixes map.");
    fixes.set(workflowKey(targets[0]!), parseFixConfig(config.fix));
  }
  if (config.fixes !== undefined) {
    const entries = object(config.fixes);
    if (!entries)
      throw new Error("The fixes setting must map configured owner/repo#PR IDs to fix settings.");
    for (const [key, value] of Object.entries(entries)) {
      if (!seen.has(key))
        throw new Error("Each fixes key must match a configured owner/repo#PR ID.");
      const fix = parseFixConfig(value);
      fixes.set(key, fix);
    }
  }
  return { targets, reconcileIntervalMs: interval, fixes };
}
