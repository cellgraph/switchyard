import { loadApproval } from "./approved-plan.ts";
import { loadConfig } from "./config.ts";
import type { PlanGitHubReader } from "./github-api.ts";
import type { GitHubRepository } from "./github-app.ts";
import { commitSha, positiveInteger, repositoryName } from "./github-data.ts";
import { pullUrl } from "./pr-assignments.ts";
import { currentIncrement, type PlanExecution } from "./plan-store.ts";
import { WorkflowStore } from "./store.ts";

const usage = `Usage:
  plan approve OWNER/REPO docs/plans/PLAN.md COMMIT_SHA CONFIG.json
  plan list
  plan attention
  plan inspect PLAN_ID
  plan direction PLAN_ID "direction"
  plan direction PLAN_ID --associate ASSIGNMENT_ID PR_NUMBER HEAD_SHA "evidence"
  plan direction PLAN_ID --retry ASSIGNMENT_ID "reason for additional execution"
  plan stop PLAN_ID "reason"
  plan resume PLAN_ID "reason"`;

function summary(store: WorkflowStore, plan: PlanExecution) {
  const increment = currentIncrement(plan);
  const target = increment?.publication && {
    repository: plan.repository,
    pullRequest: increment.publication.pullRequest,
  };
  const workflow = target && store.findWorkflow(target.repository, target.pullRequest);
  const prAttention = workflow && store.prWorkflows().attention(workflow.id);
  const acceptance =
    plan.state === "running" &&
    target &&
    workflow?.state === "ready" &&
    workflow.githubStatus === "eligible"
      ? {
          reason: "The PR is ready for human acceptance.",
          action: "Inspect the exact head and merge in GitHub when accepted.",
          references: [pullUrl(target)],
          headSha: workflow.headSha,
        }
      : null;
  return {
    id: plan.id,
    repository: plan.repository,
    path: plan.path,
    revision: plan.revision,
    blobSha: plan.blobSha,
    baseBranch: plan.baseBranch,
    approvedAt: plan.approvedAt,
    state: plan.state,
    increment: increment?.number ?? null,
    totalIncrements: plan.increments.length,
    pullRequest: target?.pullRequest ?? null,
    workflowId: workflow?.id ?? null,
    workflowState: workflow?.state ?? null,
    attention: plan.attention ?? (prAttention || null) ?? acceptance,
  };
}

export async function runPlanCommand(
  args: string[],
  dbPath: string,
  makeReader: (
    store: WorkflowStore,
    repositories: GitHubRepository[],
    checkApps: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ) => Pick<PlanGitHubReader, "readPlanFile" | "readDefaultBranch">,
): Promise<boolean> {
  if (args[0] !== "plan") return false;
  const [, command, locator, ...details] = args;
  if (!command || command === "--help") {
    console.info(usage);
    return true;
  }
  const store = new WorkflowStore(dbPath);
  try {
    const plans = store.plans();
    const print = (value: unknown) => console.info(JSON.stringify(value, null, 2));
    if (command === "approve") {
      const repository = repositoryName(locator);
      if (!repository || details.length !== 3) throw new Error(usage);
      const [path, revision, configPath] = details as [string, string, string];
      const config = loadConfig(configPath);
      const target = config.repositories.find((entry) => entry.repository === repository);
      if (!target || !config.workflows.has(repository))
        throw new Error("Enable Phase D PR coordination for the approved repository.");
      const reader = makeReader(store, config.repositories, config.checkApps);
      print(summary(store, plans.approve(await loadApproval(reader, target, path, revision))));
      return true;
    }
    if (command === "list" || command === "attention") {
      if (locator !== undefined) throw new Error(usage);
      const executions = plans.list().map((plan) => summary(store, plan));
      print(command === "list" ? executions : executions.filter((item) => item.attention));
      return true;
    }
    if (!locator) throw new Error(usage);
    const plan = plans.get(locator);
    if (!plan) throw new Error(`Unknown plan execution ${locator}.`);
    if (command === "inspect") {
      if (details.length) throw new Error(usage);
      const executions = store.agentExecutions();
      print({
        ...summary(store, plan),
        increments: plan.increments.map((increment) => ({
          ...increment,
          workflow: increment.publication
            ? store.findWorkflow(plan.repository, increment.publication.pullRequest)
            : null,
          assignments: increment.assignments.map((assignment) => ({
            ...assignment,
            executions: executions.forAssignment(assignment.id),
          })),
        })),
        history: plan.history,
      });
      return true;
    }

    let updated: PlanExecution;
    if (command === "direction" && details[0] === "--associate" && details.length === 5) {
      const [, assignmentId, number, sha, reason] = details as [
        string,
        string,
        string,
        string,
        string,
      ];
      const pullRequest = Number(number);
      const headSha = commitSha(sha);
      if (!/^\d+$/.test(number) || !positiveInteger(pullRequest) || !headSha || !reason.trim())
        throw new Error(usage);
      updated = plans.operate(plan.id, {
        kind: "associate",
        assignmentId,
        pullRequest,
        headSha,
        reason: reason.trim(),
      });
    } else if (
      command === "direction" &&
      details[0] === "--retry" &&
      details.length === 3 &&
      details[2]!.trim()
    ) {
      updated = plans.operate(plan.id, {
        kind: "retry",
        assignmentId: details[1]!,
        reason: details[2]!.trim(),
      });
    } else if (
      (command === "direction" || command === "stop" || command === "resume") &&
      details.length === 1 &&
      details[0]!.trim()
    ) {
      updated = plans.operate(plan.id, { kind: command, reason: details[0]!.trim() });
    } else {
      throw new Error(usage);
    }
    print(summary(store, updated));
    return true;
  } finally {
    store.close();
  }
}
