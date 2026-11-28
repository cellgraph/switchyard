import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { agentSchema, createAgentStore } from "./agent-store.ts";
import type { GitHubRateLimits, GitHubRateLimitState, GitHubRepository } from "./github-app.ts";
import { createPlanStore, planSchema } from "./plan-store.ts";
import { createPrStore, prSchema } from "./pr-store.ts";
import { createReviewStore, reviewSchema } from "./review-store.ts";
import {
  transitionWorkflow,
  type CheckEvidence,
  type Workflow,
  type WorkflowCommand,
} from "./workflow.ts";

export type GitHubObservationWriter = {
  transition(id: string, command: WorkflowCommand): Workflow;
};

type WorkerRecord = {
  id: string;
  pid: number;
  startedAt: string;
  stoppedAt: string | null;
  reconcileIntervalMs: number;
  repositories: GitHubRepository[];
  lastPassStartedAt: string | null;
  lastPassFinishedAt: string | null;
  lastPassSucceeded: boolean | null;
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

const applicationId = 0x53575944; // SWYD
const schemaVersion = 24;
const unsupportedDatabase =
  "Unsupported Switchyard database identity or schema version. Use a fresh SWITCHYARD_DB_PATH for this implementation.";

function databaseIdentity(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT application_id AS id, user_version AS version FROM pragma_application_id(), pragma_user_version()",
    )
    .get() as { id: number; version: number };
}

const schema = `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY, repository TEXT NOT NULL COLLATE NOCASE, pull_request INTEGER NOT NULL,
    state TEXT NOT NULL, head_sha TEXT NOT NULL, required_checks TEXT,
    checks TEXT NOT NULL DEFAULT '[]', github_status TEXT,
    escalation_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(repository, pull_request)
  );
  CREATE TABLE transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    from_state TEXT NOT NULL, to_state TEXT NOT NULL, reason TEXT NOT NULL,
    head_sha TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE check_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    name TEXT NOT NULL, sha TEXT NOT NULL, outcome TEXT NOT NULL, captured_at TEXT NOT NULL
  );
  ${agentSchema}
  CREATE TABLE github_rate_limits (
    scope TEXT PRIMARY KEY NOT NULL, retry_at INTEGER NOT NULL, throttled_attempts INTEGER NOT NULL,
    retry_request TEXT
  );
  CREATE TABLE reconciliation_retries (retry_key TEXT PRIMARY KEY NOT NULL, retry_at INTEGER NOT NULL);
  CREATE TABLE github_observation_generations (
    repository TEXT NOT NULL COLLATE NOCASE, pull_request INTEGER NOT NULL, generation INTEGER NOT NULL,
    PRIMARY KEY (repository, pull_request)
  );
  CREATE TABLE controller_worker (slot INTEGER PRIMARY KEY CHECK(slot=1), record TEXT NOT NULL);
  ${reviewSchema}
  ${prSchema}
  ${planSchema}
  PRAGMA application_id = ${applicationId};
  PRAGMA user_version = ${schemaVersion};
`;

export class WorkflowStore {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.#initialize();
      this.#db.exec(
        "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
      );
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  workerRecord(): WorkerRecord | null {
    const row = this.#db.prepare("SELECT record FROM controller_worker WHERE slot=1").get();
    return row ? (JSON.parse(String(row.record)) as WorkerRecord) : null;
  }

  claimWorker(repositories: GitHubRepository[], reconcileIntervalMs: number, startedAt: string) {
    return this.#transaction(() => {
      const previous = this.workerRecord();
      if (previous && !previous.stoppedAt && localProcessAlive(previous.pid)) return null;
      const record: WorkerRecord = {
        id: randomUUID(),
        pid: process.pid,
        repositories,
        reconcileIntervalMs,
        startedAt,
        stoppedAt: null,
        lastPassStartedAt: null,
        lastPassFinishedAt: null,
        lastPassSucceeded: null,
      };
      this.#db
        .prepare("INSERT OR REPLACE INTO controller_worker VALUES (1, ?)")
        .run(JSON.stringify(record));
      return { record, interruptedRun: previous && !previous.stoppedAt ? previous.id : null };
    });
  }

  updateWorker(
    id: string,
    updates: Partial<
      Pick<
        WorkerRecord,
        "stoppedAt" | "lastPassStartedAt" | "lastPassFinishedAt" | "lastPassSucceeded"
      >
    >,
  ): void {
    const result = this.#db
      .prepare(
        "UPDATE controller_worker SET record=json_patch(record, ?) WHERE slot=1 AND json_extract(record, '$.id')=?",
      )
      .run(JSON.stringify(updates), id);
    if (result.changes !== 1) throw new Error("The reconciliation worker lost its SQLite claim.");
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
      prune: (now: number) =>
        this.#db.prepare("DELETE FROM reconciliation_retries WHERE retry_at <= ?").run(now),
    };
  }

  createWorkflow(workflow: Workflow): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO workflows (id, repository, pull_request, state, head_sha, required_checks, checks, escalation_reason, github_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workflow.id,
        workflow.identity.repository,
        workflow.identity.pullRequest,
        workflow.state,
        workflow.headSha,
        JSON.stringify(workflow.requiredChecks),
        JSON.stringify(workflow.checks),
        workflow.escalationReason,
        workflow.githubStatus ?? null,
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

  listWorkflows(repository?: string): Workflow[] {
    const rows =
      repository === undefined
        ? this.#db.prepare("SELECT * FROM workflows ORDER BY repository, pull_request").all()
        : this.#db
            .prepare("SELECT * FROM workflows WHERE repository = ? ORDER BY pull_request")
            .all(repository);
    return rows.map(decodeWorkflow);
  }

  transition(id: string, command: WorkflowCommand): Workflow {
    return this.#transaction(() => this.#transition(id, command));
  }

  prWorkflows() {
    return createPrStore(
      this.#db,
      (run) => this.#transaction(run),
      (id) => this.getWorkflow(id),
      (id, command) => this.#transition(id, command),
    );
  }

  plans() {
    return createPlanStore(this.#db, (run) => this.#transaction(run));
  }

  reviews() {
    return createReviewStore(this.#db, (run) => this.#transaction(run));
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
          });
          return true;
        }),
    };
  }

  agentExecutions() {
    return createAgentStore(this.#db, (run) => this.#transaction(run), localProcessAlive);
  }

  #transition(id: string, command: WorkflowCommand): Workflow {
    const current = this.getWorkflow(id);
    if (!current) throw new Error(`Workflow ${id} does not exist.`);
    const result = transitionWorkflow(current, command);
    const w = result.workflow;
    if (JSON.stringify(w) === JSON.stringify(current)) return w;
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE workflows SET state=?, head_sha=?, required_checks=?, checks=?, escalation_reason=?, github_status=?, updated_at=? WHERE id=?`,
      )
      .run(
        w.state,
        w.headSha,
        JSON.stringify(w.requiredChecks),
        JSON.stringify(w.checks),
        w.escalationReason,
        w.githubStatus ?? null,
        now,
        id,
      );
    this.#db
      .prepare(
        "INSERT INTO transitions (workflow_id, from_state, to_state, reason, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, result.from, result.to, result.reason, result.headSha, now);
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
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
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

  #initialize(): void {
    const filename = this.#db.location();
    if (filename && statSync(filename).size > 0) {
      // The baseline sets both fields before WAL. An immutable probe reads those
      // fields without recovery or checkpointing a foreign database.
      const url = pathToFileURL(filename);
      url.searchParams.set("immutable", "1");
      using probe = new DatabaseSync(url.href, { readOnly: true });
      const { id, version } = databaseIdentity(probe);
      if (id !== applicationId || (version !== 22 && version !== 23 && version !== schemaVersion))
        throw new Error(unsupportedDatabase);
    }

    this.#transaction(() => {
      const { id, version } = databaseIdentity(this.#db);
      if (id === applicationId && version === schemaVersion) return;
      if (id === applicationId && (version === 22 || version === 23)) {
        if (version === 22) this.#db.exec(planSchema);
        this.#db.exec(`
          ALTER TABLE agent_sessions ADD COLUMN reasoning_effort TEXT;
          PRAGMA user_version = ${schemaVersion};
        `);
        return;
      }
      if (
        id !== 0 ||
        version !== 0 ||
        this.#db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()
      )
        throw new Error(unsupportedDatabase);
      this.#db.exec(schema);
    });
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
    checks: JSON.parse(String(row.checks)) as CheckEvidence[],
    escalationReason: row.escalation_reason === null ? null : String(row.escalation_reason),
    ...(row.github_status === null
      ? {}
      : { githubStatus: row.github_status as NonNullable<Workflow["githubStatus"]> }),
  };
}
