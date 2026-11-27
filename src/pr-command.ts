import { loadConfig } from "./config.ts";
import { positiveInteger, repositoryName } from "./github-data.ts";
import { WorkflowStore } from "./store.ts";

const usage = `Usage:
  workflow list
  workflow attention
  workflow inspect OWNER/REPO#NUMBER
  workflow initiate OWNER/REPO#NUMBER CONFIG.json
  workflow direction OWNER/REPO#NUMBER "direction"
  workflow direction OWNER/REPO#NUMBER --abandon EXECUTION_ID "reason"
  workflow grant OWNER/REPO#NUMBER REVIEWS REVISIONS "reason"
  workflow resume OWNER/REPO#NUMBER "reason"
  workflow stop OWNER/REPO#NUMBER "reason"`;

export function runPrCommand(args: string[], dbPath: string): boolean {
  if (args[0] !== "workflow") return false;
  const [, command, locator, ...details] = args;
  if (!command || command === "--help") {
    console.info(usage);
    return true;
  }
  const store = new WorkflowStore(dbPath);
  try {
    const pr = store.prWorkflows();
    const summary = (workflow: NonNullable<ReturnType<WorkflowStore["getWorkflow"]>>) => ({
      ...workflow,
      allowances: pr.allowances(workflow.id),
      attention: pr.attention(workflow.id),
    });
    const print = (value: unknown) => console.info(JSON.stringify(value, null, 2));

    if (command === "list" || command === "attention") {
      if (locator !== undefined) throw new Error(usage);
      const workflows = store.listWorkflows().map(summary);
      print(
        command === "attention"
          ? workflows.filter((workflow) => workflow.attention !== null)
          : { workflows, queuedInitiations: pr.requests() },
      );
      return true;
    }

    const [rawRepository, rawNumber, extra] = locator?.split("#") ?? [];
    const repository = repositoryName(rawRepository);
    const pullRequest = Number(rawNumber);
    if (
      !repository ||
      !positiveInteger(pullRequest) ||
      !/^\d+$/.test(rawNumber ?? "") ||
      extra !== undefined
    )
      throw new Error(usage);
    if (command === "initiate") {
      if (details.length !== 1) throw new Error(usage);
      if (!loadConfig(details[0]!).workflows.has(repository))
        throw new Error("Enable PR coordination for the repository in the controller config.");
      pr.request(repository, pullRequest);
      print({ repository, pullRequest, initiation: "queued" });
      return true;
    }

    const workflow = store.findWorkflow(repository, pullRequest);
    if (!workflow) throw new Error(`Unknown workflow ${repository}#${pullRequest}.`);
    const { id } = workflow;
    switch (command) {
      case "inspect": {
        if (details.length !== 0) throw new Error(usage);
        const executions = store.agentExecutions();
        print({
          ...summary(workflow),
          assignments: pr.list(id).map((assignment) => ({
            ...assignment,
            executions: executions.forAssignment(assignment.id),
          })),
          reviews: store.reviews().list(id),
          operatorEvents: pr.events(id),
          transitions: store.transitions(id),
        });
        break;
      }
      case "direction":
        if (details[0] === "--abandon" && details.length === 3) {
          pr.operate(id, { kind: "abandon", executionId: details[1]!, reason: details[2]! });
        } else {
          if (details.length !== 1) throw new Error(usage);
          pr.operate(id, { kind: "direction", reason: details[0]! });
        }
        print(summary(store.getWorkflow(id)!));
        break;
      case "resume":
      case "stop":
        if (details.length !== 1) throw new Error(usage);
        pr.operate(id, { kind: command, reason: details[0]! });
        print(summary(store.getWorkflow(id)!));
        break;
      case "grant":
        if (details.length !== 3 || !details.slice(0, 2).every((value) => /^\d+$/.test(value)))
          throw new Error(usage);
        pr.operate(id, {
          kind: "grant",
          reviews: Number(details[0]),
          revisions: Number(details[1]),
          reason: details[2]!,
        });
        print(summary(store.getWorkflow(id)!));
        break;
      default:
        throw new Error(usage);
    }
    return true;
  } finally {
    store.close();
  }
}
