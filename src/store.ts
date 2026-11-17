import { DatabaseSync } from "node:sqlite";
import {
  transitionWorkflow,
  type CheckEvidence,
  type ReviewEvidence,
  type Workflow,
  type WorkflowCommand,
} from "./workflow.js";

export type DeliveryStatus = "pending" | "processing" | "processed" | "failed";
export type OperationStatus = "pending" | "completed" | "failed" | "ambiguous";

const migrations = [
  `CREATE TABLE workflows (
    id TEXT PRIMARY KEY, repository TEXT NOT NULL, pull_request INTEGER NOT NULL,
    state TEXT NOT NULL, head_sha TEXT NOT NULL, required_checks TEXT,
    review TEXT, checks TEXT NOT NULL DEFAULT '[]', fix_cycles INTEGER NOT NULL DEFAULT 0,
    escalation_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(repository, pull_request)
  );
  CREATE TABLE transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    from_state TEXT NOT NULL, to_state TEXT NOT NULL, reason TEXT NOT NULL,
    head_sha TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE deliveries (
    delivery_id TEXT PRIMARY KEY, workflow_id TEXT REFERENCES workflows(id),
    payload TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL,
    processed_at TEXT, error TEXT
  );
  CREATE INDEX deliveries_pending ON deliveries(status, received_at);
  CREATE TABLE review_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    sha TEXT NOT NULL, outcome TEXT NOT NULL, captured_at TEXT NOT NULL
  );
  CREATE TABLE check_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    name TEXT NOT NULL, sha TEXT NOT NULL, outcome TEXT NOT NULL, captured_at TEXT NOT NULL
  );
  CREATE TABLE agent_sessions (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id), session_id TEXT, metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE worktrees (
    workflow_id TEXT PRIMARY KEY REFERENCES workflows(id), path TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    kind TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, result TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
  );`,
];

export class WorkflowStore {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  createWorkflow(workflow: Workflow): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO workflows (id, repository, pull_request, state, head_sha, required_checks, review, checks, fix_cycles, escalation_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workflow.id,
        workflow.identity.repository,
        workflow.identity.pullRequest,
        workflow.state,
        workflow.headSha,
        JSON.stringify(workflow.requiredChecks),
        JSON.stringify(workflow.review),
        JSON.stringify(workflow.checks),
        workflow.fixCycles,
        workflow.escalationReason,
        now,
        now,
      );
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return row ? decodeWorkflow(row) : null;
  }

  transition(id: string, command: WorkflowCommand): Workflow {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWorkflow(id);
      if (!current) throw new Error(`Workflow ${id} does not exist.`);
      const result = transitionWorkflow(current, command);
      const w = result.workflow;
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE workflows SET state=?, head_sha=?, required_checks=?, review=?, checks=?, fix_cycles=?, escalation_reason=?, updated_at=? WHERE id=?`,
        )
        .run(
          w.state,
          w.headSha,
          JSON.stringify(w.requiredChecks),
          JSON.stringify(w.review),
          JSON.stringify(w.checks),
          w.fixCycles,
          w.escalationReason,
          now,
          id,
        );
      this.#db
        .prepare(
          "INSERT INTO transitions (workflow_id, from_state, to_state, reason, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, result.from, result.to, result.reason, result.headSha, now);
      if (command.type === "review_received")
        this.#db
          .prepare(
            "INSERT INTO review_snapshots (workflow_id, sha, outcome, captured_at) VALUES (?, ?, ?, ?)",
          )
          .run(id, command.evidence.sha, command.evidence.outcome, now);
      if (command.type === "checks_received")
        for (const check of command.evidence)
          this.#db
            .prepare(
              "INSERT INTO check_snapshots (workflow_id, name, sha, outcome, captured_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(id, check.name, check.sha, check.outcome, now);
      this.#db.exec("COMMIT");
      return w;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  receiveDelivery(deliveryId: string, payload: unknown, workflowId: string | null = null): boolean {
    const result = this.#db
      .prepare(
        "INSERT OR IGNORE INTO deliveries (delivery_id, workflow_id, payload, status, received_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .run(deliveryId, workflowId, JSON.stringify(payload), new Date().toISOString());
    return result.changes === 1;
  }

  pendingDeliveries(): Array<{ deliveryId: string; payload: unknown; workflowId: string | null }> {
    return (
      this.#db
        .prepare(
          "SELECT delivery_id, payload, workflow_id FROM deliveries WHERE status IN ('pending','processing') ORDER BY received_at",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      deliveryId: String(row.delivery_id),
      payload: JSON.parse(String(row.payload)) as unknown,
      workflowId: row.workflow_id === null ? null : String(row.workflow_id),
    }));
  }

  processDelivery(deliveryId: string, processor: (payload: unknown) => void): boolean {
    const row = this.#db
      .prepare(
        "SELECT payload FROM deliveries WHERE delivery_id=? AND status IN ('pending','failed')",
      )
      .get(deliveryId) as { payload: string } | undefined;
    if (!row || !this.claimDelivery(deliveryId)) return false;
    try {
      processor(JSON.parse(row.payload) as unknown);
      this.completeDelivery(deliveryId);
      return true;
    } catch (error) {
      this.failDelivery(deliveryId, String(error));
      throw error;
    }
  }

  claimDelivery(deliveryId: string): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE deliveries SET status='processing', error=NULL WHERE delivery_id=? AND status='pending'",
        )
        .run(deliveryId).changes === 1
    );
  }

  completeDelivery(deliveryId: string): void {
    const changed = this.#db
      .prepare(
        "UPDATE deliveries SET status='processed', processed_at=?, error=NULL WHERE delivery_id=? AND status='processing'",
      )
      .run(new Date().toISOString(), deliveryId);
    if (changed.changes !== 1) throw new Error(`Delivery ${deliveryId} is not processing.`);
  }

  failDelivery(deliveryId: string, error: string): void {
    const changed = this.#db
      .prepare(
        "UPDATE deliveries SET status='failed', error=? WHERE delivery_id=? AND status='processing'",
      )
      .run(error, deliveryId);
    if (changed.changes !== 1) throw new Error(`Delivery ${deliveryId} is not processing.`);
  }

  createOperation(operationId: string, workflowId: string, kind: string, input: unknown): boolean {
    const now = new Date().toISOString();
    return (
      this.#db
        .prepare(
          "INSERT OR IGNORE INTO operations (operation_id, workflow_id, kind, status, input, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        )
        .run(operationId, workflowId, kind, JSON.stringify(input), now, now).changes === 1
    );
  }

  finishOperation(
    operationId: string,
    status: Exclude<OperationStatus, "pending">,
    result?: unknown,
    error?: string,
  ): void {
    const updated = this.#db
      .prepare(
        "UPDATE operations SET status=?, result=?, error=?, updated_at=? WHERE operation_id=? AND status='pending'",
      )
      .run(
        status,
        result === undefined ? null : JSON.stringify(result),
        error ?? null,
        new Date().toISOString(),
        operationId,
      );
    if (updated.changes !== 1)
      throw new Error(`Operation ${operationId} is missing or no longer pending.`);
  }

  recover(): { deliveries: number; ambiguousOperations: number } {
    let affected: Array<{ workflow_id: string }>;
    let deliveries: number;
    let ambiguousOperations: number;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      deliveries = Number(
        this.#db.prepare("UPDATE deliveries SET status='pending' WHERE status='processing'").run()
          .changes,
      );
      ambiguousOperations = Number(
        this.#db
          .prepare(
            "UPDATE operations SET status='ambiguous', error='Process restarted before outcome was recorded.', updated_at=? WHERE status='pending'",
          )
          .run(new Date().toISOString()).changes,
      );
      affected = this.#db
        .prepare("SELECT DISTINCT workflow_id FROM operations WHERE status='ambiguous'")
        .all() as Array<{ workflow_id: string }>;
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    for (const row of affected) {
      const w = this.getWorkflow(row.workflow_id);
      if (w && w.state !== "stopped" && w.state !== "escalated")
        this.transition(row.workflow_id, {
          type: "escalate",
          reason: "An external operation has an ambiguous outcome after restart.",
        });
    }
    return { deliveries, ambiguousOperations };
  }

  transitions(id: string): Array<{ from: string; to: string; reason: string; headSha: string }> {
    return (
      this.#db
        .prepare(
          "SELECT from_state, to_state, reason, head_sha FROM transitions WHERE workflow_id=? ORDER BY id",
        )
        .all(id) as Array<Record<string, unknown>>
    ).map((row) => ({
      from: String(row.from_state),
      to: String(row.to_state),
      reason: String(row.reason),
      headSha: String(row.head_sha),
    }));
  }

  #migrate(): void {
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const current = Number(
      (
        this.#db
          .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version,
    );
    for (let i = current; i < migrations.length; i++) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(migrations[i]!);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(i + 1, new Date().toISOString());
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function decodeWorkflow(row: Record<string, unknown>): Workflow {
  return {
    id: String(row.id),
    identity: { repository: String(row.repository), pullRequest: Number(row.pull_request) },
    state: String(row.state) as Workflow["state"],
    headSha: String(row.head_sha),
    requiredChecks:
      row.required_checks === null ? null : (JSON.parse(String(row.required_checks)) as string[]),
    review: row.review === null ? null : (JSON.parse(String(row.review)) as ReviewEvidence),
    checks: JSON.parse(String(row.checks)) as CheckEvidence[],
    fixCycles: Number(row.fix_cycles),
    escalationReason: row.escalation_reason === null ? null : String(row.escalation_reason),
  };
}
