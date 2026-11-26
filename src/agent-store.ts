import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentContext, AgentFailure, AgentProvider } from "./agent.ts";

export type SessionRecord = {
  id: string;
  placement: "local";
  context: AgentContext;
  nativeId: string | null;
  createdAt: string;
};

export type ExecutionIntent = {
  id: string;
  assignmentId: string;
} & ({ context: AgentContext; sessionId?: never } | { sessionId: string; context?: never });

export type ExecutionRecord = {
  id: string;
  assignmentId: string;
  sessionId: string;
  status: "running" | "completed" | AgentFailure["outcome"];
  reason: string | null;
  claimedAt: string;
  finishedAt: string | null;
};

type Outcome = { outcome: "completed" } | AgentFailure;

export const agentSchema = `
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    placement TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code')),
    working_directory TEXT NOT NULL,
    model TEXT,
    config_directory TEXT,
    native_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(placement, provider, native_id)
  );
  CREATE TABLE agent_executions (
    id TEXT PRIMARY KEY NOT NULL,
    assignment_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    status TEXT NOT NULL CHECK(status IN ('running','completed','not_started','failed','unknown')),
    owner_pid INTEGER,
    reason TEXT,
    claimed_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE UNIQUE INDEX one_dispatched_attempt_per_assignment ON agent_executions(assignment_id)
    WHERE status != 'not_started';
  CREATE UNIQUE INDEX one_unresolved_attempt_per_session ON agent_executions(session_id)
    WHERE status IN ('running','unknown');
`;

export function createAgentStore(
  db: DatabaseSync,
  transaction: <T>(run: () => T) => T,
  ownerAlive: (pid: number) => boolean,
) {
  function get(id: string): ExecutionRecord | null {
    return (
      (db
        .prepare(
          `
        SELECT id, assignment_id AS assignmentId, session_id AS sessionId, status,
               reason, claimed_at AS claimedAt, finished_at AS finishedAt
        FROM agent_executions WHERE id=?
      `,
        )
        .get(id) as ExecutionRecord | undefined) ?? null
    );
  }

  function session(id: string): SessionRecord | null {
    const row = db
      .prepare(
        `
      SELECT id, placement, provider, working_directory AS workingDirectory, model,
             config_directory AS configDirectory, native_id AS nativeId, created_at AS createdAt
      FROM agent_sessions WHERE id=?
    `,
      )
      .get(id) as
      | (Omit<SessionRecord, "context"> & {
          provider: AgentProvider;
          workingDirectory: string;
          model: string | null;
          configDirectory: string | null;
        })
      | undefined;
    if (!row) return null;
    const { provider, workingDirectory, model, configDirectory, ...record } = row;
    return {
      ...record,
      context: {
        provider,
        workingDirectory,
        ...(model === null ? {} : { model }),
        ...(configDirectory === null ? {} : { configDirectory }),
      },
    };
  }

  function finish(id: string, outcome: Outcome): ExecutionRecord {
    const changed = db
      .prepare(
        `
      UPDATE agent_executions
      SET status=?, reason=?, finished_at=?, owner_pid=NULL
      WHERE id=? AND status='running'
    `,
      )
      .run(
        outcome.outcome,
        "reason" in outcome ? outcome.reason : null,
        new Date().toISOString(),
        id,
      );
    if (changed.changes !== 1) throw new Error("Execution no longer has an active claim.");
    return get(id)!;
  }

  function recordSession(executionId: string, nativeId: string): void {
    const changed = db
      .prepare(
        `
        UPDATE agent_sessions SET native_id=?
        WHERE id=(
          SELECT session_id FROM agent_executions WHERE id=? AND status='running' AND owner_pid=?
        ) AND (native_id IS NULL OR native_id=?)
      `,
      )
      .run(nativeId, executionId, process.pid, nativeId);
    if (changed.changes !== 1)
      throw new Error("Could not associate the native session with the active execution.");
  }

  return {
    get,
    session,
    claim(input: ExecutionIntent) {
      return transaction(() => {
        const existing = get(input.id);
        if (existing) {
          const recorded = session(existing.sessionId)!;
          if (
            existing.assignmentId !== input.assignmentId ||
            (input.sessionId !== undefined
              ? existing.sessionId !== input.sessionId
              : recorded.context.provider !== input.context.provider ||
                recorded.context.workingDirectory !== input.context.workingDirectory ||
                recorded.context.model !== input.context.model ||
                recorded.context.configDirectory !== input.context.configDirectory)
          )
            throw new Error("Execution ID already belongs to a different assignment or context.");
          return { claimed: false, execution: existing, session: recorded };
        }
        if (
          db
            .prepare(
              `
          SELECT 1 FROM agent_executions WHERE assignment_id=? AND status != 'not_started'
        `,
            )
            .get(input.assignmentId)
        )
          throw new Error("Assignment already has a dispatched or unresolved attempt.");

        const now = new Date().toISOString();
        let record: SessionRecord;
        if (input.sessionId !== undefined) {
          const saved = session(input.sessionId);
          if (!saved?.nativeId)
            throw new Error("A recorded native session is required for continuation.");
          if (
            db
              .prepare(
                `
            SELECT 1 FROM agent_executions WHERE session_id=? AND status IN ('running','unknown')
          `,
              )
              .get(saved.id)
          )
            throw new Error("Session has an unresolved execution. Inspect it before continuing.");
          record = saved;
        } else {
          const { provider, workingDirectory, model, configDirectory } = input.context;
          const id = randomUUID();
          db.prepare(
            `
            INSERT INTO agent_sessions (id, placement, provider, working_directory, model, config_directory, created_at)
            VALUES (?, 'local', ?, ?, ?, ?, ?)
          `,
          ).run(id, provider, workingDirectory, model ?? null, configDirectory ?? null, now);
          record = session(id)!;
        }
        // The insert records intent and takes the dispatch claim in the same transaction.
        db.prepare(
          `
          INSERT INTO agent_executions (id, assignment_id, session_id, status, owner_pid, claimed_at)
          VALUES (?, ?, ?, 'running', ?, ?)
        `,
        ).run(input.id, input.assignmentId, record.id, process.pid, now);
        return { claimed: true, execution: get(input.id)!, session: record };
      });
    },
    recordSession,
    finish(id: string, outcome: Outcome, nativeId: string | null) {
      return transaction(() => {
        const execution = get(id);
        const owner = db.prepare("SELECT owner_pid FROM agent_executions WHERE id=?").get(id);
        if (execution?.status !== "running" || owner?.owner_pid !== process.pid)
          throw new Error("Execution no longer belongs to this process.");
        if (outcome.outcome === "completed" && nativeId === null)
          throw new Error("Completion requires a native session reference.");
        const saved = session(execution.sessionId)!;
        if (saved.nativeId !== nativeId) {
          if (nativeId === null)
            throw new Error("The recorded native session differs from the execution evidence.");
          recordSession(id, nativeId);
        }
        return { execution: finish(id, outcome), session: session(execution.sessionId)! };
      });
    },
    confirmFinish(claim: ExecutionRecord, outcome: Outcome, nativeId: string | null) {
      // A connection may see its own writes even when their commit failed.
      if (db.isTransaction) return null;
      const execution = get(claim.id);
      if (
        !execution?.finishedAt ||
        execution.assignmentId !== claim.assignmentId ||
        execution.sessionId !== claim.sessionId ||
        execution.claimedAt !== claim.claimedAt ||
        execution.status !== outcome.outcome ||
        execution.reason !== ("reason" in outcome ? outcome.reason : null)
      )
        return null;
      const recordedSession = session(claim.sessionId);
      return recordedSession?.nativeId === nativeId
        ? { execution, session: recordedSession }
        : null;
    },
    recover(): number {
      return transaction(() => {
        const running = db
          .prepare(
            `
          SELECT id, owner_pid AS ownerPid FROM agent_executions WHERE status='running'
        `,
          )
          .all() as { id: string; ownerPid: number }[];
        let recovered = 0;
        for (const { id, ownerPid } of running) {
          // A live or reused PID does not prove the native outcome.
          if (ownerAlive(ownerPid)) continue;
          finish(id, {
            outcome: "unknown",
            reason: "Execution owner exited before recording an outcome.",
          });
          recovered++;
        }
        return recovered;
      });
    },
  };
}
