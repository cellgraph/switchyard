import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  parseClaim,
  type AssignmentClaim,
  type AssignmentInput,
  type PrAssignment,
} from "./pr-assignments.ts";
import { createReviewStore } from "./review-store.ts";
import {
  isOperatorHeld,
  requiredChecksPass,
  type Workflow,
  type WorkflowCommand,
} from "./workflow.ts";

export const prSchema = `
  CREATE TABLE pr_initiations (
    repository TEXT NOT NULL COLLATE NOCASE, pull_request INTEGER NOT NULL, requested_at TEXT NOT NULL,
    PRIMARY KEY(repository, pull_request)
  );
  CREATE TABLE pr_assignments (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    head_sha TEXT NOT NULL, agent_name TEXT NOT NULL, producer_id INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    operator_version INTEGER NOT NULL, input TEXT NOT NULL, claim TEXT, proof TEXT, superseded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX pr_assignments_by_workflow ON pr_assignments(workflow_id);
  CREATE TABLE pr_operator_events (
    id INTEGER PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    kind TEXT NOT NULL, reason TEXT NOT NULL, review_slots INTEGER NOT NULL DEFAULT 0,
    revision_slots INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE pr_attention (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id),
    reason TEXT NOT NULL, action TEXT NOT NULL, references_json TEXT NOT NULL
  );
`;

export type Attention = { reason: string; action: string; references: string[] };
type OperatorAction =
  | { kind: "direction" | "resume" | "stop"; reason: string }
  | { kind: "abandon" | "replace_evidence"; executionId: string; reason: string }
  | {
      kind: "recover_outcome";
      executionId: string;
      publication: unknown;
      attestQuiescent: boolean;
      reason: string;
    }
  | { kind: "grant"; reason: string; reviews: number; revisions: number };

type Guard = { workflow: Workflow; version: number };
type Quiescence = { blockId: string } | { operatorAttested: true };
type OutcomeRecovery = {
  executionId: string;
  claim: AssignmentClaim;
  attestQuiescent: boolean;
  reason: string;
  confirmedBy?: Quiescence;
};

export function createPrStore(
  db: DatabaseSync,
  transaction: <T>(run: () => T) => T,
  findWorkflow: (id: string) => Workflow | null,
  transition: (id: string, command: WorkflowCommand) => Workflow,
) {
  function version(id: string): number {
    return Number(
      db.prepare("SELECT max(id) AS id FROM pr_operator_events WHERE workflow_id=?").get(id)?.id ??
        0,
    );
  }

  function unchanged({ workflow, version: expected }: Guard): boolean {
    const current = findWorkflow(workflow.id);
    return (
      current?.githubStatus === "eligible" &&
      current.headSha === workflow.headSha &&
      !isOperatorHeld(current) &&
      version(workflow.id) === expected
    );
  }

  function attention(id: string): Attention | null {
    const row = db.prepare("SELECT * FROM pr_attention WHERE workflow_id=?").get(id);
    return row
      ? {
          reason: String(row.reason),
          action: String(row.action),
          references: JSON.parse(String(row.references_json)) as string[],
        }
      : null;
  }

  function writeAttention(id: string, entry: Attention) {
    db.prepare(
      `
      INSERT INTO pr_attention(workflow_id, reason, action, references_json) VALUES (?,?,?,?)
      ON CONFLICT(workflow_id) DO UPDATE SET reason=excluded.reason, action=excluded.action,
        references_json=excluded.references_json
    `,
    ).run(id, entry.reason, entry.action, JSON.stringify(entry.references));
  }

  return {
    request(repository: string, pullRequest: number) {
      db.prepare("INSERT OR IGNORE INTO pr_initiations VALUES (?,?,?)").run(
        repository,
        pullRequest,
        new Date().toISOString(),
      );
    },
    requests(repository?: string) {
      return (
        repository === undefined
          ? db.prepare("SELECT * FROM pr_initiations ORDER BY repository, pull_request").all()
          : db
              .prepare("SELECT * FROM pr_initiations WHERE repository=? ORDER BY pull_request")
              .all(repository)
      ).map((row) => ({
        repository: String(row.repository),
        pullRequest: Number(row.pull_request),
        requestedAt: String(row.requested_at),
      }));
    },
    acknowledge(repository: string, pullRequest: number) {
      db.prepare("DELETE FROM pr_initiations WHERE repository=? AND pull_request=?").run(
        repository,
        pullRequest,
      );
    },
    version,
    unchanged,
    attention,
    events(id: string) {
      const rows = db
        .prepare(
          `
        SELECT id, kind, reason, review_slots AS reviews, revision_slots AS revisions,
          created_at AS createdAt FROM pr_operator_events WHERE workflow_id=? ORDER BY id
      `,
        )
        .all(id) as {
        id: number;
        kind: OperatorAction["kind"];
        reason: string;
        reviews: number;
        revisions: number;
        createdAt: string;
      }[];
      return rows.map((event) => {
        if (event.kind !== "recover_outcome") return { ...event, recovery: undefined };
        const recovery = JSON.parse(event.reason) as OutcomeRecovery;
        return { ...event, reason: recovery.reason, recovery };
      });
    },
    operate(id: string, action: OperatorAction) {
      return transaction(() => {
        const workflow = findWorkflow(id);
        if (!workflow) throw new Error(`Unknown workflow ${id}.`);
        if (action.kind === "resume" && !isOperatorHeld(workflow))
          throw new Error("Only a workflow on operator hold can be resumed.");
        if (!action.reason.trim() || action.reason.length > 4000)
          throw new Error("Provide a reason of 1 to 4000 characters.");
        const slots =
          action.kind === "grant"
            ? ([action.reviews, action.revisions] as const)
            : ([0, 0] as const);
        if (
          slots.some((value) => !Number.isSafeInteger(value) || value < 0) ||
          (action.kind === "grant" && slots.every((value) => value === 0))
        )
          throw new Error("Grant a positive number of review or revision slots.");
        const replacing = action.kind === "replace_evidence";
        if (action.kind === "abandon" || replacing) {
          const eligible = db
            .prepare(
              `
            SELECT assignment.id, assignment.proof, json_extract(assignment.input,'$.role') AS role
            FROM pr_assignments AS assignment
            JOIN agent_executions AS execution ON execution.id=assignment.execution_id
            WHERE assignment.workflow_id=? AND assignment.execution_id=?
              AND assignment.superseded=0
              AND (execution.status IN ('failed','completed')
                OR (execution.status='unknown' AND assignment.proof IS NOT NULL))
          `,
            )
            .get(id, action.executionId);
          const replaceable = eligible?.proof && eligible.role !== "implementer";
          if (
            !isOperatorHeld(workflow) ||
            !eligible ||
            (replacing ? !replaceable : eligible.proof !== null)
          )
            throw new Error(
              replacing
                ? "Replacement requires a held workflow and a corroborated review or adjudication."
                : "Abandonment requires a held, terminal execution without corroborated publication evidence.",
            );
          db.prepare("UPDATE pr_assignments SET superseded=1 WHERE id=?").run(eligible.id!);
        }
        let reason =
          action.kind === "abandon" || action.kind === "replace_evidence"
            ? `${action.executionId}: ${action.reason}`
            : action.reason;
        if (action.kind === "recover_outcome") {
          const assignment = this.list(id).findLast((item) => !item.proof && !item.superseded);
          const unresolved = db
            .prepare(
              `SELECT 1 FROM agent_executions WHERE id=? AND status='unknown'
               AND remote_key IS NOT NULL AND remote_launch_authorized=1
               AND remote_result_digest IS NULL`,
            )
            .get(action.executionId);
          if (
            !isOperatorHeld(workflow) ||
            assignment?.executionId !== action.executionId ||
            !unresolved
          )
            throw new Error(
              "Recovery requires a held workflow and its outstanding unknown Rex execution.",
            );
          const claim = parseClaim(assignment, action.publication);
          if (!claim)
            throw new Error("Provide valid publication references for the original assignment.");
          reason = JSON.stringify({
            executionId: action.executionId,
            claim,
            attestQuiescent: action.attestQuiescent,
            reason: action.reason,
          } satisfies OutcomeRecovery);
        }
        db.prepare(
          "INSERT INTO pr_operator_events(workflow_id,kind,reason,review_slots,revision_slots,created_at) VALUES (?,?,?,?,?,?)",
        ).run(id, action.kind, reason, ...slots, new Date().toISOString());
        if (action.kind === "stop") {
          transition(id, { type: "stop", reason: action.reason });
          writeAttention(id, {
            reason: action.reason,
            action: "Resume when the workflow should continue.",
            references: [workflow.id],
          });
        }
        if (action.kind === "resume") {
          transition(id, { type: "resume", reason: action.reason });
          db.prepare("DELETE FROM pr_attention WHERE workflow_id=?").run(id);
        }
      });
    },
    pause(guard: Guard, entry: Attention) {
      transaction(() => {
        if (!unchanged(guard)) return;
        transition(guard.workflow.id, { type: "escalate", reason: entry.reason });
        writeAttention(guard.workflow.id, entry);
      });
    },
    setReady(guard: Guard, ready: boolean) {
      transaction(() => {
        if (!unchanged(guard)) return;
        const current = findWorkflow(guard.workflow.id)!;
        transition(current.id, { type: "readiness", ready: ready && requiredChecksPass(current) });
      });
    },
    list(workflowId: string): PrAssignment[] {
      return db
        .prepare("SELECT * FROM pr_assignments WHERE workflow_id=? ORDER BY rowid")
        .all(workflowId)
        .map((row) => ({
          id: String(row.id),
          workflowId,
          headSha: String(row.head_sha),
          agentName: String(row.agent_name),
          producerId: Number(row.producer_id),
          executionId: String(row.execution_id),
          createdAt: String(row.created_at),
          operatorVersion: Number(row.operator_version),
          input: JSON.parse(String(row.input)) as AssignmentInput,
          claim: row.claim === null ? null : (JSON.parse(String(row.claim)) as AssignmentClaim),
          proof: row.proof === null ? null : String(row.proof),
          superseded: Boolean(row.superseded),
        }));
    },
    reserve(
      guard: Guard,
      input: AssignmentInput,
      agentName: string,
      producerId: number,
    ): PrAssignment | null {
      return transaction(() => {
        if (!unchanged(guard)) return null;
        const { id: workflowId, headSha } = guard.workflow;
        const assignment = {
          id: randomUUID(),
          executionId: randomUUID(),
          createdAt: new Date().toISOString(),
          workflowId,
          headSha,
          agentName,
          producerId,
          input,
          claim: null,
          proof: null,
          operatorVersion: guard.version,
          superseded: false,
        };
        db.prepare(
          `
          INSERT INTO pr_assignments(id, workflow_id, head_sha, agent_name, producer_id, execution_id, created_at, operator_version, input)
          VALUES (?,?,?,?,?,?,?,?,?)
        `,
        ).run(
          assignment.id,
          workflowId,
          headSha,
          agentName,
          producerId,
          assignment.executionId,
          assignment.createdAt,
          assignment.operatorVersion,
          JSON.stringify(input),
        );
        return assignment;
      });
    },
    retry(guard: Guard, assignment: PrAssignment): PrAssignment | null {
      return transaction(() => {
        if (!unchanged(guard)) return null;
        const executionId = randomUUID();
        db.prepare("UPDATE pr_assignments SET execution_id=? WHERE id=? AND execution_id=?").run(
          executionId,
          assignment.id,
          assignment.executionId,
        );
        return { ...assignment, executionId };
      });
    },
    capture(assignment: PrAssignment, claim: AssignmentClaim) {
      db.prepare(
        "UPDATE pr_assignments SET claim=? WHERE id=? AND execution_id=? AND claim IS NULL AND superseded=0",
      ).run(JSON.stringify(claim), assignment.id, assignment.executionId);
    },
    corroborate(
      guard: Guard,
      assignment: PrAssignment,
      proof: string,
      record: (reviews: ReturnType<typeof createReviewStore>) => void,
      recovery?: { id: number; claim: AssignmentClaim; confirmedBy: Quiescence },
    ): boolean {
      return transaction(() => {
        if (!unchanged(guard)) return false;
        if (recovery) {
          const execution = db
            .prepare(
              `SELECT remote_block_id AS blockId FROM agent_executions
             WHERE id=? AND status='unknown' AND remote_result_digest IS NULL`,
            )
            .get(assignment.executionId);
          if (
            !execution ||
            ("blockId" in recovery.confirmedBy &&
              execution.blockId !== recovery.confirmedBy.blockId)
          )
            return false;
        }
        const { changes } = db
          .prepare(
            `UPDATE pr_assignments SET claim=?, proof=? WHERE id=? AND workflow_id=?
           AND execution_id=? AND superseded=0 AND claim IS ? AND proof IS NULL`,
          )
          .run(
            JSON.stringify(recovery?.claim ?? assignment.claim),
            proof,
            assignment.id,
            guard.workflow.id,
            assignment.executionId,
            assignment.claim ? JSON.stringify(assignment.claim) : null,
          );
        if (!changes) return false;
        // Review metadata and provenance belong to the transaction that owns the proof.
        record(createReviewStore(db, (run) => run()));
        if (recovery)
          db.prepare(
            "UPDATE pr_operator_events SET reason=json_set(reason, '$.confirmedBy', json(?)) WHERE id=?",
          ).run(JSON.stringify(recovery.confirmedBy), recovery.id);
        return true;
      });
    },
    supersede(guard: Guard, assignment: PrAssignment) {
      transaction(() => {
        if (!unchanged(guard)) return;
        db.prepare(
          "UPDATE pr_assignments SET superseded=1 WHERE id=? AND execution_id=? AND proof IS NULL",
        ).run(assignment.id, assignment.executionId);
      });
    },
    needsExecutionRecovery(workflowId: string): boolean {
      return Boolean(
        db
          .prepare(
            `
        SELECT 1 FROM pr_assignments
        JOIN agent_executions ON agent_executions.id=pr_assignments.execution_id
        WHERE workflow_id=? AND superseded=0 AND proof IS NULL
          AND agent_executions.status IN ('running','unknown')
          AND remote_result_digest IS NULL LIMIT 1
      `,
          )
          .get(workflowId),
      );
    },
    blockingExecutions(workflowId: string): string[] {
      return db
        .prepare(
          `
        SELECT agent_executions.id FROM pr_assignments
        JOIN agent_executions ON agent_executions.id=pr_assignments.execution_id
        WHERE workflow_id!=? AND proof IS NULL AND agent_executions.status IN ('running','unknown')
          AND remote_result_digest IS NULL
      `,
        )
        .all(workflowId)
        .map((row) => String(row.id));
    },
    allowances(id: string) {
      const counts = db
        .prepare(
          `
        SELECT
          coalesce(sum(CASE WHEN json_extract(input,'$.role')='reviewer' THEN 1 ELSE 0 END),0) AS reviews,
          coalesce(sum(CASE WHEN json_extract(input,'$.role')='implementer' THEN 1 ELSE 0 END),0) AS revisions
        FROM pr_assignments
        LEFT JOIN agent_executions ON agent_executions.id=pr_assignments.execution_id
        WHERE workflow_id=? AND (agent_executions.status IS NULL OR agent_executions.status!='not_started')
          AND (superseded=0 OR agent_executions.id IS NOT NULL)
      `,
        )
        .get(id)!;
      const grants = db
        .prepare(
          `
        SELECT coalesce(sum(review_slots),0) AS reviews, coalesce(sum(revision_slots),0) AS revisions
        FROM pr_operator_events WHERE workflow_id=?
      `,
        )
        .get(id)!;
      return {
        reviews: { reservedOrUsed: Number(counts.reviews), authorized: 3 + Number(grants.reviews) },
        revisions: {
          reservedOrUsed: Number(counts.revisions),
          authorized: 3 + Number(grants.revisions),
        },
      };
    },
  };
}
