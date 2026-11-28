import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Attention } from "./pr-store.ts";

export const planSchema = `
  CREATE TABLE plan_executions (
    id TEXT PRIMARY KEY, repository TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL,
    state TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL,
    UNIQUE(repository, path, revision)
  );
  CREATE UNIQUE INDEX one_active_plan_per_repository ON plan_executions(repository)
    WHERE state IN ('running', 'attention');
  CREATE TABLE plan_pull_requests (
    repository TEXT NOT NULL, pull_request INTEGER NOT NULL,
    plan_id TEXT NOT NULL REFERENCES plan_executions(id), increment_number INTEGER NOT NULL,
    PRIMARY KEY (repository, pull_request), UNIQUE(plan_id, increment_number)
  );
`;

export type ApprovedIncrement = { number: number; title: string; scope: string };
export type Approval = {
  repository: string;
  path: string;
  revision: string;
  blobSha: string;
  baseBranch: string;
  increments: ApprovedIncrement[];
};

export type PlanClaim =
  | { outcome: "published"; pullRequest: number; headSha: string }
  | { outcome: "decision_required" | "blocked"; reason: string };

export type PlanAssignment = {
  id: string;
  branch: string;
  agentName: string;
  producerId: number;
  createdAt: string;
  executionIds: string[];
  direction: string | null;
  claim: PlanClaim | null;
};

type OperatorAction =
  | { kind: "stop" | "resume" | "direction"; reason: string }
  | { kind: "retry"; reason: string; assignmentId: string }
  | {
      kind: "associate";
      reason: string;
      assignmentId: string;
      pullRequest: number;
      headSha: string;
    };

type PlanEvent =
  | (OperatorAction & { increment?: number })
  | { kind: "approved" | "completed" }
  | { kind: "attention"; attention: Attention }
  | { kind: "assigned"; increment: number; assignmentId: string }
  | { kind: "associated"; increment: number; pullRequest: number }
  | { kind: "merged"; increment: number; pullRequest: number; headSha: string; mergeSha: string };

export type PlanIncrement = ApprovedIncrement & {
  assignments: PlanAssignment[];
  publication: { pullRequest: number; headSha: string; source: "native" | "operator" } | null;
  merge: { headSha: string; mergeSha: string; mergedAt: string; mergedBy: number } | null;
};

export type PlanExecution = Omit<Approval, "increments"> & {
  id: string;
  version: number;
  approvedAt: string;
  state: "running" | "attention" | "stopped" | "completed";
  attention: Attention | null;
  increments: PlanIncrement[];
  history: (PlanEvent & { at: string })[];
};

export function currentIncrement(plan: PlanExecution) {
  return plan.increments.find(({ merge }) => !merge);
}

export function createPlanStore(db: DatabaseSync, transaction: <T>(run: () => T) => T) {
  function get(id: string): PlanExecution | null {
    const row = db.prepare("SELECT record FROM plan_executions WHERE id=?").get(id);
    return row ? (JSON.parse(String(row.record)) as PlanExecution) : null;
  }

  function list(repository?: string): PlanExecution[] {
    const rows =
      repository === undefined
        ? db.prepare("SELECT record FROM plan_executions ORDER BY rowid").all()
        : db
            .prepare("SELECT record FROM plan_executions WHERE repository=? ORDER BY rowid")
            .all(repository);
    return rows.map((row) => JSON.parse(String(row.record)) as PlanExecution);
  }

  function update(
    previous: PlanExecution,
    change: (plan: PlanExecution) => void,
    events: PlanEvent[] = [],
  ): PlanExecution | null {
    const next = structuredClone(previous);
    change(next);
    next.version++;
    const at = new Date().toISOString();
    next.history.push(...events.map((event) => ({ ...event, at })));
    const active = next.state === "running" || next.state === "attention";
    if (
      active &&
      db
        .prepare(
          "SELECT 1 FROM plan_executions WHERE repository=? AND id!=? AND state IN ('running','attention')",
        )
        .get(next.repository, next.id)
    )
      throw new Error("This repository already has an active plan execution.");
    return db
      .prepare("UPDATE plan_executions SET state=?, version=?, record=? WHERE id=? AND version=?")
      .run(next.state, next.version, JSON.stringify(next), next.id, previous.version).changes
      ? next
      : null;
  }

  return {
    get,
    list,
    approve(approval: Approval) {
      return transaction(() => {
        const existing = db
          .prepare("SELECT id FROM plan_executions WHERE repository=? AND path=? AND revision=?")
          .get(approval.repository, approval.path, approval.revision);
        if (existing) return get(String(existing.id))!;
        if (
          list(approval.repository).some(
            (plan) => plan.state === "running" || plan.state === "attention",
          )
        )
          throw new Error("This repository already has an active plan execution.");
        const at = new Date().toISOString();
        const plan: PlanExecution = {
          ...approval,
          id: randomUUID(),
          version: 0,
          approvedAt: at,
          state: "running",
          attention: null,
          increments: approval.increments.map((increment) => ({
            ...increment,
            assignments: [],
            publication: null,
            merge: null,
          })),
          history: [{ at, kind: "approved" }],
        };
        db.prepare("INSERT INTO plan_executions VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          plan.id,
          plan.repository,
          plan.path,
          plan.revision,
          plan.state,
          plan.version,
          JSON.stringify(plan),
        );
        return plan;
      });
    },
    update(previous: PlanExecution, change: (plan: PlanExecution) => void, ...events: PlanEvent[]) {
      return transaction(() => update(previous, change, events));
    },
    associate(previous: PlanExecution, publication: NonNullable<PlanIncrement["publication"]>) {
      return transaction(() => {
        if (get(previous.id)?.version !== previous.version) return null;
        const { number } = currentIncrement(previous)!;
        const { pullRequest } = publication;
        const owner = db
          .prepare("SELECT plan_id FROM plan_pull_requests WHERE repository=? AND pull_request=?")
          .get(previous.repository, pullRequest);
        if (owner) return null;
        db.prepare("INSERT INTO plan_pull_requests VALUES (?, ?, ?, ?)").run(
          previous.repository,
          pullRequest,
          previous.id,
          number,
        );
        return update(
          previous,
          (plan) => {
            currentIncrement(plan)!.publication = publication;
          },
          [{ kind: "associated", increment: number, pullRequest }],
        );
      });
    },
    operate(id: string, action: OperatorAction) {
      return transaction(() => {
        const plan = get(id);
        if (!plan || plan.state === "completed")
          throw new Error("An unfinished plan execution is required.");
        if (action.kind === "resume" && plan.state === "running")
          throw new Error("The plan is already running.");
        if (action.kind === "retry" || action.kind === "associate") {
          const increment = currentIncrement(plan)!;
          if (
            plan.state !== "attention" ||
            increment.publication ||
            increment.assignments.at(-1)?.id !== action.assignmentId
          )
            throw new Error(
              "Direction must identify the current unassociated assignment on a plan requiring attention.",
            );
        }
        return update(
          plan,
          (next) => {
            if (action.kind === "stop") {
              next.state = "stopped";
              next.attention = {
                reason: action.reason,
                action: "Resume explicitly when the plan can continue.",
                references: [],
              };
            }
            if (action.kind === "resume") {
              next.state = "running";
              next.attention = null;
            }
          },
          [{ ...action, increment: currentIncrement(plan)!.number }],
        )!;
      });
    },
  };
}
