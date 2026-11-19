import { DatabaseSync } from "node:sqlite";
import type { GitHubRateLimits, GitHubRateLimitState } from "./github-app.ts";
import {
  transitionWorkflow,
  type CheckEvidence,
  type ReviewEvidence,
  type Workflow,
  type WorkflowCommand,
} from "./workflow.ts";

export type DeliveryStatus = "pending" | "processing" | "processed" | "failed";
type InboxDelivery = { deliveryId: string; payload: unknown; workflowId: string | null };
type DeliveryRow = { delivery_id: string; payload: string; workflow_id: string | null };
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
  "ALTER TABLE workflows ADD COLUMN cycle_awaiting_review INTEGER NOT NULL DEFAULT 0;",
  "ALTER TABLE workflows ADD COLUMN validation_head_sha TEXT;",
  `ALTER TABLE workflows ADD COLUMN closed_by_github INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE deliveries ADD COLUMN retry_at INTEGER;
  CREATE INDEX deliveries_retry ON deliveries(status, retry_at);`,
  `CREATE TABLE github_rate_limits (
    scope TEXT PRIMARY KEY NOT NULL, retry_at INTEGER NOT NULL, throttled_attempts INTEGER NOT NULL,
    retry_request TEXT
  );`,
  // Earlier keys lack a PR or repository scope. Preserve their cooldown and any explicit pause.
  `UPDATE github_rate_limits SET throttled_attempts = 0, retry_request = NULL
   WHERE scope = 'secondary' AND throttled_attempts BETWEEN 1 AND 4
   AND (retry_request GLOB '*:GET:/repos/*/commits/*'
     OR retry_request GLOB '*:POST:/app/installations/*/access_tokens');`,
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

  githubRateLimits(): GitHubRateLimits {
    const select = this.#db.prepare(
      `SELECT retry_at AS retryAt, throttled_attempts AS throttledAttempts, retry_request AS retryRequest
       FROM github_rate_limits WHERE scope = ?`,
    );
    const upsert = this.#db.prepare(
      `INSERT INTO github_rate_limits (scope, retry_at, throttled_attempts, retry_request) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET retry_at=excluded.retry_at,
       throttled_attempts=excluded.throttled_attempts, retry_request=excluded.retry_request`,
    );
    return {
      get: (scope) => select.get(scope) as GitHubRateLimitState | undefined,
      set: (scope, state) => {
        upsert.run(scope, state.retryAt, state.throttledAttempts, state.retryRequest);
      },
    };
  }

  createWorkflow(workflow: Workflow): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO workflows (id, repository, pull_request, state, head_sha, required_checks, review, checks, fix_cycles, cycle_awaiting_review, validation_head_sha, escalation_reason, closed_by_github, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        workflow.cycleAwaitingReview ? 1 : 0,
        workflow.validationHeadSha,
        workflow.escalationReason,
        workflow.closedByGitHub ? 1 : 0,
        now,
        now,
      );
  }

  getWorkflow(id: string): Workflow | null {
    const row = this.#db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return row ? decodeWorkflow(row) : null;
  }

  findWorkflow(repository: string, pullRequest: number): Workflow | null {
    const row = this.#db
      .prepare(
        "SELECT * FROM workflows WHERE repository = ? COLLATE NOCASE AND pull_request = ? ORDER BY id LIMIT 1",
      )
      .get(repository, pullRequest);
    return row ? decodeWorkflow(row) : null;
  }

  transition(id: string, command: WorkflowCommand): Workflow {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWorkflow(id);
      if (!current) throw new Error(`Workflow ${id} does not exist.`);
      if (
        command.type === "github_pull_request" &&
        command.state === "open" &&
        current.closedByGitHub
      ) {
        const unresolved = this.#db
          .prepare(
            "SELECT DISTINCT status FROM operations WHERE workflow_id=? AND status IN ('pending','ambiguous')",
          )
          .all(id);
        if (unresolved.some(({ status }) => status === "ambiguous")) {
          command = {
            type: "escalate",
            reason: "An external operation has an ambiguous outcome.",
            observedHeadSha: command.sha,
          };
        } else if (unresolved.length) {
          throw new Error(
            "Cannot resume a reopened pull request while an external operation is pending.",
          );
        }
      }
      const result = transitionWorkflow(current, command);
      const w = result.workflow;
      if (JSON.stringify(w) === JSON.stringify(current)) {
        this.#db.exec("COMMIT");
        return w;
      }
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE workflows SET state=?, head_sha=?, required_checks=?, review=?, checks=?, fix_cycles=?, cycle_awaiting_review=?, validation_head_sha=?, escalation_reason=?, closed_by_github=?, updated_at=? WHERE id=?`,
        )
        .run(
          w.state,
          w.headSha,
          JSON.stringify(w.requiredChecks),
          JSON.stringify(w.review),
          JSON.stringify(w.checks),
          w.fixCycles,
          w.cycleAwaitingReview ? 1 : 0,
          w.validationHeadSha,
          w.escalationReason,
          w.closedByGitHub ? 1 : 0,
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

  pendingDeliveries(): InboxDelivery[] {
    return (
      this.#db
        .prepare(
          "SELECT delivery_id, payload, workflow_id FROM deliveries WHERE status IN ('pending','processing','failed') ORDER BY received_at",
        )
        .all() as DeliveryRow[]
    ).map(decodeDelivery);
  }

  dueDeliveryIds(now: number, limit: number): string[] {
    return this.dueDeliveries(now, limit).map((row) => row.deliveryId);
  }

  dueDeliveries(
    now: number,
    limit: number,
    eligible?: (delivery: InboxDelivery) => boolean,
  ): InboxDelivery[] {
    if (limit === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT delivery_id, payload, workflow_id FROM deliveries
         WHERE status = 'pending' OR (status = 'failed' AND (retry_at IS NULL OR retry_at <= ?))
         ORDER BY COALESCE(retry_at, unixepoch(received_at) * 1000), rowid LIMIT ?`,
      )
      .iterate(now, eligible ? -1 : limit) as Iterable<DeliveryRow>;
    const selected: InboxDelivery[] = [];
    for (const row of rows) {
      const delivery = decodeDelivery(row);
      if (eligible && !eligible(delivery)) continue;
      selected.push(delivery);
      if (selected.length === limit) break;
    }
    return selected;
  }

  deliveryStatus(deliveryId: string): {
    status: DeliveryStatus;
    attempts: number;
    error: string | null;
    retryAt: number | null;
  } | null {
    const row = this.#db
      .prepare(
        "SELECT status, attempts, error, retry_at AS retryAt FROM deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    return (row as ReturnType<WorkflowStore["deliveryStatus"]>) ?? null;
  }

  async processDelivery(
    deliveryId: string,
    processor: (payload: unknown, workflowId: string | null) => void | Promise<void>,
    retryAt?: () => number,
  ): Promise<boolean> {
    const row = this.#db
      .prepare(
        "SELECT payload, workflow_id FROM deliveries WHERE delivery_id=? AND status IN ('pending','failed')",
      )
      .get(deliveryId) as { payload: string; workflow_id: string | null } | undefined;
    if (!row || !this.claimDelivery(deliveryId)) return false;
    try {
      await processor(JSON.parse(row.payload) as unknown, row.workflow_id);
      this.completeDelivery(deliveryId);
      return true;
    } catch (error) {
      this.failDelivery(deliveryId, String(error), retryAt?.() ?? null);
      throw error;
    }
  }

  claimDelivery(deliveryId: string): boolean {
    return (
      this.#db
        .prepare(
          "UPDATE deliveries SET status='processing', attempts=attempts+1 WHERE delivery_id=? AND status IN ('pending','failed')",
        )
        .run(deliveryId).changes === 1
    );
  }

  completeDelivery(deliveryId: string): void {
    const changed = this.#db
      .prepare(
        "UPDATE deliveries SET status='processed', processed_at=?, error=NULL, retry_at=NULL WHERE delivery_id=? AND status='processing'",
      )
      .run(new Date().toISOString(), deliveryId);
    if (changed.changes !== 1) throw new Error(`Delivery ${deliveryId} is not processing.`);
  }

  failDelivery(deliveryId: string, error: string, retryAt: number | null = null): void {
    const changed = this.#db
      .prepare(
        "UPDATE deliveries SET status='failed', error=?, retry_at=? WHERE delivery_id=? AND status='processing'",
      )
      .run(error, retryAt, deliveryId);
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
      if (w && (w.state !== "stopped" || w.closedByGitHub) && w.state !== "escalated")
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

function decodeDelivery(row: DeliveryRow): InboxDelivery {
  return {
    deliveryId: row.delivery_id,
    payload: JSON.parse(row.payload) as unknown,
    workflowId: row.workflow_id,
  };
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
    cycleAwaitingReview: Number(row.cycle_awaiting_review) === 1,
    validationHeadSha: row.validation_head_sha === null ? null : String(row.validation_head_sha),
    escalationReason: row.escalation_reason === null ? null : String(row.escalation_reason),
    ...(row.closed_by_github === 1 ? { closedByGitHub: true } : {}),
  };
}
