import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentSelection, RexPlacement } from "./agent-config.ts";
import type { AgentContext, AgentFailure, AgentProvider } from "./agent.ts";

export type SessionRecord = {
  id: string;
  placement: "local" | "rex";
  agentName?: string;
  rex?: RexPlacement;
  context: AgentContext;
  nativeId: string | null;
  createdAt: string;
};

export type ExecutionIntent = {
  id: string;
  assignmentId: string;
} & (
  | (AgentSelection & { sessionId?: never })
  | { sessionId: string; context?: never; agentName?: never; rex?: never }
);

type RemoteAttempt = {
  key: string;
  expectedNativeId: string | null;
  launchAuthorized: boolean;
  acknowledgedBlockId: string | null;
  blockId: string | null;
  blockConflict?: string;
  resultDigest: string | null;
};

export type ExecutionRecord = {
  id: string;
  assignmentId: string;
  sessionId: string;
  status: "running" | "completed" | AgentFailure["outcome"];
  reason: string | null;
  claimedAt: string;
  finishedAt: string | null;
  remote?: RemoteAttempt;
};

type Outcome = { outcome: "completed" } | AgentFailure;

export const agentSchema = `
  CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    placement TEXT NOT NULL,
    agent_name TEXT,
    rex_config TEXT,
    provider TEXT NOT NULL CHECK(provider IN ('codex','claude-code')),
    working_directory TEXT NOT NULL,
    model TEXT,
    reasoning_effort TEXT,
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
    remote_key TEXT UNIQUE,
    expected_native_id TEXT,
    remote_launch_authorized INTEGER NOT NULL DEFAULT 1 CHECK(remote_launch_authorized IN (0,1)),
    remote_acknowledged_block_id TEXT,
    remote_block_id TEXT,
    remote_result_digest TEXT,
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
    const row = db
      .prepare(
        `
        SELECT id, assignment_id AS assignmentId, session_id AS sessionId, status,
               reason, claimed_at AS claimedAt, finished_at AS finishedAt,
               remote_key AS key, expected_native_id AS expectedNativeId,
               remote_launch_authorized AS launchAuthorized,
               remote_acknowledged_block_id AS acknowledgedBlockId,
               remote_block_id AS blockId, remote_result_digest AS resultDigest
        FROM agent_executions WHERE id=?
      `,
      )
      .get(id) as
      | (ExecutionRecord &
          Omit<RemoteAttempt, "key" | "launchAuthorized"> & {
            key: string | null;
            launchAuthorized: number;
          })
      | undefined;
    if (!row) return null;
    const {
      key,
      expectedNativeId,
      launchAuthorized,
      acknowledgedBlockId,
      blockId,
      resultDigest,
      ...execution
    } = row;
    return {
      ...execution,
      ...(key === null
        ? {}
        : {
            remote: {
              key,
              expectedNativeId,
              launchAuthorized: launchAuthorized === 1,
              acknowledgedBlockId,
              blockId,
              resultDigest,
              ...(acknowledgedBlockId && blockId && acknowledgedBlockId !== blockId
                ? {
                    blockConflict:
                      "The Rex launch acknowledgement conflicts with executor evidence.",
                  }
                : {}),
            },
          }),
    };
  }

  function session(id: string): SessionRecord | null {
    const row = db
      .prepare(
        `
      SELECT id, agent_name AS agentName, rex_config AS rex, provider, working_directory AS workingDirectory, model,
             reasoning_effort AS reasoningEffort, config_directory AS configDirectory, native_id AS nativeId, created_at AS createdAt
      FROM agent_sessions WHERE id=?
    `,
      )
      .get(id) as
      | (Omit<SessionRecord, "context" | "placement" | "rex" | "agentName"> & {
          agentName: string | null;
          rex: string | null;
          provider: AgentProvider;
          workingDirectory: string;
          model: string | null;
          reasoningEffort: NonNullable<AgentContext["reasoningEffort"]> | null;
          configDirectory: string | null;
        })
      | undefined;
    if (!row) return null;
    const {
      provider,
      workingDirectory,
      model,
      reasoningEffort,
      configDirectory,
      agentName,
      rex,
      ...record
    } = row;
    return {
      ...record,
      placement: rex ? "rex" : "local",
      ...(rex ? { rex: JSON.parse(rex) as RexPlacement } : {}),
      ...(agentName === null ? {} : { agentName }),
      context: {
        provider,
        workingDirectory,
        ...(model === null ? {} : { model }),
        ...(reasoningEffort === null ? {} : { reasoningEffort }),
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
          SELECT session_id FROM agent_executions WHERE id=? AND remote_key IS NULL AND status='running' AND owner_pid=?
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
    forAssignment(assignmentId: string): ExecutionRecord[] {
      return db
        .prepare("SELECT id FROM agent_executions WHERE assignment_id=? ORDER BY rowid")
        .all(assignmentId)
        .map((row) => get(String(row.id))!);
    },
    unresolvedRemote(): string[] {
      return db
        .prepare(
          "SELECT id FROM agent_executions WHERE remote_key IS NOT NULL AND status IN ('running','unknown') AND remote_result_digest IS NULL ORDER BY claimed_at, id",
        )
        .all()
        .map((row) => String(row.id));
    },
    authorizeRemoteDispatch(id: string, mayLaunch: () => boolean = () => true): boolean {
      return transaction(
        () =>
          mayLaunch() &&
          db
            .prepare(
              `
        UPDATE agent_executions SET remote_launch_authorized=1
        WHERE id=? AND remote_key IS NOT NULL AND status='running'
          AND remote_launch_authorized=0 AND owner_pid=?
      `,
            )
            .run(id, process.pid).changes === 1,
      );
    },
    recoverRemotePrelaunch(id: string): void {
      const owner = db
        .prepare(
          `
        SELECT owner_pid AS pid FROM agent_executions
        WHERE id=? AND remote_key IS NOT NULL AND status='running' AND remote_launch_authorized=0
      `,
        )
        .get(id) as { pid: number } | undefined;
      if (!owner || ownerAlive(owner.pid)) return;
      // This update and dispatch authorization compete for the same pending claim.
      db.prepare(
        `
        UPDATE agent_executions SET status='not_started', reason=?, finished_at=?, owner_pid=NULL
        WHERE id=? AND status='running' AND remote_launch_authorized=0 AND owner_pid=?
      `,
      ).run(
        "Execution owner exited before authorizing Rex dispatch.",
        new Date().toISOString(),
        id,
        owner.pid,
      );
    },
    recordRemoteAcknowledgement(id: string, blockId: string): void {
      db.prepare(
        `
        UPDATE agent_executions SET remote_acknowledged_block_id=?
        WHERE id=? AND remote_key IS NOT NULL AND remote_launch_authorized=1
          AND remote_acknowledged_block_id IS NULL
      `,
      ).run(blockId, id);
    },
    recordRemote(
      id: string,
      evidence: {
        blockId?: string;
        nativeId?: string | null;
        outcome?: Outcome;
        digest?: string;
      },
    ) {
      return transaction(() => {
        const execution = get(id);
        if (!execution?.remote) throw new Error("Remote execution record not found.");
        const remote = execution.remote;
        if (
          !remote.launchAuthorized &&
          (evidence.outcome?.outcome !== "not_started" ||
            evidence.blockId ||
            evidence.nativeId !== undefined ||
            evidence.digest)
        )
          return false;
        const saved = session(execution.sessionId)!;
        const unresolved = execution.status === "running" || execution.status === "unknown";
        if (
          (evidence.blockId && remote.blockId && evidence.blockId !== remote.blockId) ||
          (evidence.digest && remote.resultDigest && evidence.digest !== remote.resultDigest) ||
          (evidence.nativeId !== undefined && remote.resultDigest && !evidence.digest) ||
          (saved.nativeId !== null &&
            (evidence.nativeId || (evidence.digest && evidence.nativeId === null)) &&
            evidence.nativeId !== saved.nativeId) ||
          (evidence.digest && !unresolved && !remote.resultDigest)
        )
          return false;
        if (!unresolved || remote.resultDigest) return true;
        if (evidence.nativeId && saved.nativeId === null) {
          const used = db
            .prepare(
              "SELECT 1 FROM agent_sessions WHERE placement=? AND provider=? AND native_id=?",
            )
            .get(saved.rex!.endpoint, saved.context.provider, evidence.nativeId);
          if (used) return false;
          db.prepare("UPDATE agent_sessions SET native_id=? WHERE id=?").run(
            evidence.nativeId,
            saved.id,
          );
        }
        if (evidence.blockId && !remote.blockId)
          db.prepare("UPDATE agent_executions SET remote_block_id=? WHERE id=?").run(
            evidence.blockId,
            id,
          );
        const outcome = evidence.outcome;
        if (
          outcome &&
          (execution.status !== "unknown" || outcome.outcome !== "unknown" || evidence.digest)
        )
          db.prepare(
            `
            UPDATE agent_executions SET status=?, reason=?, finished_at=?, owner_pid=NULL, remote_result_digest=?
            WHERE id=?
          `,
          ).run(
            outcome.outcome,
            "reason" in outcome ? outcome.reason : null,
            new Date().toISOString(),
            evidence.digest ?? null,
            id,
          );
        return true;
      });
    },
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
                recorded.context.reasoningEffort !== input.context.reasoningEffort ||
                recorded.context.configDirectory !== input.context.configDirectory ||
                recorded.agentName !== input.agentName ||
                JSON.stringify(recorded.rex) !== JSON.stringify(input.rex))
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
          const { provider, workingDirectory, model, reasoningEffort, configDirectory } =
            input.context;
          const id = randomUUID();
          db.prepare(
            `
            INSERT INTO agent_sessions (id, placement, agent_name, rex_config, provider, working_directory, model, reasoning_effort, config_directory, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          ).run(
            id,
            input.rex?.endpoint ?? "local",
            input.agentName ?? null,
            input.rex ? JSON.stringify(input.rex) : null,
            provider,
            workingDirectory,
            model ?? null,
            reasoningEffort ?? null,
            configDirectory ?? null,
            now,
          );
          record = session(id)!;
        }
        // The insert records intent and takes the dispatch claim in the same transaction.
        db.prepare(
          `
          INSERT INTO agent_executions (id, assignment_id, session_id, status, owner_pid, claimed_at, remote_key, expected_native_id, remote_launch_authorized)
          VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
        `,
        ).run(
          input.id,
          input.assignmentId,
          record.id,
          process.pid,
          now,
          record.rex ? randomUUID() : null,
          record.rex ? record.nativeId : null,
          record.rex ? 0 : 1,
        );
        return { claimed: true, execution: get(input.id)!, session: record };
      });
    },
    recordSession,
    finish(id: string, outcome: Outcome, nativeId: string | null) {
      return transaction(() => {
        const execution = get(id);
        const owner = db
          .prepare("SELECT owner_pid FROM agent_executions WHERE id=? AND remote_key IS NULL")
          .get(id);
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
          SELECT id, owner_pid AS ownerPid FROM agent_executions WHERE status='running' AND remote_key IS NULL
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
