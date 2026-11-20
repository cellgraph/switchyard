import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentOperation,
  AgentOperationStatus,
  AgentRuntime,
  AgentSessionBinding,
  AgentTurnEvidence,
  AgentTurnIntent,
} from "./agent-operation.ts";
import type { Worktree } from "./worktree.ts";
import type { Workflow, WorkflowCommand } from "./workflow.ts";

type OperationRow = {
  input: string;
  status: AgentOperationStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
type SessionRecord = Omit<AgentSessionBinding, "reference">;

function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}

function eligible(workflow: Workflow | null, intent: AgentTurnIntent): boolean {
  return (
    workflow?.state === intent.mode &&
    workflow.headSha === intent.expectedPullRequestHead &&
    (workflow.state !== "fixing" ||
      (intent.expectedHead === workflow.headSha &&
        workflow.fixCycles < 3 &&
        workflow.review?.sha === workflow.headSha &&
        workflow.review.outcome === "completed_with_findings"))
  );
}

export function recoverAgentOperations(db: DatabaseSync): string[] {
  const now = new Date().toISOString();
  const claims = db
    .prepare(
      `SELECT operation_id, workflow_id, owner_pid FROM operations
     WHERE kind='durable_agent_turn' AND status IN ('dispatching','running')`,
    )
    .all() as { operation_id: string; workflow_id: string; owner_pid: number | null }[];
  const holdSession = db.prepare(
    `UPDATE agent_sessions SET execution=json_set(execution, '$.status', 'held', '$.updatedAt', ?)
     WHERE workflow_id=? AND execution IS NOT NULL`,
  );
  const markUnknown = db.prepare(
    `UPDATE operations SET status='unknown', error='Agent owner exited without a recorded outcome.',
     updated_at=? WHERE operation_id=?`,
  );
  const recovered: string[] = [];
  for (const claim of claims) {
    // A reused PID or missing ownership evidence is ambiguous. Only ESRCH proves
    // there is no local process left that could still commit the outcome.
    if (!claim.owner_pid || claim.owner_pid < 1) continue;
    try {
      process.kill(claim.owner_pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") continue;
      if (code !== "ESRCH") throw error;
      holdSession.run(now, claim.workflow_id);
      markUnknown.run(now, claim.operation_id);
      recovered.push(claim.workflow_id);
    }
  }
  return recovered;
}

export function createAgentOperationStore(
  db: DatabaseSync,
  {
    transaction,
    getWorkflow,
    transition,
  }: {
    transaction: <T>(run: () => T) => T;
    getWorkflow: (id: string) => Workflow | null;
    transition: (id: string, command: WorkflowCommand) => Workflow;
  },
) {
  function get(id: string): AgentOperation | null {
    const row = db
      .prepare("SELECT * FROM operations WHERE operation_id=? AND kind='durable_agent_turn'")
      .get(id) as OperationRow | undefined;
    return row
      ? {
          intent: decode(row.input),
          status: row.status,
          evidence: row.result === null ? null : decode(row.result),
          error: row.error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  function session(workflowId: string): AgentSessionBinding | null {
    const row = db
      .prepare(
        `SELECT s.session_id AS thread, s.execution AS session, w.execution AS worktree FROM agent_sessions s
       LEFT JOIN worktrees w USING (workflow_id) WHERE s.workflow_id=?`,
      )
      .get(workflowId) as
      { thread: string | null; session: string | null; worktree: string | null } | undefined;
    if (!row?.session) return null;
    const record = decode<SessionRecord>(row.session);
    return {
      ...record,
      reference:
        row.thread && record.runtime && row.worktree
          ? {
              agent: { id: row.thread, provider: record.runtime.provider },
              worktree: decode<Worktree>(row.worktree),
            }
          : null,
    };
  }

  function saveSession(workflowId: string, binding: AgentSessionBinding): void {
    const { reference, ...record } = binding;
    const providerThread = reference?.agent.id ?? null;
    db.prepare(
      `INSERT INTO agent_sessions (workflow_id, session_id, execution) VALUES (?, ?, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET session_id=excluded.session_id, execution=excluded.execution`,
    ).run(workflowId, providerThread, JSON.stringify(record));
    if (reference) {
      db.prepare(
        `INSERT INTO worktrees (workflow_id, path, execution) VALUES (?, ?, ?)
         ON CONFLICT(workflow_id) DO UPDATE SET path=excluded.path, execution=excluded.execution`,
      ).run(workflowId, reference.worktree.path, JSON.stringify(reference.worktree));
    }
  }

  function setStatus(
    id: string,
    from: AgentOperationStatus,
    to: AgentOperationStatus,
    evidence: AgentTurnEvidence | null,
    error: string | null = null,
  ): boolean {
    return (
      db
        .prepare(
          `UPDATE operations SET status=?, result=?, error=?, updated_at=?
       WHERE operation_id=? AND kind='durable_agent_turn' AND status=?`,
        )
        .run(to, evidence && JSON.stringify(evidence), error, new Date().toISOString(), id, from)
        .changes === 1
    );
  }

  function assertNoLegacyOperation(workflowId: string): void {
    if (
      db
        .prepare(
          "SELECT 1 FROM operations WHERE workflow_id=? AND status IN ('pending','ambiguous') LIMIT 1",
        )
        .get(workflowId)
    )
      throw new Error("Workflow has an unresolved external operation.");
  }

  // A close/reopen or head change can invalidate an authorization even if the
  // workflow later returns to the original state and SHA.
  function workflowRevision(id: string): number {
    return (
      db
        .prepare(
          `SELECT COALESCE(MAX(id), 0) AS revision FROM transitions WHERE workflow_id=?
       AND (from_state!=to_state OR reason LIKE 'head_changed to %' OR reason LIKE 'github_pull_request %')`,
        )
        .get(id) as { revision: number }
    ).revision;
  }

  function authorized(workflow: Workflow | null, intent: AgentTurnIntent): boolean {
    return (
      eligible(workflow, intent) && workflowRevision(intent.workflowId) === intent.workflowRevision
    );
  }

  return {
    get,
    session,

    request(input: Omit<AgentTurnIntent, "mode" | "workflowRevision">): AgentOperation {
      return transaction(() => {
        const existing = get(input.operationId);
        if (existing) {
          if (
            !isDeepStrictEqual(existing.intent, {
              ...input,
              mode: existing.intent.mode,
              workflowRevision: existing.intent.workflowRevision,
            })
          )
            throw new Error("Operation ID is already bound to a different request.");
          return existing;
        }
        if (db.prepare("SELECT 1 FROM operations WHERE operation_id=?").get(input.operationId))
          throw new Error("Operation ID is already in use.");
        const workflow = getWorkflow(input.workflowId);
        if (workflow?.state !== "awaiting_review" && workflow?.state !== "fixing")
          throw new Error("Workflow is not eligible for an agent turn.");
        const intent: AgentTurnIntent = {
          ...input,
          mode: workflow.state,
          workflowRevision: workflowRevision(workflow.id),
        };
        if (!eligible(workflow, intent))
          throw new Error("Workflow head or fix authorization does not match the request.");
        assertNoLegacyOperation(workflow.id);
        if (
          db
            .prepare(
              `SELECT 1 FROM operations WHERE workflow_id=? AND kind='durable_agent_turn' AND status!='completed' LIMIT 1`,
            )
            .get(workflow.id)
        )
          throw new Error("Workflow already has an unresolved agent operation.");
        const previous = session(workflow.id);
        if (
          !previous &&
          db
            .prepare(
              `SELECT 1 FROM agent_sessions WHERE workflow_id=? AND session_id IS NOT NULL
           UNION ALL SELECT 1 FROM worktrees WHERE workflow_id=?`,
            )
            .get(workflow.id, workflow.id)
        )
          throw new Error("Legacy agent session or worktree requires inspection before dispatch.");
        if (previous?.status === "held" || previous?.status === "starting")
          throw new Error("Agent session requires manual reconciliation.");
        if (!previous && intent.mode === "fixing")
          throw new Error("A fix requires an active implementation session.");
        if (!previous && intent.expectedHead !== workflow.headSha)
          throw new Error("The first agent turn must start at the recorded pull request head.");
        if (
          previous &&
          (previous.head !== intent.expectedHead ||
            previous.reference?.worktree.branch !== intent.branch)
        )
          throw new Error("Requested checkout does not match the recorded agent session.");

        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO operations (operation_id, workflow_id, kind, status, input, created_at, updated_at)
           VALUES (?, ?, 'durable_agent_turn', 'requested', ?, ?, ?)`,
        ).run(intent.operationId, intent.workflowId, JSON.stringify(intent), now, now);
        return get(intent.operationId)!;
      });
    },

    claim(id: string): { previous: AgentSessionBinding | null } | null {
      return transaction(() => {
        const operation = get(id);
        if (operation?.status !== "requested") return null;
        const { intent } = operation;
        if (!authorized(getWorkflow(intent.workflowId), intent)) {
          setStatus(
            id,
            "requested",
            "completed",
            null,
            "Workflow authorization changed before dispatch.",
          );
          return null;
        }
        assertNoLegacyOperation(intent.workflowId);
        const previous = session(intent.workflowId);
        if (!setStatus(id, "requested", "dispatching", null)) return null;
        db.prepare("UPDATE operations SET owner_pid=? WHERE operation_id=?").run(process.pid, id);
        if (!previous) {
          const now = new Date().toISOString();
          saveSession(intent.workflowId, {
            initialOperationId: id,
            lastOperationId: id,
            status: "starting",
            baseHead: intent.expectedHead,
            runtime: null,
            reference: null,
            head: null,
            checkpoint: null,
            createdAt: now,
            updatedAt: now,
          });
        }
        return { previous };
      });
    },

    start(id: string, runtime: AgentRuntime): boolean {
      return transaction(() => {
        const operation = get(id);
        return (
          operation?.status === "dispatching" &&
          authorized(getWorkflow(operation.intent.workflowId), operation.intent) &&
          setStatus(id, "dispatching", "running", { runtime })
        );
      });
    },

    authorizeLaunch(id: string): void {
      transaction(() => {
        const operation = get(id);
        if (
          operation?.status !== "running" ||
          operation.evidence?.launchAuthorizedAt ||
          !authorized(getWorkflow(operation.intent.workflowId), operation.intent)
        )
          throw new Error("Workflow authorization changed before the agent launched.");
        if (
          !setStatus(id, "running", "running", {
            ...operation.evidence,
            launchAuthorizedAt: new Date().toISOString(),
          })
        )
          throw new Error("Agent operation lost its dispatch authorization.");
      });
    },

    progress(
      id: string,
      evidence: Pick<AgentTurnEvidence, "reference" | "worktree" | "expectedWorktree">,
    ): void {
      transaction(() => {
        const current = get(id);
        if (
          current?.status !== "running" ||
          !setStatus(id, "running", "running", { ...current.evidence, ...evidence })
        )
          throw new Error("Agent operation lost its dispatch authorization.");
      });
    },

    finish(id: string, evidence: AgentTurnEvidence): AgentOperation {
      return transaction(() => {
        const current = get(id);
        if (!current || (current.status !== "running" && current.status !== "dispatching"))
          throw new Error("Agent operation is no longer in flight.");
        evidence = { ...current.evidence, ...evidence };
        const { intent } = current;
        const workflow = getWorkflow(intent.workflowId);
        const binding = session(intent.workflowId)!;
        const error =
          evidence.error ??
          (evidence.workspace && "error" in evidence.workspace
            ? evidence.workspace.error
            : undefined) ??
          evidence.agent?.reason ??
          (!authorized(workflow, intent)
            ? "Workflow authorization changed before outcome was recorded."
            : undefined) ??
          (binding.reference && !isDeepStrictEqual(binding.reference, evidence.reference)
            ? "Worker returned a different session or checkout."
            : undefined) ??
          (evidence.reference &&
          (evidence.reference.agent.provider !== evidence.runtime?.provider ||
            evidence.reference.worktree.workflowId !== intent.workflowId ||
            evidence.reference.worktree.branch !== intent.branch ||
            !isDeepStrictEqual(evidence.reference.worktree, evidence.worktree))
            ? "Worker returned conflicting session and checkout evidence."
            : undefined) ??
          (!evidence.runtime || !evidence.reference || !evidence.checkpoint || !evidence.workspace
            ? "Agent did not return the session and checkout evidence needed for continuation."
            : undefined);
        const outcome = evidence.agent?.outcome;
        const confirmed =
          Boolean(current.evidence?.launchAuthorizedAt) && outcome === "completed" && !error;
        let status: AgentOperationStatus = "manual_reconciliation";
        if (confirmed || outcome === "failed") status = "completed";
        if (outcome === "interrupted" || outcome === "unknown") status = outcome;
        const reason = confirmed ? null : (error ?? "Agent turn requires manual reconciliation.");
        if (!setStatus(id, current.status, status, evidence, reason))
          throw new Error("Agent operation lost its dispatch authorization.");
        saveSession(intent.workflowId, {
          ...binding,
          lastOperationId: id,
          status: confirmed ? "active" : "held",
          runtime: binding.runtime ?? evidence.runtime ?? null,
          reference: binding.reference ?? evidence.reference ?? null,
          head:
            confirmed && evidence.workspace && "head" in evidence.workspace
              ? evidence.workspace.head
              : binding.head,
          checkpoint: confirmed ? evidence.checkpoint! : binding.checkpoint,
          updatedAt: new Date().toISOString(),
        });

        if (confirmed && intent.mode === "fixing")
          transition(intent.workflowId, { type: "validation_started" });
        else if (
          reason &&
          workflow &&
          workflow.state !== "escalated" &&
          (workflow.state !== "stopped" || workflow.closedByGitHub)
        )
          transition(intent.workflowId, { type: "escalate", reason });
        return get(id)!;
      });
    },
  };
}
