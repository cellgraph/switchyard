import { createRemoteStore, remoteMigration } from "./remote-store.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createAgentOperationStore, recoverAgentOperations } from "./agent-store.ts";
import {
  fixMigration,
  readFixCycles,
  readFixReview,
  workflowAuthorizationRevision,
  type FixCycle,
} from "./fix-store.ts";
import type { GitHubRateLimits, GitHubRateLimitState } from "./github-app.ts";
import type { PullRequestTarget } from "./github-api.ts";
import { createReviewPublications } from "./review-publications.ts";
import { createReviewStore, reviewMigration } from "./review-store.ts";
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

export type FixStoreState = {
  workflow: Workflow;
  cycles: FixCycle[];
  review: ReturnType<typeof readFixReview>;
  revision: number;
  save(cycle: FixCycle): FixCycle;
  transition(command: WorkflowCommand): Workflow;
  reanchor(cycle: FixCycle, workspace: string): void;
};

export type GitHubObservationWriter = {
  transition(id: string, command: WorkflowCommand): Workflow;
  observeCodex: ReturnType<WorkflowStore["reviews"]>["observeCodex"];
};

type WorkerRecord = {
  id: string;
  pid: number;
  startedAt: string;
  stoppedAt: string | null;
  pollIntervalMs: number;
  targets: PullRequestTarget[];
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  lastPollSucceeded: boolean | null;
};

export function localProcessAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

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
  `CREATE TABLE reconciliation_retries (retry_key TEXT PRIMARY KEY NOT NULL, retry_at INTEGER NOT NULL);`,
  `ALTER TABLE agent_sessions ADD COLUMN execution TEXT;
  ALTER TABLE worktrees ADD COLUMN execution TEXT;
  CREATE INDEX agent_operations_by_workflow ON operations(workflow_id, status) WHERE kind='durable_agent_turn';
  CREATE UNIQUE INDEX one_unresolved_agent_operation ON operations(workflow_id)
    WHERE kind='durable_agent_turn' AND status IN ('requested','dispatching','running','unknown','interrupted','manual_reconciliation');`,
  "ALTER TABLE operations ADD COLUMN owner_pid INTEGER;",
  reviewMigration,
  "ALTER TABLE review_runs ADD COLUMN latest_summary TEXT;",
  fixMigration,
  `CREATE TABLE github_observation_generations (
    repository TEXT NOT NULL COLLATE NOCASE, pull_request INTEGER NOT NULL, generation INTEGER NOT NULL,
    PRIMARY KEY (repository, pull_request)
  );`,
  "CREATE TABLE unattended_worker (slot INTEGER PRIMARY KEY CHECK(slot=1), record TEXT NOT NULL);",
  remoteMigration,
];

export class WorkflowStore {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path, { timeout: 5_000 });
    this.#db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  workerRecord(): WorkerRecord | null {
    const row = this.#db.prepare("SELECT record FROM unattended_worker WHERE slot=1").get();
    return row ? (JSON.parse(String(row.record)) as WorkerRecord) : null;
  }

  claimWorker(targets: PullRequestTarget[], pollIntervalMs: number, startedAt: string) {
    return this.#transaction(() => {
      const previous = this.workerRecord();
      if (previous && !previous.stoppedAt && localProcessAlive(previous.pid)) return null;
      const record: WorkerRecord = {
        id: randomUUID(),
        pid: process.pid,
        targets,
        pollIntervalMs,
        startedAt,
        stoppedAt: null,
        lastPollStartedAt: null,
        lastPollFinishedAt: null,
        lastPollSucceeded: null,
      };
      this.#db
        .prepare("INSERT OR REPLACE INTO unattended_worker VALUES (1, ?)")
        .run(JSON.stringify(record));
      return { record, interruptedRun: previous && !previous.stoppedAt ? previous.id : null };
    });
  }

  updateWorker(
    id: string,
    updates: Partial<
      Pick<
        WorkerRecord,
        "stoppedAt" | "lastPollStartedAt" | "lastPollFinishedAt" | "lastPollSucceeded"
      >
    >,
  ): void {
    const result = this.#db
      .prepare(
        "UPDATE unattended_worker SET record=json_patch(record, ?) WHERE slot=1 AND json_extract(record, '$.id')=?",
      )
      .run(JSON.stringify(updates), id);
    if (result.changes !== 1) throw new Error("The unattended worker lost its SQLite claim.");
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

  reconciliationRetries() {
    const select = this.#db.prepare(
      "SELECT retry_at FROM reconciliation_retries WHERE retry_key = ?",
    );
    const upsert = this.#db.prepare(
      `INSERT INTO reconciliation_retries (retry_key, retry_at)
       SELECT value, ? FROM json_each(?) WHERE type = 'text'
       ON CONFLICT(retry_key) DO UPDATE SET retry_at=MAX(reconciliation_retries.retry_at, excluded.retry_at)`,
    );
    const remove = this.#db.prepare("DELETE FROM reconciliation_retries WHERE retry_key = ?");
    return {
      get: (key: string) => (select.get(key) as { retry_at: number } | undefined)?.retry_at,
      extend: (keys: readonly string[], retryAt: number) =>
        upsert.run(retryAt, JSON.stringify(keys)),
      delete: (key: string) => remove.run(key),
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
    return this.#transaction(() => this.#transition(id, command));
  }

  reviewPublications() {
    return createReviewPublications(this.#db, (run) => this.#transaction(run));
  }

  reviews() {
    return this.#reviews((run) => this.#transaction(run));
  }

  #reviews(transaction: <T>(run: () => T) => T) {
    return createReviewStore(this.#db, {
      transaction,
      assertDispositionAllowed: (id, runId) => this.#assertPublicationUnclaimed(id, runId),
      getWorkflow: (id) => this.getWorkflow(id),
      transition: (id, command) => this.#transition(id, command),
    });
  }

  beginGitHubObservation(repository: string, pullRequest: number) {
    const { generation } = this.#db
      .prepare(
        `
      INSERT INTO github_observation_generations(repository, pull_request, generation)
      VALUES (?,?,1) ON CONFLICT(repository, pull_request) DO UPDATE SET generation=generation+1
      RETURNING generation
    `,
      )
      .get(repository, pullRequest) as { generation: number };
    return {
      apply: (run: (observation: GitHubObservationWriter) => void): boolean =>
        this.#transaction(() => {
          const latest = this.#db
            .prepare(
              `
          SELECT generation FROM github_observation_generations WHERE repository=? AND pull_request=?
        `,
            )
            .get(repository, pullRequest);
          if (latest?.generation !== generation) return false;
          run({
            transition: (id, command) => this.#transition(id, command),
            observeCodex: this.#reviews((operation) => operation()).observeCodex,
          });
          return true;
        }),
    };
  }

  #assertPublicationUnclaimed(id: string, runId?: string) {
    const cycle = readFixCycles(this.#db, id).at(-1);
    if (
      cycle?.push &&
      cycle.push !== "confirmed" &&
      (runId === undefined || cycle.review.id === runId)
    ) {
      throw new Error(
        "Publication has already started. Reconcile the push before changing its findings or stopping the workflow.",
      );
    }
  }

  remoteWorkers(now = Date.now) {
    const getWorkflow = (id: string) => this.getWorkflow(id);
    return createRemoteStore(
      this.#db,
      (run) => this.#transaction(run),
      createAgentOperationStore(this.#db, {
        // Remote claims and their agent transitions share the enclosing transaction.
        transaction: (run) => run(),
        getWorkflow,
        transition: (id, command) => this.#transition(id, command),
      }),
      getWorkflow,
      now,
    );
  }

  agentOperations() {
    return createAgentOperationStore(this.#db, {
      transaction: (run) => this.#transaction(run),
      getWorkflow: (id) => this.getWorkflow(id),
      transition: (id, command) => this.#transition(id, command),
    });
  }

  fixes(workflowId: string) {
    return {
      read: () => readFixCycles(this.#db, workflowId),
      edit: <T>(run: (state: FixStoreState) => T): T =>
        this.#transaction(() => {
          const workflow = this.getWorkflow(workflowId);
          if (!workflow) throw new Error("Workflow does not exist. Reconcile GitHub first.");
          return run({
            workflow,
            cycles: readFixCycles(this.#db, workflowId),
            review: readFixReview(this.#db, workflow),
            revision: workflowAuthorizationRevision(this.#db, workflowId),
            save: (cycle) => this.#saveFix(cycle),
            transition: (command) => this.#transition(workflowId, command),
            reanchor: (cycle, workspace) => {
              const result = this.#db
                .prepare(
                  `
              UPDATE agent_sessions SET execution=json_set(execution, '$.head', ?, '$.checkpoint.workspace', ?, '$.updatedAt', ?)
              WHERE workflow_id=? AND json_extract(execution, '$.status')='active'
              AND json_extract(execution, '$.head')=? AND json_extract(execution, '$.lastOperationId')=?
            `,
                )
                .run(
                  cycle.commit!,
                  workspace,
                  new Date().toISOString(),
                  workflowId,
                  cycle.head,
                  cycle.operationId,
                );
              if (result.changes !== 1)
                throw new Error("Fix session changed before publication confirmation.");
            },
          });
        }),
    };
  }

  #saveFix(cycle: FixCycle): FixCycle {
    cycle = { ...cycle, version: cycle.version + 1, updatedAt: new Date().toISOString() };
    this.#db
      .prepare(
        `
      DELETE FROM fix_cycles WHERE workflow_id=? AND head_sha=? AND id<>?
      AND json_extract(record, '$.phase')='proposed'
    `,
      )
      .run(cycle.workflowId, cycle.head, cycle.id);
    this.#db
      .prepare(
        `
      INSERT INTO fix_cycles(id, workflow_id, head_sha, record) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET record=excluded.record
    `,
      )
      .run(cycle.id, cycle.workflowId, cycle.head, JSON.stringify(cycle));
    return cycle;
  }

  #transition(id: string, command: WorkflowCommand): Workflow {
    const current = this.getWorkflow(id);
    if (!current) throw new Error(`Workflow ${id} does not exist.`);
    if (command.type === "stop") this.#assertPublicationUnclaimed(id);
    if (
      command.type === "github_pull_request" &&
      command.state === "open" &&
      current.closedByGitHub
    ) {
      const unresolved = this.#db
        .prepare(
          "SELECT DISTINCT status FROM operations WHERE workflow_id=? AND status IN ('pending','ambiguous','dispatching','running','unknown','interrupted','manual_reconciliation')",
        )
        .all(id);
      if (
        unresolved.some(({ status }) =>
          ["ambiguous", "unknown", "interrupted", "manual_reconciliation"].includes(String(status)),
        )
      ) {
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
    const cycle = readFixCycles(this.#db, id).at(-1);
    if (
      command.type === "late_publication_confirmed" &&
      (cycle?.phase !== "escalated" ||
        cycle.push !== "confirmed" ||
        cycle.interruptedPushDeadline === undefined ||
        cycle.commit !== command.sha)
    )
      throw new Error("Late publication does not match the recorded interrupted push.");
    if (cycle && !["proposed", "finished", "escalated"].includes(cycle.phase)) {
      const observed =
        command.type === "github_pull_request" || command.type === "head_changed"
          ? command.sha
          : undefined;
      const expectedPublication =
        cycle.commit &&
        ["pushing", "confirming"].includes(cycle.phase) &&
        (current.headSha === cycle.head || current.headSha === cycle.commit);
      const expectedHead = observed && expectedPublication && observed === cycle.commit;
      const invalidHead = observed && observed !== current.headSha && !expectedHead;
      const closed = command.type === "github_pull_request" && command.state === "closed";
      const invalidReview =
        current.headSha === cycle.head &&
        (command.type === "review_invalidated" ||
          (command.type === "review_received" &&
            (command.evidence.runId !== cycle.review.id ||
              command.evidence.outcome !== "completed_with_findings")));
      if (invalidHead || closed || invalidReview) {
        const reason = closed
          ? "The pull request closed during an authorized fix."
          : invalidHead
            ? "The pull request head changed outside the authorized publication."
            : "The review authorizing this fix changed. Inspect the retained worktree and review evidence.";
        command = { type: "escalate", reason, ...(observed ? { observedHeadSha: observed } : {}) };
      }
      if (command.type === "escalate") {
        this.#saveFix({
          ...cycle,
          phase: "escalated",
          reason: command.reason,
          validation: cycle.validation.map((attempt) =>
            attempt.status === "running" ? { ...attempt, status: "unknown" } : attempt,
          ),
        });
      }
    }
    const result = transitionWorkflow(current, command);
    const w = result.workflow;
    if (JSON.stringify(w) === JSON.stringify(current)) return w;
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
    if (w.headSha !== current.headSha || w.state === "stopped" || w.state === "escalated")
      this.#db
        .prepare("UPDATE review_runs SET eligible=0 WHERE workflow_id=? AND eligible=1")
        .run(id);
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
    return w;
  }

  #transaction<T>(run: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.#db.exec("COMMIT");
      return result;
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
    if (kind === "durable_agent_turn")
      throw new Error("Use the agent operation store to request a turn.");
    return this.#transaction(() => {
      if (
        this.#db
          .prepare(
            "SELECT 1 FROM operations WHERE workflow_id=? AND kind='durable_agent_turn' AND status!='completed'",
          )
          .get(workflowId)
      )
        throw new Error("Workflow already has an unresolved agent operation.");
      const now = new Date().toISOString();
      return (
        this.#db
          .prepare(
            "INSERT OR IGNORE INTO operations (operation_id, workflow_id, kind, status, input, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
          )
          .run(operationId, workflowId, kind, JSON.stringify(input), now, now).changes === 1
      );
    });
  }

  finishOperation(
    operationId: string,
    status: Exclude<OperationStatus, "pending">,
    result?: unknown,
    error?: string,
  ): void {
    const updated = this.#db
      .prepare(
        "UPDATE operations SET status=?, result=?, error=?, updated_at=? WHERE operation_id=? AND status='pending' AND kind!='durable_agent_turn'",
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

  recover(): {
    deliveries: number;
    ambiguousOperations: number;
    unverifiedAgentOperations?: string[];
  } {
    const expiredRemote = this.remoteWorkers().expire();
    return this.#transaction(() => {
      const deliveries = Number(
        this.#db.prepare("UPDATE deliveries SET status='pending' WHERE status='processing'").run()
          .changes,
      );
      const ambiguousLegacyOperations = Number(
        this.#db
          .prepare(
            "UPDATE operations SET status='ambiguous', error='Process restarted before outcome was recorded.', updated_at=? WHERE status='pending'",
          )
          .run(new Date().toISOString()).changes,
      );
      const { recovered, unverified } = recoverAgentOperations(this.#db);
      const affected = this.#db
        .prepare(
          "SELECT DISTINCT workflow_id FROM operations WHERE status IN ('ambiguous','unknown')",
        )
        .all() as Array<{ workflow_id: string }>;
      this.#escalateAmbiguousWorkflows(
        affected.map(({ workflow_id }) => workflow_id),
        "An external operation has an ambiguous outcome after restart.",
      );
      return {
        deliveries,
        ambiguousOperations: ambiguousLegacyOperations + recovered.length + expiredRemote,
        ...(unverified.length ? { unverifiedAgentOperations: unverified } : {}),
      };
    });
  }

  recoverAgentClaims(): number {
    return this.#transaction(() => {
      const { recovered } = recoverAgentOperations(this.#db);
      this.#escalateAmbiguousWorkflows(
        recovered,
        "An agent owner exited without a recorded outcome.",
      );
      return recovered.length;
    });
  }

  #escalateAmbiguousWorkflows(ids: string[], reason: string): void {
    for (const id of ids) {
      const w = this.getWorkflow(id);
      if (w && (w.state !== "stopped" || w.closedByGitHub) && w.state !== "escalated")
        this.#transition(id, { type: "escalate", reason });
    }
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
    this.#transaction(() => {
      this.#db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const { version } = this.#db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number };
      for (let i = version; i < migrations.length; i++) {
        this.#db.exec(migrations[i]!);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(i + 1, new Date().toISOString());
      }
    });
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
