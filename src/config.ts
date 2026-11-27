import { readFileSync } from "node:fs";
import type { GitHubRepository } from "./github-app.ts";
import { object, positiveInteger, repositoryName } from "./github-data.ts";

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
  const repositories: GitHubRepository[] = [];
  const seen = new Set<string>();
  for (const value of config.repositories as unknown[]) {
    const entry = object(value);
    const repository = repositoryName(entry?.repository);
    const installationId = entry?.installationId;
    if (!repository || !positiveInteger(installationId) || entry?.pullRequests !== undefined)
      throw new Error(
        "Each repository needs an owner/name and installationId. PRs are discovered automatically.",
      );
    if (seen.has(repository)) throw new Error(`Duplicate configured repository ${repository}.`);
    seen.add(repository);
    repositories.push({ repository, installationId });
  }
  const interval = config.reconcileIntervalMs ?? 60_000;
  if ((interval !== 0 && !positiveInteger(interval)) || interval > 2_147_483_647)
    throw new Error("reconcileIntervalMs must be between 0 and 2147483647.");
  const requiredChecks = new Map<string, string[]>();
  if (config.requiredChecks !== undefined) {
    const entries = object(config.requiredChecks);
    if (!entries)
      throw new Error("requiredChecks must map enabled owner/repo repositories to check names.");
    for (const [key, names] of Object.entries(entries)) {
      const repository = repositoryName(key);
      if (!repository || !seen.has(repository) || requiredChecks.has(repository))
        throw new Error("Each requiredChecks key must match a distinct enabled owner/repo.");
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
      requiredChecks.set(repository, names);
    }
  }
  return { repositories, reconcileIntervalMs: interval, requiredChecks };
}
