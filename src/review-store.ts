import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { commitSha, positiveInteger, repositoryName } from "./github-data.ts";
import type { FindingDisposition, ReviewFinding, ReviewMetadata } from "./review.ts";

export const reviewSchema = `
  CREATE TABLE review_runs (
    id TEXT PRIMARY KEY NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES workflows(id),
    head_sha TEXT NOT NULL,
    github_review_id INTEGER,
    outcome TEXT NOT NULL CHECK(outcome IN ('clean', 'findings', 'incomplete')),
    completed_at TEXT,
    UNIQUE(workflow_id, github_review_id),
    CHECK(
      (outcome = 'incomplete' AND completed_at IS NULL) OR
      (outcome != 'incomplete' AND completed_at IS NOT NULL AND github_review_id IS NOT NULL)
    )
  );
  CREATE INDEX review_runs_by_head ON review_runs(workflow_id, head_sha);
  CREATE TABLE review_findings (
    review_id TEXT NOT NULL REFERENCES review_runs(id),
    github_comment_id INTEGER NOT NULL,
    disposition TEXT,
    PRIMARY KEY(review_id, github_comment_id)
  );
`;

type ReviewRow = Omit<ReviewMetadata, "findingCommentIds">;

export function createReviewStore(db: DatabaseSync, transaction: <T>(run: () => T) => T) {
  const readFindings = db.prepare(
    `SELECT github_comment_id AS githubCommentId, disposition
     FROM review_findings WHERE review_id=? ORDER BY github_comment_id`,
  );
  const columns = `id, workflow_id AS workflowId, head_sha AS headSha,
                   github_review_id AS githubReviewId, outcome, completed_at AS completedAt`;
  const findReview = db.prepare(`SELECT ${columns} FROM review_runs WHERE id=?`);

  return {
    record(input: ReviewMetadata): void {
      const { id, workflowId, githubReviewId, outcome } = input;
      const headSha = commitSha(input.headSha);
      if (!headSha || typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id))
        throw new Error("A review requires an identifier and full GitHub head SHA.");
      if (!Array.isArray(input.findingCommentIds))
        throw new Error("A review requires an explicit finding reference list.");
      const findingCommentIds = [...input.findingCommentIds].sort((a, b) => a - b);
      if (
        !findingCommentIds.every(positiveInteger) ||
        new Set(findingCommentIds).size !== findingCommentIds.length
      )
        throw new Error("Finding references must be distinct GitHub review comment IDs.");
      if (githubReviewId !== null && !positiveInteger(githubReviewId))
        throw new Error("Invalid GitHub review ID.");
      if (outcome !== "clean" && outcome !== "findings" && outcome !== "incomplete")
        throw new Error("Invalid review outcome.");
      if ((outcome === "findings") !== findingCommentIds.length > 0)
        throw new Error("Review outcome and finding references disagree.");
      const completedAt = input.completedAt === null ? null : new Date(input.completedAt);
      if (
        outcome === "incomplete"
          ? completedAt !== null
          : githubReviewId === null ||
            completedAt === null ||
            !Number.isFinite(completedAt.getTime())
      )
        throw new Error(
          "Completed review metadata requires a GitHub review ID and a completion timestamp.",
        );
      const row = {
        id,
        workflowId,
        headSha,
        githubReviewId,
        outcome,
        completedAt: completedAt?.toISOString() ?? null,
      };
      transaction(() => {
        const saved = findReview.get(id);
        if (saved) {
          if (
            !isDeepStrictEqual({ ...saved }, row) ||
            !isDeepStrictEqual(
              readFindings.all(id).map((finding) => finding.githubCommentId),
              findingCommentIds,
            )
          )
            throw new Error(`Review ${id} already exists with different metadata.`);
          return;
        }
        db.prepare(
          `INSERT INTO review_runs (id, workflow_id, head_sha, github_review_id, outcome, completed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, workflowId, headSha, githubReviewId, outcome, row.completedAt);
        const insert = db.prepare(
          "INSERT INTO review_findings (review_id, github_comment_id) VALUES (?, ?)",
        );
        const owner = db.prepare(
          `SELECT review_runs.id FROM review_findings
           JOIN review_runs ON review_runs.id=review_findings.review_id
           WHERE workflow_id=? AND github_comment_id=? LIMIT 1`,
        );
        for (const commentId of findingCommentIds) {
          const existing = owner.get(workflowId, commentId);
          if (existing)
            throw new Error(
              `Finding ${commentId} already belongs to review ${String(existing.id)} in workflow ${workflowId}.`,
            );
          insert.run(id, commentId);
        }
      });
    },

    setDisposition(
      reviewId: string,
      githubCommentId: number,
      input: FindingDisposition,
      expectedPrior: FindingDisposition | null,
    ): void {
      const next = JSON.stringify(normalizeDisposition(input));
      const expected =
        expectedPrior === null ? null : JSON.stringify(normalizeDisposition(expectedPrior));
      transaction(() => {
        const finding = db
          .prepare(
            "SELECT disposition FROM review_findings WHERE review_id=? AND github_comment_id=?",
          )
          .get(reviewId, githubCommentId);
        if (!finding)
          throw new Error(`Finding ${githubCommentId} does not exist in review ${reviewId}.`);
        if (finding.disposition === next) return;
        if (finding.disposition !== expected)
          throw new Error(
            `Disposition for finding ${githubCommentId} differs from the expected prior value.`,
          );
        db.prepare(
          "UPDATE review_findings SET disposition=? WHERE review_id=? AND github_comment_id=?",
        ).run(next, reviewId, githubCommentId);
      });
    },

    list(workflowId: string, headSha?: string): Array<ReviewRow & { findings: ReviewFinding[] }> {
      const rows = (
        headSha === undefined
          ? db
              .prepare(`SELECT ${columns} FROM review_runs WHERE workflow_id=? ORDER BY rowid`)
              .all(workflowId)
          : db
              .prepare(
                `SELECT ${columns} FROM review_runs WHERE workflow_id=? AND head_sha=? ORDER BY rowid`,
              )
              .all(workflowId, headSha)
      ) as ReviewRow[];
      return rows.map((review) => ({
        ...review,
        findings: readFindings.all(review.id).map((finding) => ({
          githubCommentId: Number(finding.githubCommentId),
          disposition:
            finding.disposition === null
              ? null
              : (JSON.parse(String(finding.disposition)) as FindingDisposition),
        })),
      }));
    },
  };
}

function normalizeDisposition(input: FindingDisposition): FindingDisposition {
  const { decision } = input;
  const { kind, id } = input.reasoning;
  if ((kind !== "review_comment" && kind !== "issue_comment") || !positiveInteger(id))
    throw new Error("Invalid disposition reasoning reference.");
  const reasoning = { kind, id };
  switch (decision) {
    case "accept": {
      const claimedResolvingHeadSha = commitSha(input.claimedResolvingHeadSha);
      if (input.claimedResolvingHeadSha !== undefined && !claimedResolvingHeadSha)
        throw new Error("A claimed resolving head requires a full GitHub SHA.");
      return {
        decision,
        reasoning,
        ...(claimedResolvingHeadSha ? { claimedResolvingHeadSha } : {}),
      };
    }
    case "defer": {
      const repository = repositoryName(input.issue.repository);
      const number = input.issue.number;
      if (!repository || !positiveInteger(number))
        throw new Error("Deferral requires a GitHub issue reference.");
      return { decision, reasoning, issue: { repository, number } };
    }
    case "reject":
    case "escalate":
      return { decision, reasoning };
    default:
      throw new Error("Invalid finding disposition.");
  }
}
