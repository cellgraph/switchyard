import type { createAgentController } from "./agent-controller.ts";
import type { PrWorkflowConfig } from "./config.ts";
import type { GitHubReader, PullRequestTarget } from "./github-api.ts";
import { checkGitHubDrain, GitHubResponseError } from "./github-app.ts";
import {
  assignmentTurn,
  findingUrl,
  parseClaim,
  pullUrl,
  type AssignmentInput,
  type Disposition,
  type PrAssignment,
} from "./pr-assignments.ts";
import {
  candidatePublications,
  conflictingReply,
  loadPublications,
  publicationProof,
  type PublicationReader,
} from "./pr-evidence.ts";
import { PullRequestHeadChangedError, statusOf } from "./reconcile.ts";
import type { createRexExecution } from "./rex-execution.ts";
import type { WorkflowStore } from "./store.ts";
import { isActive, requiredChecksPass } from "./workflow.ts";

const retryDelayMs = 60_000;
const publicationGraceMs = 120_000;

type Dependencies = {
  store: WorkflowStore;
  github: PublicationReader & Pick<GitHubReader, "readPullRequest">;
  execute: ReturnType<typeof createAgentController>["execute"];
  inspect: ReturnType<typeof createRexExecution>["inspect"];
  now?: () => number;
};

export function createPrCoordinator({
  store,
  github,
  execute,
  inspect,
  now = Date.now,
}: Dependencies) {
  const pr = store.prWorkflows();
  const executions = store.agentExecutions();
  const reviews = store.reviews();

  return async (target: PullRequestTarget, config: PrWorkflowConfig, signal?: AbortSignal) => {
    const workflow = store.findWorkflow(target.repository, target.pullRequest);
    if (!isActive(workflow) || workflow.githubStatus !== "eligible") return false;
    checkGitHubDrain(signal);
    const guard = { workflow, version: pr.version(workflow.id) };
    const assignments = pr.list(workflow.id);
    const direction = pr.events(workflow.id).findLast((event) => event.kind === "direction");
    const pending = assignments.findLast((item) => !item.proof && !item.superseded);
    const reference = pullUrl(target);

    const pause = (reason: string, action: string, references: string[] = []) =>
      pr.pause(guard, { reason, action, references: [reference, ...references] });
    const wait = () => pr.setReady(guard, false);
    const assignmentRef = (assignment: PrAssignment) => `execution:${assignment.executionId}`;

    async function confirmHead() {
      checkGitHubDrain(signal);
      if (!pr.unchanged(guard)) return false;
      const latest = await github.readPullRequest(target, signal);
      checkGitHubDrain(signal);
      if (!pr.unchanged(guard)) return false;
      const status = statusOf(latest, target.repository);
      if (latest.headSha !== workflow!.headSha || status !== "eligible") {
        store.transition(workflow!.id, {
          type: "github_pull_request",
          status,
          sha: latest.headSha,
        });
        throw new PullRequestHeadChangedError();
      }
      return true;
    }

    async function dispatch(assignment: PrAssignment) {
      const configured = config[assignment.input.role];
      if (
        configured.agent.agentName !== assignment.agentName ||
        configured.producerId !== assignment.producerId
      ) {
        pause(
          "The reserved assignment's role configuration changed.",
          "Restore the named agent and GitHub identity before resuming.",
          [assignmentRef(assignment)],
        );
        return false;
      }
      const prior =
        assignment.input.role === "implementer"
          ? assignments.findLast(
              (item) =>
                item.id !== assignment.id &&
                item.input.role === "implementer" &&
                item.agentName === assignment.agentName &&
                item.producerId === assignment.producerId &&
                item.proof,
            )
          : undefined;
      const previousExecution = prior && executions.get(prior.executionId);
      const session = previousExecution ? executions.session(previousExecution.sessionId) : null;
      const rex = configured.agent.rex;
      const contextMatches =
        session?.rex &&
        rex &&
        session.rex.endpoint === rex.endpoint &&
        session.rex.executor === rex.executor &&
        session.rex.stateDirectory === rex.stateDirectory &&
        session.rex.node === rex.node &&
        session.rex.session === rex.session &&
        session.context.provider === configured.agent.context.provider &&
        session.context.workingDirectory === configured.agent.context.workingDirectory &&
        session.context.model === configured.agent.context.model &&
        session.context.configDirectory === configured.agent.context.configDirectory;
      const result = await execute({
        id: assignment.executionId,
        assignmentId: assignment.id,
        ...(contextMatches && session.nativeId ? { sessionId: session.id } : configured.agent),
        ...assignmentTurn(
          assignment,
          target,
          direction && direction.id <= assignment.operatorVersion ? direction.reason : undefined,
        ),
        ...(signal ? { signal } : {}),
        mayLaunch: () => !signal?.aborted && pr.unchanged(guard),
      });
      const claim = parseClaim(assignment, result.result?.structuredOutput);
      if (claim) pr.capture(assignment, claim);
      // A follow-up pass reconciles any result against a fresh PR and CI snapshot.
      return result.execution.status !== "not_started";
    }

    try {
      let execution = pending ? executions.get(pending.executionId) : null;
      if (
        pending &&
        execution?.remote &&
        (!pending.claim || execution.status !== "completed") &&
        execution.status !== "not_started"
      ) {
        executions.recoverRemotePrelaunch(execution.id);
        execution = executions.get(execution.id);
        if (execution?.status !== "not_started") {
          const recovered = await inspect(pending.executionId);
          execution = recovered.execution;
          const claim = parseClaim(pending, recovered.result?.structuredOutput);
          if (claim) {
            pr.capture(pending, claim);
            pending.claim = claim;
          }
          if (
            execution.status === "running" ||
            (execution.status === "unknown" && recovered.observation.process.state === "running")
          ) {
            wait();
            return false;
          }
        }
      }

      if (
        pending &&
        (execution?.status === "running" ||
          execution?.status === "unknown" ||
          execution?.status === "failed" ||
          (execution?.status === "completed" && !pending.claim))
      ) {
        const candidates =
          pending.input.role === "implementer"
            ? [`${reference}/commits/${workflow.headSha}`]
            : candidatePublications(
                target,
                await loadPublications(github, target, signal),
                pending,
              );
        pause(
          `Cannot establish a usable ${pending.input.role} outcome (${execution.status}).`,
          "Inspect the recorded execution and GitHub publication. Recover the same execution before resuming.",
          [assignmentRef(pending), ...candidates],
        );
        return false;
      }

      const hasPublications = assignments.some(
        (item) => !item.superseded && item.claim && item.input.role !== "implementer",
      );
      const snapshot = hasPublications
        ? await loadPublications(github, target, signal)
        : { reviews: [], comments: [] };
      const dispositions = new Map<number, { item: Disposition; assignment: PrAssignment }>();
      const verifiedReviews: Array<{
        assignment: PrAssignment;
        findingIds: number[];
        resolvedFindingIds: number[];
      }> = [];

      for (const assignment of assignments) {
        if (assignment.superseded || !assignment.claim) continue;
        const { claim } = assignment;
        const revision = "publishedHeadSha" in claim;
        if (revision && assignment.proof) continue;
        if (revision && claim.publishedHeadSha !== workflow.headSha) {
          if (workflow.headSha !== assignment.headSha) {
            // Another head is authoritative; any unresolved findings still follow it.
            pr.supersede(assignment);
            continue;
          }
        }
        let evidence;
        try {
          if (!revision || claim.publishedHeadSha === workflow.headSha)
            evidence = await publicationProof(github, target, snapshot, assignment, signal);
        } catch (error) {
          if (!(error instanceof GitHubResponseError) || error.status !== 404) throw error;
        }
        if (!evidence || (assignment.proof && evidence.proof !== assignment.proof)) {
          if (
            !assignment.proof &&
            execution?.finishedAt &&
            now() - Date.parse(execution.finishedAt) < publicationGraceMs
          ) {
            wait();
            return false;
          }
          pause(
            `GitHub publication for the ${assignment.input.role} assignment is missing, conflicting or changed.`,
            "Inspect the referenced GitHub publication and execution, restore corroborable evidence, and resume.",
            [assignmentRef(assignment)],
          );
          return false;
        }

        if ("reviewId" in claim) {
          if (!assignment.proof)
            reviews.record({
              id: assignment.id,
              workflowId: workflow.id,
              headSha: claim.headSha,
              githubReviewId: claim.reviewId,
              outcome: claim.outcome,
              completedAt: evidence.submittedAt!,
              findingCommentIds: claim.findingIds,
            });
          verifiedReviews.push({
            assignment,
            findingIds: claim.findingIds,
            resolvedFindingIds: claim.resolvedFindingIds,
          });
        } else if ("dispositions" in claim && assignment.input.role === "adjudicator") {
          const review = assignment.input.reviewId;
          for (const item of claim.dispositions) {
            if (!assignment.proof) {
              const saved = reviews.list(workflow.id).find((entry) => entry.id === review);
              const prior = saved?.findings.find(
                (finding) => finding.githubCommentId === item.findingId,
              );
              const reasoning = { kind: "review_comment" as const, id: item.replyId };
              const disposition =
                item.decision === "defer"
                  ? {
                      decision: item.decision,
                      reasoning,
                      issue: { repository: target.repository, number: item.issueNumber! },
                    }
                  : { decision: item.decision, reasoning };
              reviews.setDisposition(
                review,
                item.findingId,
                disposition,
                prior?.disposition ?? null,
              );
            }
            dispositions.set(item.findingId, { item, assignment });
          }
        }
        if (!assignment.proof) pr.corroborate(assignment, evidence.proof);
      }

      const conflict = [...dispositions.values()].find(({ item, assignment }) =>
        conflictingReply(snapshot, item, assignment),
      );
      if (conflict) {
        pause(
          "GitHub contains conflicting dispositions for a finding.",
          "Reconcile the published replies, then resume.",
          [findingUrl(target, conflict.item.findingId)],
        );
        return false;
      }

      const resolved = new Set(
        verifiedReviews
          .filter(({ assignment }) => assignment.headSha === workflow.headSha)
          .flatMap(({ resolvedFindingIds }) => resolvedFindingIds),
      );
      const accepted = [...dispositions.values()]
        .filter(({ item }) => item.decision === "accept" && !resolved.has(item.findingId))
        .map(({ item }) => item.findingId);
      const escalated = [...dispositions.values()].filter(
        ({ item }) => item.decision === "escalate",
      );
      const failedChecks = workflow.checks
        .filter(
          (item) =>
            item.sha === workflow.headSha &&
            item.outcome === "failed" &&
            workflow.requiredChecks?.includes(item.name),
        )
        .map((item) => item.name);
      const checksSettled = workflow.requiredChecks?.every((name) =>
        workflow.checks.some(
          (check) => check.name === name && ["passed", "failed"].includes(check.outcome),
        ),
      );
      let next: AssignmentInput | undefined;
      for (const { assignment, findingIds } of verifiedReviews) {
        const missing = findingIds.filter((id) => {
          const known = dispositions.get(id);
          return (
            !known ||
            (known.item.decision === "escalate" &&
              direction &&
              direction.id > known.assignment.operatorVersion)
          );
        });
        if (missing.length) {
          next = { role: "adjudicator", reviewId: assignment.id, findingIds: missing };
          break;
        }
      }
      const reviewed = verifiedReviews.some(
        ({ assignment }) => assignment.headSha === workflow.headSha,
      );
      if (!next && escalated.length) {
        pause(
          "An adjudicated finding requires operator judgment.",
          "Record direction for the Adjudicator, then resume.",
          escalated.map(({ item }) => findingUrl(target, item.findingId)),
        );
        return false;
      }
      if (!next && !reviewed) next = { role: "reviewer", previousFindingIds: accepted };
      if (!next && (accepted.length || failedChecks.length) && checksSettled)
        next = { role: "implementer", findingIds: accepted, failedChecks };
      if (!next) {
        if (pending && (!execution || execution.status === "not_started")) pr.supersede(pending);
        if (requiredChecksPass(workflow) && !accepted.length && (await confirmHead()))
          pr.setReady(guard, true);
        else wait();
        return false;
      }

      wait();
      const unlaunched =
        pending && (!execution || execution.status === "not_started") ? pending : undefined;
      const sameTask =
        unlaunched &&
        unlaunched.headSha === workflow.headSha &&
        JSON.stringify(unlaunched.input) === JSON.stringify(next) &&
        unlaunched.operatorVersion === guard.version;
      if (unlaunched && !sameTask) pr.supersede(unlaunched);
      if (pr.otherRunning(workflow.id)) return false;
      const { reviews: reviewSlots, revisions } = pr.allowances(workflow.id);
      if (!sameTask && next.role !== "adjudicator") {
        const noReview = reviewSlots.reservedOrUsed >= reviewSlots.authorized;
        const noRevision =
          next.role === "implementer" && revisions.reservedOrUsed >= revisions.authorized;
        if (noReview || noRevision) {
          pause(
            noReview
              ? "No Reviewer round remains for the required review."
              : "No Implementer revision remains for the required corrections.",
            "Authorize additional execution slots and resume when appropriate.",
          );
          return false;
        }
      }
      if (
        sameTask &&
        execution?.finishedAt &&
        now() - Date.parse(execution.finishedAt) < retryDelayMs
      )
        return false;
      if (!(await confirmHead())) return false;
      const { agent, producerId } = config[next.role];
      const assignment = sameTask
        ? execution
          ? pr.retry(guard, unlaunched)
          : unlaunched
        : pr.reserve(guard, next, agent.agentName, producerId);
      return assignment ? await dispatch(assignment) : false;
    } catch (error) {
      wait();
      throw error;
    }
  };
}
