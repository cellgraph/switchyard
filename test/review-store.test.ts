import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../src/store.ts";
import type { FindingDisposition, ReviewMetadata } from "../src/review.ts";

const workflowId = "owner/repo#7";
const head = "a".repeat(40);
const nextHead = "b".repeat(40);
const currentSchemaVersion = 23;
const completedAt = "2026-01-01T00:00:00.000Z";
const review = {
  id: "review-1",
  workflowId,
  headSha: head,
  githubReviewId: 101,
  outcome: "findings",
  completedAt,
  findingCommentIds: [201, 202, 203, 204, 205, 206],
} satisfies ReviewMetadata;

let directory: string;
let path: string;
let store: WorkflowStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "switchyard-review-"));
  path = join(directory, "switchyard.sqlite");
  store = new WorkflowStore(path);
  store.createWorkflow({
    id: workflowId,
    identity: { repository: "owner/repo", pullRequest: 7 },
    state: "awaiting_review",
    headSha: head,
    requiredChecks: null,
    checks: [],
    escalationReason: null,
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("fresh database and durable review references", () => {
  it("refuses an earlier schema without modifying it", () => {
    const legacyPath = join(directory, "legacy.sqlite");
    const legacySchema = `
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES (15);
      CREATE TABLE fix_cycles (id TEXT PRIMARY KEY);
      INSERT INTO fix_cycles VALUES ('saved');
    `;
    using raw = new DatabaseSync(legacyPath);
    raw.exec(legacySchema);
    expect(() => new WorkflowStore(legacyPath)).toThrow(/Use a fresh SWITCHYARD_DB_PATH/);
    expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(0);
    expect(raw.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    expect(raw.prepare("SELECT id FROM fix_cycles").get()?.id).toBe("saved");
    expect(raw.prepare("SELECT version FROM schema_migrations").get()?.version).toBe(15);
  });

  it("sets both identity and version for a fresh database", () => {
    using raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("PRAGMA application_id").get()?.application_id).toBe(0x53575944);
    expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(currentSchemaVersion);
    const tables = raw
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "workflows",
        "transitions",
        "agent_sessions",
        "agent_executions",
        "check_snapshots",
        "review_runs",
        "review_findings",
        "github_rate_limits",
        "github_observation_generations",
        "reconciliation_retries",
        "controller_worker",
        "pr_initiations",
        "pr_assignments",
        "pr_operator_events",
        "pr_attention",
        "plan_executions",
        "plan_pull_requests",
      ]),
    );
    for (const obsolete of ["review_snapshots", "review_publications", "finding_actions"])
      expect(tables).not.toContain(obsolete);
    expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'deliver%'").all()).toEqual(
      [],
    );
    expect(
      raw
        .prepare("PRAGMA table_info(workflows)")
        .all()
        .map((row) => row.name),
    ).not.toContain("review");
  });

  it.each([
    [
      "same version without an application ID",
      `PRAGMA user_version = ${currentSchemaVersion}; CREATE TABLE data (value TEXT);`,
    ],
    [
      "same version with a foreign application ID",
      `PRAGMA application_id = 42; PRAGMA user_version = ${currentSchemaVersion}; CREATE TABLE data (value TEXT);`,
    ],
    ["foreign application ID on an empty schema", "PRAGMA application_id = 42;"],
    [
      "Switchyard identity with an unsupported version",
      "PRAGMA application_id = 0x53575944; PRAGMA user_version = 19;",
    ],
  ])("rejects %s without modifying the database", (_scenario, setup) => {
    const foreignPath = join(directory, "foreign.sqlite");
    {
      using raw = new DatabaseSync(foreignPath);
      raw.exec(setup);
    }
    const before = readFileSync(foreignPath);
    const files = readdirSync(directory);
    expect(() => new WorkflowStore(foreignPath)).toThrow(/Use a fresh SWITCHYARD_DB_PATH/);
    expect(readFileSync(foreignPath).equals(before)).toBe(true);
    expect(readdirSync(directory)).toEqual(files);
  });

  it("rejects a foreign database with an uncheckpointed WAL without modifying either file", () => {
    const foreignPath = join(directory, "foreign-wal.sqlite");
    const writer = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA user_version = ${currentSchemaVersion}; PRAGMA application_id = 42; CREATE TABLE data (value TEXT)");
        db.exec("PRAGMA journal_mode = WAL; INSERT INTO data VALUES ('saved')");
        process.kill(process.pid, "SIGKILL");
      `,
      foreignPath,
    ]);
    expect(writer.signal).toBe("SIGKILL");
    const walPath = foreignPath + "-wal";
    const before = readFileSync(foreignPath);
    const wal = readFileSync(walPath);
    expect(wal.length).toBeGreaterThan(0);
    const files = readdirSync(directory);
    expect(() => new WorkflowStore(foreignPath)).toThrow(/Use a fresh SWITCHYARD_DB_PATH/);
    expect(readFileSync(foreignPath).equals(before)).toBe(true);
    expect(readFileSync(walPath).equals(wal)).toBe(true);
    expect(readdirSync(directory)).toEqual(files);
  });

  it("persists review and finding references and dispositions across connections and restart", () => {
    const reviews = store.reviews();
    const reasoning = { kind: "review_comment", id: 701 } as const;
    const dispositions: FindingDisposition[] = [
      { decision: "accept", reasoning },
      { decision: "accept", reasoning, claimedResolvingHeadSha: nextHead },
      { decision: "reject", reasoning },
      { decision: "escalate", reasoning: { kind: "issue_comment", id: 702 } },
      { decision: "defer", reasoning, issue: { repository: "owner/repo", number: 8 } },
    ];
    reviews.record(review);
    for (const [index, disposition] of dispositions.entries()) {
      const withExtraFields = { ...disposition, body: "Substantive reasoning belongs on GitHub" };
      reviews.setDisposition(review.id, review.findingCommentIds[index]!, withExtraFields, null);
    }
    reviews.record({ ...review, findingCommentIds: [...review.findingCommentIds].reverse() });
    expect(() => reviews.record({ ...review, headSha: nextHead })).toThrow(/different metadata/);
    expect(() => reviews.setDisposition(review.id, 999, dispositions[0]!, null)).toThrow(
      /does not exist/,
    );

    store.close();
    store = new WorkflowStore(path);
    const { findingCommentIds, ...row } = review;
    expect(store.reviews().list(workflowId, head)).toEqual([
      {
        ...row,
        findings: findingCommentIds.map((githubCommentId, index) => ({
          githubCommentId,
          disposition: dispositions[index] ?? null,
        })),
      },
    ]);
    using raw = new DatabaseSync(path, { readOnly: true });
    expect(JSON.stringify(raw.prepare("SELECT * FROM review_findings").all())).not.toContain(
      "Substantive reasoning",
    );
  });

  it("rejects a second owner for a finding within the workflow across heads and rolls back the review", () => {
    const reviews = store.reviews();
    reviews.record(review);
    store.transition(workflowId, { type: "head_changed", sha: nextHead });
    const nextReview = {
      ...review,
      id: "review-2",
      headSha: nextHead,
      githubReviewId: 102,
      findingCommentIds: [200, 201],
    };
    expect(() => reviews.record(nextReview)).toThrow(
      /Finding 201 already belongs to review review-1/,
    );
    expect(reviews.list(workflowId, nextHead)).toEqual([]);
    reviews.record({ ...nextReview, findingCommentIds: [200] });
    reviews.record(review);
    expect(
      reviews.list(workflowId, head)[0]?.findings.map((finding) => finding.githubCommentId),
    ).toEqual(review.findingCommentIds);
    expect(reviews.list(workflowId, nextHead)[0]?.findings).toEqual([
      { githubCommentId: 200, disposition: null },
    ]);

    const otherId = "owner/repo#8";
    store.createWorkflow({
      ...store.getWorkflow(workflowId)!,
      id: otherId,
      identity: { repository: "owner/repo", pullRequest: 8 },
    });
    reviews.record({ ...review, id: "other-review", workflowId: otherId });
    expect(reviews.list(otherId)).toHaveLength(1);
  });

  it("guards replacements across connections and preserves a claimed resolving SHA on replay", () => {
    const reviews = store.reviews();
    reviews.record(review);
    const other = new WorkflowStore(path);
    try {
      const concurrentReviews = other.reviews();
      const reasoning = { kind: "review_comment", id: 701 } as const;
      const accept = { decision: "accept", reasoning } satisfies FindingDisposition;
      const resolving = { ...accept, claimedResolvingHeadSha: nextHead };
      const reject = {
        decision: "reject",
        reasoning: { ...reasoning, id: 702 },
      } satisfies FindingDisposition;
      const readDisposition = () => reviews.list(workflowId)[0]!.findings[0]!.disposition;

      reviews.setDisposition(review.id, 201, accept, null);
      concurrentReviews.setDisposition(review.id, 201, resolving, accept);
      // The original expected value is stale, but the requested metadata is already stored.
      reviews.setDisposition(
        review.id,
        201,
        { ...resolving, claimedResolvingHeadSha: nextHead.toUpperCase() },
        accept,
      );
      expect(() => reviews.setDisposition(review.id, 201, accept, null)).toThrow(
        /expected prior value/,
      );
      expect(() => reviews.setDisposition(review.id, 201, reject, accept)).toThrow(
        /expected prior value/,
      );
      expect(readDisposition()).toEqual(resolving);
      reviews.setDisposition(review.id, 201, reject, {
        ...resolving,
        claimedResolvingHeadSha: nextHead.toUpperCase(),
      });
      concurrentReviews.setDisposition(review.id, 201, reject, resolving);
      expect(readDisposition()).toEqual(reject);
    } finally {
      other.close();
    }
  });

  it("keeps evidence by workflow and reviewed head without promoting an unverified result", () => {
    const reviews = store.reviews();
    const clean: ReviewMetadata = { ...review, outcome: "clean", findingCommentIds: [] };
    const passCI = (sha: string) =>
      store.transition(workflowId, {
        type: "checks_received",
        configuredNames: ["CI"],
        evidence: [{ name: "CI", sha, outcome: "passed" }],
      });

    passCI(head);
    expect(store.getWorkflow(workflowId)?.state).toBe("awaiting_review");
    reviews.record(clean);
    passCI(head);
    expect(store.getWorkflow(workflowId)?.state).toBe("awaiting_review");
    store.transition(workflowId, { type: "head_changed", sha: nextHead });
    passCI(nextHead);
    expect(reviews.list(workflowId, nextHead)).toEqual([]);
    expect(store.getWorkflow(workflowId)?.state).toBe("awaiting_review");

    reviews.record({
      ...review,
      id: "review-2",
      githubReviewId: null,
      outcome: "incomplete",
      completedAt: null,
      findingCommentIds: [],
      headSha: nextHead,
    });
    store.transition(workflowId, { type: "github_pull_request", sha: nextHead, status: "closed" });
    store.transition(workflowId, { type: "github_pull_request", sha: head, status: "eligible" });
    passCI(head);
    expect(store.getWorkflow(workflowId)?.state).toBe("awaiting_review");
    expect(reviews.list(workflowId, head)).toMatchObject([{ id: review.id, outcome: "clean" }]);
    expect(reviews.list(workflowId, nextHead)).toMatchObject([
      { id: "review-2", outcome: "incomplete" },
    ]);
    expect(reviews.list("owner/repo#99")).toEqual([]);
  });

  it("rejects inconsistent completion and finding references", () => {
    const reviews = store.reviews();
    for (const input of [
      { ...review, headSha: "abc" },
      { ...review, githubReviewId: null },
      { ...review, completedAt: null },
      { ...review, findingCommentIds: [] },
      { ...review, findingCommentIds: [101, 101] },
      { ...review, workflowId: "missing" },
    ])
      expect(() => reviews.record(input)).toThrow();
    expect(reviews.list(workflowId)).toEqual([]);
  });

  it("rolls back the review and previous findings if any finding insert fails", () => {
    using raw = new DatabaseSync(path);
    raw.exec(`CREATE TRIGGER reject_test_finding BEFORE INSERT ON review_findings
      WHEN new.github_comment_id=202
      BEGIN SELECT RAISE(ABORT, 'Test persistence failure'); END;`);
    expect(() => store.reviews().record(review)).toThrow(/Test persistence failure/);
    expect(store.reviews().list(workflowId)).toEqual([]);
    expect(raw.prepare("SELECT * FROM review_findings").all()).toEqual([]);
  });

  it("inspects references from a separate CLI process with no GitHub credentials required", () => {
    const reviews = store.reviews();
    reviews.record(review);
    const disposition = {
      decision: "accept",
      reasoning: { kind: "review_comment", id: 701 },
      claimedResolvingHeadSha: nextHead,
    } satisfies FindingDisposition;
    reviews.setDisposition(review.id, 201, disposition, null);
    const result = spawnSync(process.execPath, ["src/main.ts", "--review-status", workflowId], {
      encoding: "utf8",
      env: { SWITCHYARD_DB_PATH: path },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      workflowId,
      headSha: head,
      reviews: [
        {
          headSha: head,
          githubReviewId: review.githubReviewId,
          findings: expect.arrayContaining([{ githubCommentId: 201, disposition }]),
        },
      ],
    });
  });
});
