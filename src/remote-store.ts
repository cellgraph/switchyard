import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentRuntime,
  AgentTurnEvidence,
  AgentTurnRequest,
  AgentTurnIntent,
} from "./agent-operation.ts";
import type { createAgentOperationStore } from "./agent-store.ts";
import {
  remoteLeaseMs,
  RemoteProtocolError,
  type Capabilities,
  type LeaseKey,
  type Placement,
  type RemoteTask,
} from "./remote-protocol.ts";
import type { WorkerSessionReference } from "./local-worker.ts";
import type { Worktree, WorktreeLocation } from "./worktree.ts";
import type { Workflow } from "./workflow.ts";

export const remoteMigration = `
  CREATE TABLE remote_workers (
    id TEXT PRIMARY KEY NOT NULL,
    capabilities TEXT NOT NULL,
    seen_at INTEGER NOT NULL
  );
  CREATE TABLE remote_turns (
    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(operation_id),
    repository TEXT NOT NULL,
    prompt TEXT
  );
  CREATE TABLE remote_attempts (
    operation_id TEXT PRIMARY KEY NOT NULL REFERENCES remote_turns(operation_id),
    worker_id TEXT NOT NULL REFERENCES remote_workers(id),
    instance TEXT NOT NULL,
    fence TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    deadline INTEGER NOT NULL,
    finished_at INTEGER,
    disposition TEXT CHECK(disposition IN ('reported','expired')),
    receipt TEXT,
    late_evidence TEXT
  );
  CREATE INDEX remote_attempts_by_worker ON remote_attempts(worker_id, disposition);
`;

type Attempt = {
  operation_id: string;
  worker_id: string;
  instance: string;
  fence: string;
  claimed_at: number;
  expires_at: number;
  deadline: number;
  finished_at: number | null;
  disposition: "reported" | "expired" | null;
  receipt: string | null;
  late_evidence: string | null;
};
type Waiting = { operation_id: string; repository: string; prompt: string; input: string };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function createRemoteStore(
  db: DatabaseSync,
  transaction: <T>(fn: () => T) => T,
  operations: ReturnType<typeof createAgentOperationStore>,
  getWorkflow: (id: string) => Workflow | null,
  now: () => number,
) {
  function expire(time: number) {
    const expired = db
      .prepare("SELECT * FROM remote_attempts WHERE disposition IS NULL AND expires_at<=?")
      .all(time) as Attempt[];
    for (const attempt of expired) {
      operations.finish(attempt.operation_id, {
        agent: { outcome: "unknown" },
        error:
          attempt.deadline <= time
            ? "Remote execution deadline elapsed without a committed outcome."
            : "Remote worker lease expired without a committed outcome.",
      });
      db.prepare(
        "UPDATE remote_attempts SET disposition='expired', finished_at=? WHERE operation_id=?",
      ).run(time, attempt.operation_id);
    }
    return expired.length;
  }

  function touch(id: string, time: number) {
    if (!db.prepare("UPDATE remote_workers SET seen_at=? WHERE id=?").run(time, id).changes)
      throw new RemoteProtocolError("Register worker capabilities first.", 409);
  }

  function fenced(id: string, key: LeaseKey) {
    const attempt = db
      .prepare("SELECT * FROM remote_attempts WHERE operation_id=?")
      .get(key.operationId) as Attempt | undefined;
    if (
      !attempt ||
      attempt.worker_id !== id ||
      attempt.instance !== key.instance ||
      attempt.fence !== key.fence
    )
      throw new RemoteProtocolError("Execution fence does not match.", 409);
    return attempt;
  }

  function live(id: string, key: LeaseKey, fn: (attempt: Attempt, time: number) => void) {
    return transaction(() => {
      const time = now();
      touch(id, time);
      const attempt = fenced(id, key);
      if (attempt.disposition || attempt.expires_at <= time) return false;
      fn(attempt, time);
      return true;
    });
  }

  function matches(location: WorktreeLocation, intent: AgentTurnIntent) {
    return location.workflowId === intent.workflowId && location.branch === intent.branch;
  }

  function validReference(operationId: string, reference: WorkerSessionReference) {
    const operation = operations.get(operationId)!;
    const evidence = operation.evidence;
    const previous = operations.session(operation.intent.workflowId)?.reference;
    return (
      Boolean(evidence?.launchAuthorizedAt) &&
      reference.agent.provider === evidence?.runtime?.provider &&
      isDeepStrictEqual(reference.worktree, evidence?.worktree) &&
      (!evidence?.reference || isDeepStrictEqual(reference, evidence.reference)) &&
      (!previous || isDeepStrictEqual(reference, previous))
    );
  }

  return {
    expire: () => transaction(() => expire(now())),

    enqueue(request: AgentTurnRequest, profile: Omit<Placement, "repository">, timeoutMs: number) {
      const { prompt, ...input } = request;
      return transaction(() => {
        const workflow = getWorkflow(input.workflowId);
        if (!workflow)
          throw new Error("Reconcile the pull request before requesting a remote turn.");
        const session = operations.session(input.workflowId);
        if (
          !operations.get(input.operationId) &&
          session?.remoteWorkerId &&
          session.status === "active" &&
          (session.runtime?.provider !== profile.provider ||
            session.runtime.model !== profile.model)
        )
          throw new Error("Remote continuation requires the recorded provider and model.");
        const remote = { ...profile, timeoutMs };
        const operation = operations.request({
          ...input,
          remote,
          configurationId: digest(JSON.stringify(["remote-v1", profile.provider, profile.model])),
          promptDigest: digest(prompt),
        });
        if (operation.status === "requested")
          db.prepare(
            "INSERT OR IGNORE INTO remote_turns(operation_id, repository, prompt) VALUES (?,?,?)",
          ).run(input.operationId, workflow.identity.repository.toLowerCase(), prompt);
        return operation;
      });
    },

    register(id: string, capabilities: Capabilities) {
      db.prepare(
        `INSERT INTO remote_workers VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET capabilities=excluded.capabilities, seen_at=excluded.seen_at`,
      ).run(id, JSON.stringify(capabilities), now());
    },

    claim(id: string, instance: string): RemoteTask | null {
      return transaction(() => {
        const time = now();
        expire(time);
        touch(id, time);
        // Expiry fences the result, but provides no proof that this worker freed its slot.
        if (
          db
            .prepare(
              "SELECT 1 FROM remote_attempts a JOIN operations o USING(operation_id) WHERE a.worker_id=? AND (a.disposition IS NULL OR o.status IN ('unknown','interrupted'))",
            )
            .get(id)
        )
          return null;
        const { capabilities } = db
          .prepare("SELECT capabilities FROM remote_workers WHERE id=?")
          .get(id) as { capabilities: string };
        const caps = JSON.parse(capabilities) as Capabilities;
        const waiting = db
          .prepare(
            `SELECT t.operation_id,t.repository,t.prompt,o.input FROM remote_turns t
          JOIN operations o USING(operation_id) WHERE o.status='requested' ORDER BY o.created_at,t.operation_id`,
          )
          .all() as Waiting[];
        for (const row of waiting) {
          const intent = JSON.parse(row.input) as RemoteTask["intent"];
          if (
            !caps.profiles.some(
              (profile) =>
                profile.repository === row.repository &&
                profile.provider === intent.remote.provider &&
                profile.model === intent.remote.model,
            )
          )
            continue;
          const claim = operations.claim(row.operation_id, id);
          if (!claim) {
            if (operations.get(row.operation_id)?.status === "completed")
              db.prepare("UPDATE remote_turns SET prompt=NULL WHERE operation_id=?").run(
                row.operation_id,
              );
            continue;
          }
          const fence = randomUUID();
          const deadline = time + intent.remote.timeoutMs;
          db.prepare(
            `INSERT INTO remote_attempts
            (operation_id,worker_id,instance,fence,claimed_at,expires_at,deadline) VALUES (?,?,?,?,?,?,?)`,
          ).run(
            row.operation_id,
            id,
            instance,
            fence,
            time,
            Math.min(time + remoteLeaseMs, deadline),
            deadline,
          );
          db.prepare("UPDATE remote_turns SET prompt=NULL WHERE operation_id=?").run(
            row.operation_id,
          );
          return {
            intent,
            repository: row.repository,
            prompt: row.prompt,
            previous: claim.previous,
            fence,
          };
        }
        return null;
      });
    },

    start(id: string, key: LeaseKey, runtime: AgentRuntime, location: WorktreeLocation) {
      return live(id, key, () => {
        const operation = operations.get(key.operationId)!;
        const previous = operations.session(operation.intent.workflowId);
        if (
          !matches(location, operation.intent) ||
          runtime.provider !== operation.intent.remote?.provider ||
          runtime.model !== operation.intent.remote.model ||
          (previous?.status === "active" &&
            (!isDeepStrictEqual(previous.runtime, runtime) ||
              !previous.reference ||
              !Object.entries(location).every(
                ([key, value]) => Reflect.get(previous.reference!.worktree, key) === value,
              )))
        )
          throw new RemoteProtocolError("Runtime or checkout is incompatible with this turn.", 409);
        if (!operations.start(key.operationId, runtime))
          throw new RemoteProtocolError("Start authorization changed.", 409);
        operations.progress(key.operationId, { expectedWorktree: location });
      });
    },

    launch(id: string, key: LeaseKey, worktree: Worktree) {
      return live(id, key, () => {
        const operation = operations.get(key.operationId)!;
        const previous = operations.session(operation.intent.workflowId)?.reference;
        const { path, repository, branch, workflowId } = worktree;
        const location = { path, repository, branch, workflowId };
        if (
          !isDeepStrictEqual(location, operation.evidence?.expectedWorktree) ||
          (previous && !isDeepStrictEqual(previous.worktree, worktree))
        )
          throw new RemoteProtocolError("Checkout does not match the recorded intent.", 409);
        if (!operations.authorizeLaunch(key.operationId))
          throw new RemoteProtocolError(
            "Launch authorization changed or was already granted.",
            409,
          );
        operations.progress(key.operationId, { worktree });
      });
    },

    renew(id: string, key: LeaseKey, reference?: WorkerSessionReference) {
      return live(id, key, (attempt, time) => {
        if (reference) {
          if (!validReference(key.operationId, reference))
            throw new RemoteProtocolError("Session does not match the authorized checkout.", 409);
          if (!operations.get(key.operationId)?.evidence?.reference)
            operations.progress(key.operationId, { reference });
        }
        db.prepare("UPDATE remote_attempts SET expires_at=? WHERE operation_id=?").run(
          Math.min(time + remoteLeaseMs, attempt.deadline),
          key.operationId,
        );
      });
    },

    complete(id: string, key: LeaseKey, report: AgentTurnEvidence) {
      return transaction(() => {
        const time = now();
        touch(id, time);
        expire(time);
        const attempt = fenced(id, key);
        const receipt = digest(JSON.stringify(report));
        if (attempt.disposition === "reported")
          return attempt.receipt === receipt ? "duplicate" : "conflict";
        if (attempt.disposition === "expired") {
          db.prepare(
            "UPDATE remote_attempts SET late_evidence=? WHERE operation_id=? AND late_evidence IS NULL",
          ).run(JSON.stringify(report), key.operationId);
          return "expired";
        }
        const current = operations.get(key.operationId)!;
        const workspace = report.workspace;
        if (report.reference && !validReference(key.operationId, report.reference)) {
          report = {
            ...report,
            agent: { outcome: "unknown" },
            error: "Remote session evidence does not match the authorized checkout.",
          };
          delete report.reference;
        }
        if (
          report.agent?.outcome === "completed" &&
          (!current.evidence?.launchAuthorizedAt ||
            !report.reference ||
            !report.checkpoint ||
            !workspace ||
            !("head" in workspace) ||
            workspace.head !== current.intent.expectedHead ||
            workspace.changedPaths.length !== 0)
        ) {
          report = {
            ...report,
            error: "Remote completion did not establish a read-only turn at the expected head.",
          };
        }
        const result = operations.finish(key.operationId, report);
        db.prepare(
          "UPDATE remote_attempts SET disposition='reported', receipt=?, finished_at=? WHERE operation_id=?",
        ).run(receipt, time, key.operationId);
        return { status: result.status, error: Boolean(result.error) };
      });
    },

    status() {
      return transaction(() => {
        const time = now();
        expire(time);
        const workers = db.prepare("SELECT * FROM remote_workers ORDER BY id").all() as {
          id: string;
          capabilities: string;
          seen_at: number;
        }[];
        const turns = db
          .prepare(
            `SELECT t.operation_id AS operationId, t.repository, o.input, o.status, o.error,
          a.worker_id AS workerId, a.claimed_at AS claimedAt, a.expires_at AS expiresAt,
          a.finished_at AS finishedAt, a.deadline, a.disposition, a.late_evidence AS lateEvidence,
          json_extract(o.result, '$.launchAuthorizedAt') AS launchAuthorizedAt FROM remote_turns t
          JOIN operations o USING(operation_id) LEFT JOIN remote_attempts a USING(operation_id)
          ORDER BY o.created_at,t.operation_id`,
          )
          .all();
        return {
          workers: workers.map(({ id, capabilities, seen_at }) => ({
            id,
            capabilities: JSON.parse(capabilities) as Capabilities,
            lastSeenAt: seen_at,
            online: time - seen_at < remoteLeaseMs,
            quarantined: turns.some(
              (turn) =>
                turn.workerId === id &&
                (turn.status === "unknown" || turn.status === "interrupted"),
            ),
          })),
          turns: turns.map(({ input, lateEvidence, ...row }) => {
            const intent = JSON.parse(String(input)) as RemoteTask["intent"];
            return {
              ...row,
              workflowId: intent.workflowId,
              requirements: intent.remote,
              waitingForCapacity: row.status === "requested",
              selection: row.workerId
                ? "Matching repository, provider, model, session affinity and available slot"
                : null,
              lateEvidence: lateEvidence
                ? (JSON.parse(String(lateEvidence)) as AgentTurnEvidence)
                : null,
            };
          }),
        };
      });
    },
  };
}
