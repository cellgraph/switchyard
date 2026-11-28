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
  type PriorReview,
} from "./pr-assignments.ts";
import {
  candidatePublications,
  conflictingReply,
  conflictingReviews,
  includesCommit,
  loadPublications,
  publicationProof,
  verifiedOriginalFinding,
  verifyDisposition,
  type PublicationReader,
} from "./pr-evidence.ts";
import { PullRequestHeadChangedError, statusOf, type createReconciler } from "./reconcile.ts";
import type { createRexExecution } from "./rex-execution.ts";
import type { WorkflowStore } from "./store.ts";
import { isActive, requiredChecksPass, type Workflow } from "./workflow.ts";

const retryDelayMs = 60_000;
const publicationGraceMs = 120_000;

type Dependencies = {
  store: WorkflowStore;
  github: PublicationReader & Pick<GitHubReader, "readPullRequest">;
  reconcile: ReturnType<typeof createReconciler>;
  execute: ReturnType<typeof createAgentController>["execute"];
  inspect: ReturnType<typeof createRexExecution>["inspect"];
  otherExecutions?: () => string[];
  now?: () => number;
};

function requiredCheckState(workflow: Workflow) {
  const required = workflow.checks.filter(
    (check) => check.sha === workflow.headSha && workflow.requiredChecks?.includes(check.name),
  );
  return {
    failedChecks: required.filter(({ outcome }) => outcome === "failed").map(({ name }) => name),
    checksPending: required.some(({ outcome }) => outcome === "pending"),
  };
}

export function createPrCoordinator({
  store,
  github,
  reconcile,
  execute,
  inspect,
  otherExecutions = () => [],
  now = Date.now,
}: Dependencies) {
  const pr = store.prWorkflows();
  const executions = store.agentExecutions();

  async function inspectExisting(id: string) {
    executions.recoverRemotePrelaunch(id);
    const execution = executions.get(id)!;
    return execution.status === "not_started" ? { execution } : await inspect(id);
  }

  async function reconcileOtherExecutions(workflowId: string) {
    for (const id of [...pr.blockingExecutions(workflowId), ...otherExecutions()]) {
      const result = await inspectExisting(id);
      // A correlated process exit can free this placement for other PRs. The original
      // assignment still needs native evidence or an operator decision.
      if (
        (result.execution.status === "running" || result.execution.status === "unknown") &&
        !result.execution.remote?.resultDigest &&
        (!("observation" in result) || result.observation.process.state !== "exited")
      )
        return false;
    }
    return true;
  }

  return async (
    target: PullRequestTarget,
    configuration?: PrWorkflowConfig,
    signal?: AbortSignal,
    gate?: {
      allows: () => boolean;
      confirm: (headSha: string) => Promise<boolean>;
      implementationExecutionId?: string;
      implementationProducerId?: number;
      context?: string;
    },
  ) => {
    const workflow = store.findWorkflow(target.repository, target.pullRequest);
    if (!workflow) return false;
    checkGitHubDrain(signal);
    const guard = { workflow, version: pr.version(workflow.id) };
    const assignments = pr.list(workflow.id);
    const pending = assignments.findLast((item) => !item.proof && !item.superseded);
    if (
      !configuration ||
      !isActive(workflow) ||
      workflow.githubStatus !== "eligible" ||
      gate?.allows() === false
    ) {
      if (workflow.state === "ready") pr.setReady(guard, false);
      if (pending && pr.needsExecutionRecovery(workflow.id)) {
        const observed = await inspectExisting(pending.executionId);
        if ("observation" in observed) {
          const claim = parseClaim(pending, observed.result?.structuredOutput);
          if (claim) pr.capture(pending, claim);
        }
      }
      return false;
    }
    const config = configuration;
    const events = pr.events(workflow.id);
    const direction = events.findLast(
      (event) => event.kind === "direction" || event.kind === "replace_evidence",
    );
    const reference = pullUrl(target);

    const pause = (reason: string, action: string, references: string[] = []) =>
      pr.pause(guard, { reason, action, references: [reference, ...references] });
    const wait = () => pr.setReady(guard, false);
    const assignmentRef = (assignment: PrAssignment) => `execution:${assignment.executionId}`;

    async function confirmHead() {
      checkGitHubDrain(signal);
      if (!pr.unchanged(guard) || gate?.allows() === false) return false;
      const latest = await github.readPullRequest(target, signal);
      checkGitHubDrain(signal);
      if (!pr.unchanged(guard)) return false;
      const status = statusOf(latest, target.repository);
      if (latest.headSha !== guard.workflow.headSha || status !== "eligible") {
        store.transition(guard.workflow.id, {
          type: "github_pull_request",
          status,
          sha: latest.headSha,
        });
        throw new PullRequestHeadChangedError();
      }
      return !gate || (await gate.confirm(latest.headSha));
    }

    async function refreshChecks() {
      checkGitHubDrain(signal);
      if (!pr.unchanged(guard) || gate?.allows() === false) return false;
      await reconcile(target, signal, false);
      if (gate && !(await gate.confirm(guard.workflow.headSha))) return false;
      checkGitHubDrain(signal);
      return pr.unchanged(guard);
    }

    async function dispatch(assignment: PrAssignment, priorReview?: PriorReview) {
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
                item.producerId === assignment.producerId,
            )
          : undefined;
      const previousId = prior
        ? prior.proof
          ? prior.executionId
          : undefined
        : assignment.input.role === "implementer" &&
            configured.producerId === gate?.implementationProducerId
          ? gate?.implementationExecutionId
          : undefined;
      const previousExecution = previousId ? executions.get(previousId) : null;
      const session =
        previousExecution?.status === "completed"
          ? executions.session(previousExecution.sessionId)
          : null;
      const rex = configured.agent.rex;
      const contextMatches =
        session?.agentName === configured.agent.agentName &&
        session?.rex &&
        rex &&
        session.rex.endpoint === rex.endpoint &&
        session.rex.executable === rex.executable &&
        session.rex.executor === rex.executor &&
        session.rex.stateDirectory === rex.stateDirectory &&
        session.rex.node === rex.node &&
        session.rex.session === rex.session &&
        session.context.provider === configured.agent.context.provider &&
        session.context.workingDirectory === configured.agent.context.workingDirectory &&
        session.context.model === configured.agent.context.model &&
        session.context.configDirectory === configured.agent.context.configDirectory;
      const requiredFailures =
        assignment.input.role === "implementer" ? assignment.input.failedChecks : [];
      let ciChanged = false;
      function ciStillApplies() {
        const current = store.getWorkflow(guard.workflow.id)!;
        const { failedChecks, checksPending } = requiredCheckState(current);
        ciChanged =
          checksPending ||
          failedChecks.length !== requiredFailures.length ||
          requiredFailures.some((name) => !failedChecks.includes(name));
        return !ciChanged;
      }
      const turn = assignmentTurn(
        assignment,
        target,
        direction && direction.id <= assignment.operatorVersion ? direction.reason : undefined,
        priorReview,
      );
      const result = await execute({
        id: assignment.executionId,
        assignmentId: assignment.id,
        ...(contextMatches && session.nativeId ? { sessionId: session.id } : configured.agent),
        ...turn,
        prompt: gate?.context ? `${turn.prompt}\n${gate.context}` : turn.prompt,
        ...(signal ? { signal } : {}),
        confirmLaunch: requiredFailures.length
          ? async () => (await refreshChecks()) && ciStillApplies()
          : confirmHead,
        mayLaunch: () =>
          !signal?.aborted &&
          gate?.allows() !== false &&
          pr.unchanged(guard) &&
          (!requiredFailures.length || ciStillApplies()),
        waitForResult: false,
      });
      const claim = parseClaim(assignment, result.result?.structuredOutput);
      if (claim) pr.capture(assignment, claim);
      if (result.execution.status === "not_started" && ciChanged) return pr.unchanged(guard);
      if (result.execution.status === "not_started" && !signal?.aborted && pr.unchanged(guard))
        throw new Error(
          `Rex assignment ${assignment.executionId} did not start: ${result.execution.reason ?? "No launch evidence."}`,
        );
      // A follow-up pass reconciles any result against a fresh PR and CI snapshot.
      return result.execution.status !== "not_started" && result.execution.status !== "running";
    }

    try {
      let execution = pending ? executions.get(pending.executionId) : null;
      const proposedRecovery = pending
        ? events.findLast(
            (event) =>
              event.recovery?.executionId === pending.executionId && !event.recovery.confirmedBy,
          )
        : undefined;
      // A new resume after a refused recovery needs fresh operator evidence.
      const request =
        proposedRecovery &&
        events.filter((event) => event.kind === "resume" && event.id > proposedRecovery.id)
          .length === 1
          ? proposedRecovery
          : undefined;
      let recovery: Parameters<typeof pr.corroborate>[4];
      if (
        pending &&
        execution?.remote &&
        (!pending.claim || execution.status !== "completed") &&
        execution.status !== "not_started"
      ) {
        const recovered = await inspectExisting(execution.id);
        execution = recovered.execution;
        if ("observation" in recovered) {
          if (recovered.observation.evidence === "conflicting") {
            pause(
              "Rex evidence conflicts with the recorded execution.",
              "Inspect the original Rex block and result, then resume after resolving the conflict.",
              [assignmentRef(pending)],
            );
            return false;
          }
          const claim = parseClaim(pending, recovered.result?.structuredOutput);
          if (claim) {
            pr.capture(pending, claim);
            pending.claim = claim;
          }
          const process = recovered.observation.process;
          if (
            execution.status === "unknown" &&
            !execution.remote?.resultDigest &&
            request?.recovery
          ) {
            const confirmedBy =
              process.state === "exited" && execution.remote?.blockId
                ? { blockId: execution.remote.blockId }
                : process.state === "unavailable" && request.recovery.attestQuiescent
                  ? { operatorAttested: true as const }
                  : null;
            if (confirmedBy)
              recovery = { id: request.id, claim: request.recovery.claim, confirmedBy };
            else {
              pause(
                "Cannot establish quiescence for workflow outcome recovery.",
                "Confirm the original Rex block or native session has stopped, then submit recovery evidence again before resuming.",
                [assignmentRef(pending)],
              );
              return false;
            }
          }
          if (
            execution.status === "running" ||
            (execution.status === "unknown" && process.state === "running")
          ) {
            wait();
            return false;
          }
        }
      }

      if (
        pending &&
        !recovery &&
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
          execution.status === "unknown"
            ? "Inspect the original execution. If it has stopped and its publication exists, submit it with workflow direction --recover-outcome, then resume."
            : "Inspect the recorded execution and GitHub publication before resuming.",
          [assignmentRef(pending), ...candidates],
        );
        return false;
      }

      const hasPublications =
        (recovery && pending?.input.role !== "implementer") ||
        assignments.some(
          (item) =>
            item.claim &&
            item.input.role !== "implementer" &&
            (!item.superseded ||
              (item.proof && "reviewId" in item.claim && item.claim.findingIds.length > 0)),
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

      const replacedReviews = new Map<string, { assignment: PrAssignment; findingIds: number[] }>();
      const supersededReviewIds = new Set<number>();
      const historicalDispositions = new Map<
        number,
        { item: Disposition; assignment: PrAssignment }
      >();
      for (const assignment of assignments) {
        const { claim, proof } = assignment;
        if (proof && claim && "dispositions" in claim) {
          for (const item of claim.dispositions)
            historicalDispositions.set(item.findingId, { item, assignment });
        }
      }
      for (const assignment of assignments) {
        if (!assignment.superseded || !assignment.claim || !("reviewId" in assignment.claim))
          continue;
        supersededReviewIds.add(assignment.claim.reviewId);
        if (assignment.proof)
          replacedReviews.set(assignment.id, {
            assignment,
            findingIds: assignment.claim.findingIds,
          });
      }
      let priorReview: PriorReview | undefined;
      for (const assignment of assignments) {
        const recovered = assignment.id === pending?.id ? recovery : undefined;
        const claim = recovered?.claim ?? assignment.claim;
        if (
          assignment.superseded ||
          !claim ||
          (assignment.proof &&
            assignment.input.role === "adjudicator" &&
            (replacedReviews.has(assignment.input.reviewId) ||
              ("dispositions" in claim &&
                claim.dispositions.every(
                  ({ findingId }) =>
                    historicalDispositions.get(findingId)?.assignment.id !== assignment.id,
                ))))
        )
          continue;
        if (
          !recovered &&
          "reviewId" in claim &&
          claim.outcome === "clean" &&
          claim.headSha !== workflow.headSha
        ) {
          // An old clean review can guide scope but carries no findings or readiness forward.
          if (!assignment.proof) {
            pr.supersede(guard, assignment);
          } else if (!conflictingReviews(snapshot, assignment, claim, supersededReviewIds).length) {
            const evidence = await publicationProof(github, target, snapshot, assignment, signal);
            if (evidence?.proof === assignment.proof)
              priorReview = { headSha: claim.headSha, reviewId: claim.reviewId };
          }
          continue;
        }
        const revision = "publishedHeadSha" in claim;
        if (revision && assignment.proof) continue;
        if ("reviewId" in claim) {
          const conflicts = conflictingReviews(snapshot, assignment, claim, supersededReviewIds);
          if (conflicts.length) {
            pause(
              "GitHub contains contradictory reviews from the trusted Reviewer.",
              "Inspect all referenced reviews. Have the Reviewer reconcile its GitHub publications, then resume. If appropriate, explicitly abandon the terminal assignment or replace its corroborated evidence while held.",
              [
                assignmentRef(assignment),
                ...[claim.reviewId, ...conflicts].map(
                  (id) => `${reference}#pullrequestreview-${id}`,
                ),
              ],
            );
            return false;
          }
        }
        let evidence;
        try {
          let retained: boolean | null = true;
          if (revision) {
            retained = false;
            if (workflow.headSha !== assignment.headSha) {
              retained = await includesCommit(
                github,
                target,
                claim.publishedHeadSha,
                workflow.headSha,
                signal,
              );
              if (retained === false && !recovered) {
                // The current head replaced the claimed commit; findings still follow the current head.
                pr.supersede(guard, assignment);
                continue;
              }
            }
          }
          if (retained)
            evidence = await publicationProof(
              github,
              target,
              snapshot,
              { ...assignment, claim },
              signal,
            );
        } catch (error) {
          if (!(error instanceof GitHubResponseError) || error.status !== 404) throw error;
        }
        if (!evidence || (assignment.proof && evidence.proof !== assignment.proof)) {
          if (
            !recovered &&
            !assignment.proof &&
            execution?.finishedAt &&
            now() - Date.parse(execution.finishedAt) < publicationGraceMs
          ) {
            wait();
            return false;
          }
          pause(
            `GitHub publication for the ${assignment.input.role} assignment is missing, conflicting or changed.`,
            recovered
              ? "Inspect the references, submit corrected publication evidence with workflow direction --recover-outcome, and resume."
              : "Inspect the referenced GitHub publication and execution, restore corroborable evidence, and resume.",
            [assignmentRef(assignment)],
          );
          return false;
        }

        if (!assignment.proof) {
          const submittedAt = evidence.submittedAt;
          const recorded = pr.corroborate(
            guard,
            assignment,
            evidence.proof,
            (reviews) => {
              if ("reviewId" in claim) {
                reviews.record({
                  id: assignment.id,
                  workflowId: workflow.id,
                  headSha: claim.headSha,
                  githubReviewId: claim.reviewId,
                  outcome: claim.outcome,
                  completedAt: submittedAt!,
                  findingCommentIds: claim.findingIds,
                });
              } else if ("dispositions" in claim && assignment.input.role === "adjudicator") {
                const review = assignment.input.reviewId;
                const saved = reviews.list(workflow.id).find((entry) => entry.id === review);
                for (const item of claim.dispositions) {
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
              }
            },
            recovered,
          );
          if (!recorded) return true;
        }
        if ("reviewId" in claim) {
          if (claim.headSha !== workflow.headSha)
            priorReview = { headSha: claim.headSha, reviewId: claim.reviewId };
          verifiedReviews.push({
            assignment,
            findingIds: claim.findingIds,
            resolvedFindingIds: claim.resolvedFindingIds,
          });
        } else if ("dispositions" in claim) {
          for (const item of claim.dispositions) {
            if (
              !assignment.proof ||
              historicalDispositions.get(item.findingId)?.assignment.id === assignment.id
            )
              dispositions.set(item.findingId, { item, assignment });
          }
        }
      }

      const resolved = new Set(
        verifiedReviews
          .filter(({ assignment }) => assignment.headSha === workflow.headSha)
          .flatMap(({ resolvedFindingIds }) => resolvedFindingIds),
      );
      const needsReplacement: number[] = [];
      let renewedAdjudication: AssignmentInput | undefined;
      for (const { assignment, findingIds } of replacedReviews.values()) {
        const needsAdjudication: number[] = [];
        for (const id of findingIds) {
          if (resolved.has(id)) continue;
          const fresh = dispositions.get(id);
          const latest = historicalDispositions.get(id);
          const prior = fresh ?? (latest?.assignment.superseded ? undefined : latest);
          const rootVerified = verifiedOriginalFinding(snapshot, assignment, id);
          if (!rootVerified) {
            const rootPresent = snapshot.comments.some(
              (item) => item?.id === id && item.in_reply_to_id == null,
            );
            if (rootPresent) {
              dispositions.delete(id);
              needsReplacement.push(id);
              continue;
            }
            if (prior?.item.decision === "reject") continue;
          }
          if (
            prior &&
            (rootVerified || prior.item.decision === "defer") &&
            (fresh ||
              (await verifyDisposition(
                github,
                target,
                snapshot,
                prior.assignment,
                prior.item,
                signal,
              )))
          ) {
            dispositions.set(id, prior);
            if (
              prior.item.decision === "escalate" &&
              direction &&
              direction.id > prior.assignment.operatorVersion
            )
              needsAdjudication.push(id);
            continue;
          }
          if (rootVerified) needsAdjudication.push(id);
          else needsReplacement.push(id);
        }
        if (!renewedAdjudication && needsAdjudication.length)
          renewedAdjudication = {
            role: "adjudicator",
            reviewId: assignment.id,
            findingIds: needsAdjudication,
          };
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

      const accepted = [...dispositions.values()]
        .filter(({ item }) => item.decision === "accept" && !resolved.has(item.findingId))
        .map(({ item }) => item.findingId);
      const escalated = [...dispositions.values()].filter(
        ({ item }) => item.decision === "escalate",
      );
      const { failedChecks, checksPending } = requiredCheckState(workflow);
      let next: AssignmentInput | undefined = renewedAdjudication;
      for (const { assignment, findingIds } of verifiedReviews) {
        if (next) break;
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
      if (!next && !reviewed)
        next = { role: "reviewer", previousFindingIds: [...accepted, ...needsReplacement] };
      if (!next && (accepted.length || failedChecks.length) && !checksPending)
        next = { role: "implementer", findingIds: accepted, failedChecks };
      if (!next && needsReplacement.length) {
        pause(
          "The current review does not account for all findings from replaced evidence.",
          "Record the missing finding context and request replacement of the incomplete review evidence.",
          needsReplacement.map((id) => findingUrl(target, id)),
        );
        return false;
      }
      if (!next) {
        if (pending && (!execution || execution.status === "not_started"))
          pr.supersede(guard, pending);
        if (requiredChecksPass(workflow) && !accepted.length && (await refreshChecks())) {
          const passes = requiredChecksPass(store.getWorkflow(workflow.id)!);
          pr.setReady(guard, passes);
          return !passes;
        }
        wait();
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
      if (unlaunched && !sameTask) pr.supersede(guard, unlaunched);
      if (!(await reconcileOtherExecutions(workflow.id))) return false;
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
      return assignment ? await dispatch(assignment, priorReview) : false;
    } catch (error) {
      wait();
      throw error;
    }
  };
}
