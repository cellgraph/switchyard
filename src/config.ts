import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadNamedAgent, type AgentSelection } from "./agent-config.ts";
import { prRoles, type PrRole } from "./pr-assignments.ts";
import type { GitHubRepository } from "./github-app.ts";
import { object, positiveInteger, repositoryName } from "./github-data.ts";

export type PrRoleConfig = { agent: AgentSelection & { agentName: string }; producerId: number };
export type PrWorkflowConfig = Record<PrRole, PrRoleConfig>;

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
  if (!positiveInteger(interval) || interval > 2_147_483_647)
    throw new Error("reconcileIntervalMs must be an integer between 1 and 2147483647.");
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
  const workflows = new Map<string, PrWorkflowConfig>();
  const checkApps = new Map<string, Map<string, number>>();
  if (config.prWorkflows !== undefined) {
    const entries = object(config.prWorkflows);
    const agentsFile = config.agentsFile;
    if (!entries || typeof agentsFile !== "string" || !agentsFile.trim())
      throw new Error("prWorkflows requires an agentsFile and a map of enabled repositories.");
    for (const [key, entry] of Object.entries(entries)) {
      const repository = repositoryName(key);
      const settings = object(entry);
      if (!repository || !seen.has(repository) || workflows.has(repository) || !settings)
        throw new Error("Each prWorkflows key must match a distinct enabled repository.");
      const roles = prRoles.map((role) => {
        const { agent: name, githubUserId } = object(settings[role]) ?? {};
        if (typeof name !== "string" || !positiveInteger(githubUserId))
          throw new Error(`Configure a named ${role} and numeric githubUserId for ${repository}.`);
        const agent = loadNamedAgent(resolve(dirname(path), agentsFile), name);
        if (!agent.rex)
          throw new Error(`Autonomous ${role} dispatch requires a supervised Rex placement.`);
        return [role, { agent: { ...agent, agentName: name }, producerId: githubUserId }] as const;
      });
      if (
        new Set(roles.map(([, configured]) => configured.agent.agentName)).size !== prRoles.length
      )
        throw new Error(`Configure a separate named agent for each role in ${repository}.`);

      const apps = object(settings.checkApps);
      const checks = requiredChecks.get(repository);
      if (!checks || !apps || Object.keys(apps).length !== checks.length)
        throw new Error(
          `Configure a trusted GitHub App ID for every required check in ${repository}.`,
        );
      checkApps.set(
        repository,
        new Map(
          checks.map((name) => {
            const id = Object.hasOwn(apps, name) ? apps[name] : undefined;
            if (!positiveInteger(id))
              throw new Error(`Required check "${name}" needs a numeric GitHub App ID.`);
            return [name, id];
          }),
        ),
      );
      workflows.set(repository, Object.fromEntries(roles) as PrWorkflowConfig);
    }
  }
  return { repositories, reconcileIntervalMs: interval, requiredChecks, workflows, checkApps };
}
