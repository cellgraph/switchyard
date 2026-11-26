import { readFileSync } from "node:fs";
import type { PullRequestTarget } from "./github-api.ts";
import { object, positiveInteger, repositoryName } from "./github-data.ts";

export function workflowKey(target: PullRequestTarget): string {
  return `${target.repository}#${target.pullRequest}`;
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
  const requiredChecks = new Map<string, string[]>();
  if (config.requiredChecks !== undefined) {
    const entries = object(config.requiredChecks);
    if (!entries)
      throw new Error("requiredChecks must map configured owner/repo#PR IDs to check names.");
    for (const [key, names] of Object.entries(entries)) {
      if (!seen.has(key))
        throw new Error("Each requiredChecks key must match a configured owner/repo#PR ID.");
      if (
        !Array.isArray(names) ||
        !names.length ||
        names.length > 100 ||
        !names.every(
          (name): name is string =>
            typeof name === "string" && Boolean(name.trim()) && !name.includes("\0"),
        ) ||
        new Set(names).size !== names.length
      )
        throw new Error(`Required checks for ${key} must be a nonempty array of unique names.`);
      requiredChecks.set(key, names);
    }
  }
  return { targets, reconcileIntervalMs: interval, requiredChecks };
}
