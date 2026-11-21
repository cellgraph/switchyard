import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  boundedText,
  decisions,
  identifier,
  parseFinding,
  parseReviewResult,
  record,
  resolutions,
  reviewHead,
  type FindingInput,
} from "./review.ts";
import type { Workflow, WorkflowCommand } from "./workflow.ts";

export const reviewMigration = `
  CREATE TABLE review_runs (
    id TEXT PRIMARY KEY NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id),
    head_sha TEXT NOT NULL, source TEXT NOT NULL, purpose TEXT NOT NULL, reviewer TEXT NOT NULL,
    status TEXT NOT NULL, eligible INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL, completed_at TEXT, start_evidence TEXT, evidence TEXT, error TEXT, result_digest TEXT
  );
  CREATE INDEX review_runs_by_workflow ON review_runs(workflow_id, head_sha);
  CREATE UNIQUE INDEX one_active_review ON review_runs(workflow_id)
    WHERE eligible=1 AND status='running';
  CREATE TABLE review_findings (
    id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES review_runs(id),
    content TEXT NOT NULL, root_comment_id INTEGER, root_node_id TEXT,
    root_observation TEXT, root_observed_at TEXT, github_thread_id TEXT, thread_observation TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX review_findings_by_run ON review_findings(run_id);
  CREATE TABLE finding_actions (
    id TEXT PRIMARY KEY NOT NULL, finding_id TEXT NOT NULL REFERENCES review_findings(id),
    action TEXT NOT NULL, rationale TEXT NOT NULL, actor TEXT NOT NULL, head_sha TEXT NOT NULL,
    previous_action_id TEXT REFERENCES finding_actions(id), created_at TEXT NOT NULL
  );
  CREATE INDEX finding_actions_by_finding ON finding_actions(finding_id);
  CREATE TABLE review_publications (
    id TEXT PRIMARY KEY NOT NULL, finding_id TEXT NOT NULL REFERENCES review_findings(id),
    action_id TEXT UNIQUE REFERENCES finding_actions(id), bot_login TEXT NOT NULL,
    body TEXT NOT NULL, state TEXT NOT NULL, comment_id INTEGER, node_id TEXT, observation TEXT,
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`;

type ReviewRun = {
  id: string;
  workflow_id: string;
  head_sha: string;
  source: "operator" | "github";
  purpose: string;
  reviewer: string;
  status: string;
  eligible: number;
  started_at: string;
  completed_at: string | null;
  start_evidence: string | null;
  latest_summary: string | null;
  evidence: string | null;
  error: string | null;
  result_digest: string | null;
};

type FindingRow = {
  id: string;
  run_id: string;
  content: string;
  root_comment_id: number | null;
  root_node_id: string | null;
  root_observation: string | null;
  root_observed_at: string | null;
  github_thread_id: string | null;
  thread_observation: string | null;
  created_at: string;
};

type Action = {
  id: string;
  finding_id: string;
  previous_action_id: string | null;
  action: (typeof decisions)[number] | (typeof resolutions)[number];
  rationale: string;
  actor: string;
  head_sha: string;
  created_at: string;
};

export type ImportedFinding = {
  content: FindingInput;
  commentId: number;
  nodeId: string | null;
};

export type CodexSummary = {
  id: number;
  status: "running" | "completed";
  any: boolean | null;
  unresolved: boolean | null;
  updatedAt: string | null;
};

export type CodexObservation =
  | { evidence: string; status: "running"; summaries: CodexSummary[] }
  | {
      evidence: string;
      status: "completed";
      summaries: CodexSummary[];
      findings: ImportedFinding[];
    };

function summaryEdits(evidence: string | null): CodexSummary[] {
  return evidence ? (JSON.parse(evidence) as { summaries: CodexSummary[] }).summaries : [];
}

type SummaryRevision = { summaries: CodexSummary[]; conflicted: boolean };

function compareSummaries(saved: CodexSummary[], incoming: CodexSummary[]) {
  if (!saved.length) return incoming.length ? "newer" : "same";
  if (saved.length !== incoming.length) return "uncertain";
  let older = false;
  let newer = false;
  for (const before of saved) {
    const after = incoming.find(({ id }) => id === before.id);
    if (!after) return "uncertain";
    const change = Date.parse(after.updatedAt ?? "") - Date.parse(before.updatedAt ?? "");
    if (!Number.isFinite(change)) return "uncertain";
    if (change < 0) older = true;
    else if (change > 0) newer = true;
    else if (
      after.status !== before.status ||
      after.any !== before.any ||
      after.unresolved !== before.unresolved
    )
      return "uncertain";
  }
  if (older) return newer ? "uncertain" : "stale";
  return newer ? "newer" : "same";
}

export type CodexParseFailure = { error: string; evidence: string; summaries?: CodexSummary[] };

const codexReviewer = JSON.stringify({
  agent: "chatgpt-codex-connector[bot]",
  provider: "codex",
  model: null,
  configurationId: "github-marker-v1",
  executionId: null,
});

type StoreContext = {
  transaction<T>(run: () => T): T;
  getWorkflow(id: string): Workflow | null;
  transition(id: string, command: WorkflowCommand): Workflow;
};

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const timestamp = () => new Date().toISOString();

export function createReviewStore(db: DatabaseSync, context: StoreContext) {
  const { transaction, getWorkflow, transition } = context;
  const run = (id: string) =>
    db.prepare("SELECT * FROM review_runs WHERE id=?").get(id) as ReviewRun | undefined;
  const activeRun = (workflowId: string) =>
    db
      .prepare(
        "SELECT * FROM review_runs WHERE workflow_id=? AND eligible=1 ORDER BY rowid DESC LIMIT 1",
      )
      .get(workflowId) as ReviewRun | undefined;
  const actions = (id: string) =>
    db
      .prepare("SELECT * FROM finding_actions WHERE finding_id=? ORDER BY rowid")
      .all(id) as Action[];
  function workflow(id: string): Workflow {
    const current = getWorkflow(id);
    if (!current) throw new Error("Review workflow does not exist.");
    return current;
  }

  function insertRun(
    id: string,
    workflowId: string,
    sha: string,
    source: string,
    purpose: string,
    reviewer: string,
  ) {
    db.prepare(
      `INSERT INTO review_runs (id,workflow_id,head_sha,source,purpose,reviewer,status,started_at)
      VALUES (?,?,?,?,?,?,'running',?)`,
    ).run(id, workflowId, sha, source, purpose, reviewer, timestamp());
  }

  function insertFinding(
    runId: string,
    content: FindingInput,
    commentId: number | null = null,
    nodeId: string | null = null,
  ) {
    db.prepare(
      `INSERT INTO review_findings (id,run_id,content,root_comment_id,root_node_id,created_at)
      VALUES (?,?,?,?,?,?)`,
    ).run(randomUUID(), runId, JSON.stringify(content), commentId, nodeId, timestamp());
  }

  function project(
    currentRun: ReviewRun,
    outcome: "completed_clean" | "completed_with_findings" | "in_progress",
  ) {
    transition(currentRun.workflow_id, {
      type: "review_received",
      evidence: { sha: currentRun.head_sha, outcome, runId: currentRun.id },
    });
  }

  function summarize(finding: FindingRow) {
    const history = actions(finding.id);
    const disposition = history.findLast(
      ({ action }) => action === "accepted" || action === "deferred" || action === "rejected",
    );
    const resolution = history.findLast(
      ({ action }) => action === "fixed" || action === "reopened" || action === "superseded",
    );
    const state =
      resolution?.action === "fixed" || resolution?.action === "superseded"
        ? resolution.action
        : "open";
    return {
      ...finding,
      thread_observation: finding.thread_observation
        ? (JSON.parse(finding.thread_observation) as unknown)
        : null,
      content: JSON.parse(finding.content) as FindingInput,
      state,
      disposition: disposition ?? null,
      updatedAt: [finding.created_at, history.at(-1)?.created_at, finding.root_observed_at]
        .filter(Boolean)
        .sort()
        .at(-1),
      pendingDisposition: state === "open" && !disposition,
      actionable: state === "open" && disposition?.action === "accepted",
      history,
      publications: db
        .prepare(
          `SELECT id,action_id,state,comment_id,node_id,observation,error,attempts,updated_at
        FROM review_publications WHERE finding_id=? ORDER BY rowid`,
        )
        .all(finding.id),
    };
  }

  return {
    latestIndeterminate(workflowId: string, head: string): boolean {
      const latest = db
        .prepare(
          `
        SELECT status FROM review_runs WHERE workflow_id=? AND head_sha=? ORDER BY rowid DESC LIMIT 1
      `,
        )
        .get(workflowId, head);
      return ["indeterminate", "unknown", "failed", "interrupted"].includes(String(latest?.status));
    },

    start(input: unknown) {
      const row = record(input);
      const id = identifier(row.id, "review ID");
      if (id.startsWith("github:")) throw new Error("Reserved review ID prefix.");
      const workflowId = boundedText(row.workflowId, "workflow ID", 250);
      const sha = reviewHead(row.headSha);
      const purpose = boundedText(row.purpose, "review purpose", 120);
      const actor = record(row.reviewer);
      const reviewer = JSON.stringify({
        agent: boundedText(actor.agent, "reviewer", 120),
        provider: boundedText(actor.provider, "provider", 120),
        model: actor.model == null ? null : boundedText(actor.model, "model", 160),
        configurationId:
          actor.configurationId == null
            ? null
            : identifier(actor.configurationId, "configuration ID"),
        executionId:
          actor.executionId == null ? null : identifier(actor.executionId, "external execution ID"),
      });
      return transaction(() => {
        const previous = run(id);
        if (previous) {
          if (
            previous.workflow_id !== workflowId ||
            previous.head_sha !== sha ||
            previous.purpose !== purpose ||
            previous.reviewer !== reviewer
          )
            throw new Error("Review ID already belongs to a different request.");
          return previous;
        }
        const current = workflow(workflowId);
        if (
          current.headSha !== sha ||
          ["stopped", "escalated", "validating"].includes(current.state)
        )
          throw new Error(
            "Review start requires the current head of an active workflow outside validation.",
          );
        const active = activeRun(workflowId);
        if (active?.status === "running" && active.source === "operator")
          throw new Error("A review run already awaits an outcome for this workflow.");
        if (
          db
            .prepare(
              `SELECT 1 FROM operations WHERE workflow_id=? AND
          status IN ('pending','requested','dispatching','running') LIMIT 1`,
            )
            .get(workflowId)
        )
          throw new Error("A workflow operation is already in progress.");
        db.prepare("UPDATE review_runs SET eligible=0 WHERE workflow_id=? AND eligible=1").run(
          workflowId,
        );
        insertRun(id, workflowId, sha, "operator", purpose, reviewer);
        const started = run(id)!;
        project(started, "in_progress");
        return started;
      });
    },

    finish(id: string, input: unknown) {
      const sha = reviewHead(record(input).headSha);
      const result = parseReviewResult(input);
      return transaction(() => {
        const current = run(id);
        if (!current || current.source !== "operator")
          throw new Error("Operator review run does not exist.");
        if (current.head_sha !== sha)
          throw new Error("Review outcome must name the original reviewed head.");
        const resultDigest = digest(result);
        if (current.status !== "running") {
          if (current.result_digest !== resultDigest)
            throw new Error("Review already has a different outcome.");
          return current;
        }
        const complete = result.status === "completed";
        db.prepare(
          `UPDATE review_runs SET status=?, completed_at=?, evidence=?, error=?, result_digest=?
          WHERE id=?`,
        ).run(
          result.status,
          timestamp(),
          complete ? result.evidence : null,
          complete ? null : result.error,
          resultDigest,
          id,
        );
        if (complete) for (const finding of result.findings) insertFinding(id, finding);
        const w = workflow(current.workflow_id);
        if (current.eligible && current.head_sha === w.headSha && w.state === "review_running") {
          if (complete)
            project(
              current,
              result.findings.length ? "completed_with_findings" : "completed_clean",
            );
          else
            transition(w.id, {
              type: "review_invalidated",
              reason: `Review run ${id} ended with status ${result.status}.`,
            });
        }
        return run(id)!;
      });
    },

    observeCodex(
      workflowId: string,
      sha: string,
      observation: CodexObservation | CodexParseFailure | null,
    ) {
      transaction(() => {
        const current = workflow(workflowId);
        if (current.headSha !== sha || current.state === "stopped" || current.state === "escalated")
          return;
        const previous = activeRun(workflowId);
        if (previous?.source === "operator") return;
        function recordParseFailure(failure: CodexParseFailure) {
          const resultDigest = digest(failure);
          const saved = db
            .prepare(
              `SELECT 1 FROM review_runs WHERE workflow_id=? AND head_sha=?
            AND source='github' AND status='indeterminate' AND result_digest=? LIMIT 1`,
            )
            .get(workflowId, sha, resultDigest);
          if (saved) return;
          const now = timestamp();
          db.prepare(
            `INSERT INTO review_runs(id, workflow_id, head_sha, source, purpose, reviewer,
            status, eligible, started_at, completed_at, evidence, error, result_digest)
            VALUES(?,?,?,'github','code',?,'indeterminate',0,?,?,?,?,?)`,
          ).run(
            `github:${randomUUID()}`,
            workflowId,
            sha,
            codexReviewer,
            now,
            now,
            failure.evidence,
            failure.error,
            resultDigest,
          );
        }
        function invalidate(reason: string) {
          if (previous && current?.review)
            transition(workflowId, { type: "review_invalidated", reason });
        }

        if (observation === null) {
          invalidate("Codex review evidence is no longer visible.");
          return;
        }
        function saveSummary(id: string, summaries: CodexSummary[], conflicted = false) {
          const revision: SummaryRevision = { summaries, conflicted };
          db.prepare("UPDATE review_runs SET latest_summary=? WHERE id=?").run(
            JSON.stringify(revision),
            id,
          );
        }
        const saved: SummaryRevision = previous?.latest_summary
          ? (JSON.parse(previous.latest_summary) as SummaryRevision)
          : {
              summaries: summaryEdits(previous?.evidence ?? previous?.start_evidence ?? null),
              conflicted: false,
            };
        const order = observation.summaries
          ? compareSummaries(saved.summaries, observation.summaries)
          : "unavailable";
        if (order === "stale") return;
        if (previous && (order === "uncertain" || (saved.conflicted && order === "same"))) {
          saveSummary(previous.id, saved.summaries, true);
          if ("error" in observation) recordParseFailure(observation);
          invalidate("Codex summary revision order is uncertain.");
          return;
        }

        if ("error" in observation) {
          if (previous && observation.summaries && order === "newer")
            saveSummary(previous.id, observation.summaries);
          recordParseFailure(observation);
          invalidate("Codex review evidence became indeterminate.");
          return;
        }

        if (observation.status === "running") {
          if (previous?.status === "running") {
            if (order === "newer") saveSummary(previous.id, observation.summaries);
            if (!current.review) project(previous, "in_progress");
            return;
          }
          const id = `github:${randomUUID()}`;
          db.prepare("UPDATE review_runs SET eligible=0 WHERE workflow_id=? AND eligible=1").run(
            workflowId,
          );
          insertRun(id, workflowId, sha, "github", "code", codexReviewer);
          db.prepare("UPDATE review_runs SET start_evidence=? WHERE id=?").run(
            observation.evidence,
            id,
          );
          saveSummary(id, observation.summaries);
          project(run(id)!, "in_progress");
          return;
        }

        if (previous?.status === "running") {
          const started = summaryEdits(previous.start_evidence);
          if (!started.length || compareSummaries(started, observation.summaries) !== "newer") {
            invalidate("Codex did not confirm completion of the observed running review.");
            return;
          }
          if (order === "newer") saveSummary(previous.id, observation.summaries);
          // Receipts and inline comments for a previous review of this SHA can still be visible.
          const existingFindings = db
            .prepare(
              `SELECT f.root_comment_id AS id FROM review_findings f
            JOIN review_runs r ON f.run_id=r.id
            WHERE r.workflow_id=? AND r.head_sha=? AND r.source='github'`,
            )
            .all(workflowId, sha);
          if (
            observation.findings.some(({ commentId }) =>
              existingFindings.some(({ id }) => id === commentId),
            )
          ) {
            recordParseFailure({
              error: "Codex findings overlap an earlier run on this head.",
              evidence: observation.evidence,
            });
            invalidate("Codex findings overlap an earlier run on this head.");
            return;
          }
        }
        // An edited source finding requires operator review. Existing findings retain their IDs.
        const resultDigest = digest(observation.findings);
        if (previous && previous.status !== "running") {
          if (order === "newer") saveSummary(previous.id, observation.summaries);
          if (previous.result_digest !== resultDigest) {
            recordParseFailure({
              error: "Codex review source findings changed.",
              evidence: observation.evidence,
            });
            invalidate("Codex review source findings changed.");
          } else if (!current.review) {
            project(
              previous,
              observation.findings.length ? "completed_with_findings" : "completed_clean",
            );
          }
          return;
        }
        const priorCapture =
          !previous &&
          (db
            .prepare(
              `SELECT * FROM review_runs WHERE workflow_id=? AND head_sha=?
          AND source='github' AND result_digest=? ORDER BY rowid DESC LIMIT 1`,
            )
            .get(workflowId, sha, resultDigest) as ReviewRun | undefined);
        if (priorCapture) {
          db.prepare("UPDATE review_runs SET eligible=1 WHERE id=?").run(priorCapture.id);
          saveSummary(priorCapture.id, observation.summaries);
          project(
            priorCapture,
            observation.findings.length ? "completed_with_findings" : "completed_clean",
          );
          return;
        }
        const id = previous?.id ?? `github:${randomUUID()}`;
        const now = timestamp();
        if (!previous) insertRun(id, workflowId, sha, "github", "code", codexReviewer);
        db.prepare(
          "UPDATE review_runs SET status='completed', completed_at=?, evidence=?, result_digest=? WHERE id=?",
        ).run(now, observation.evidence, resultDigest, id);
        saveSummary(id, observation.summaries);
        for (const finding of observation.findings) {
          const content = parseFinding(finding.content);
          insertFinding(id, content, finding.commentId, finding.nodeId);
        }
        project(
          run(id)!,
          observation.findings.length ? "completed_with_findings" : "completed_clean",
        );
      });
    },

    act(input: unknown) {
      const row = record(input);
      const id = identifier(row.id, "action ID");
      const findingId = identifier(row.findingId, "finding ID");
      const action = [...decisions, ...resolutions].find((action) => action === row.action);
      if (!action) throw new Error("Invalid finding decision or resolution.");
      const actor = boundedText(row.actor, "decision actor", 160);
      const rationale = boundedText(row.rationale, "rationale");
      const sha = reviewHead(row.headSha);
      const previousActionId =
        row.previousActionId == null
          ? null
          : identifier(row.previousActionId, "previous action ID");
      return transaction(() => {
        const previous = db.prepare("SELECT * FROM finding_actions WHERE id=?").get(id) as
          Action | undefined;
        if (previous) {
          if (
            previous.finding_id !== findingId ||
            previous.action !== action ||
            previous.actor !== actor ||
            previous.rationale !== rationale ||
            previous.head_sha !== sha ||
            previous.previous_action_id !== previousActionId
          )
            throw new Error("Action ID already belongs to a different decision.");
          return previous;
        }
        const finding = db.prepare("SELECT * FROM review_findings WHERE id=?").get(findingId) as
          FindingRow | undefined;
        if (!finding) throw new Error("Review finding does not exist.");
        const current = workflow(run(finding.run_id)!.workflow_id);
        if (current.headSha !== sha)
          throw new Error("Finding action must use the current workflow head.");
        const status = summarize(finding);
        if ((status.history.at(-1)?.id ?? null) !== previousActionId)
          throw new Error("Finding history changed. Supply the latest action ID.");
        if (status.actionable && (action === "deferred" || action === "rejected"))
          throw new Error(
            "An accepted open finding requires a verified fix or explicit supersession.",
          );
        if (
          action === "reopened"
            ? status.state === "open"
            : action === "fixed"
              ? !status.actionable
              : status.state !== "open"
        )
          throw new Error(`Cannot record ${action} for this finding in its current state.`);
        db.prepare(
          `INSERT INTO finding_actions (id,finding_id,action,rationale,actor,head_sha,previous_action_id,created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
        ).run(id, findingId, action, rationale, actor, sha, previousActionId, timestamp());
        return db.prepare("SELECT * FROM finding_actions WHERE id=?").get(id) as Action;
      });
    },

    inspect(workflowId: string) {
      return transaction(() => {
        const current = workflow(workflowId);
        const runs = db
          .prepare("SELECT * FROM review_runs WHERE workflow_id=? ORDER BY rowid")
          .all(workflowId) as ReviewRun[];
        const summaries = runs.map(({ reviewer, ...run }) => ({
          ...run,
          reviewer: JSON.parse(reviewer) as unknown,
          findings: (
            db
              .prepare("SELECT * FROM review_findings WHERE run_id=? ORDER BY rowid")
              .all(run.id) as FindingRow[]
          ).map(summarize),
        }));
        return {
          workflowId,
          identity: current.identity,
          headSha: current.headSha,
          state: current.state,
          projectedReview: current.review,
          runs: summaries,
          pendingDispositions: summaries.flatMap(({ findings }) =>
            findings.filter((finding) => finding.pendingDisposition).map(({ id }) => id),
          ),
          actionableFindings: summaries.flatMap(({ findings }) =>
            findings.filter((finding) => finding.actionable).map(({ id }) => id),
          ),
        };
      });
    },
  };
}
