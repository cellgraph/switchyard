import { createHash } from "node:crypto";
import { commitSha, object, positiveInteger } from "./github-data.ts";
import type { PullRequestTarget } from "./github-api.ts";
import {
  decisions,
  findingUrl,
  pullUrl,
  type Disposition,
  type PrAssignment,
} from "./pr-assignments.ts";

export type PublicationReader = {
  readReviews(target: PullRequestTarget, signal?: AbortSignal): Promise<unknown[]>;
  readReviewComments(target: PullRequestTarget, signal?: AbortSignal): Promise<unknown[]>;
  readIssue(target: PullRequestTarget, number: number, signal?: AbortSignal): Promise<unknown>;
  readCommit(target: PullRequestTarget, sha: string, signal?: AbortSignal): Promise<unknown>;
};

type PublicationSnapshot = Awaited<ReturnType<typeof loadPublications>>;

export async function loadPublications(
  github: PublicationReader,
  target: PullRequestTarget,
  signal?: AbortSignal,
) {
  const reviews = await github.readReviews(target, signal);
  const comments = await github.readReviewComments(target, signal);
  return { reviews: reviews.map(object), comments: comments.map(object) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function lines(body: unknown): string[] {
  return typeof body === "string" ? body.split(/\r?\n/).map((line) => line.trim()) : [];
}

function authored(item: Record<string, unknown> | undefined, assignment: PrAssignment) {
  return object(item?.user)?.id === assignment.producerId;
}

function publishedSince(item: unknown, timestamp: string) {
  if (typeof item !== "string") return false;
  // REST timestamps have second precision.
  return Date.parse(item) >= Math.floor(Date.parse(timestamp) / 1000) * 1000;
}

export async function publicationProof(
  github: PublicationReader,
  target: PullRequestTarget,
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  signal?: AbortSignal,
): Promise<{ proof: string; submittedAt?: string } | null> {
  const { claim } = assignment;
  if (!claim) return null;
  if ("reviewId" in claim) {
    const review = snapshot.reviews.find((item) => item?.id === claim.reviewId);
    const body = lines(review?.body);
    if (
      !review ||
      !authored(review, assignment) ||
      commitSha(review.commit_id) !== claim.headSha ||
      !["COMMENTED", claim.outcome === "clean" ? "APPROVED" : "CHANGES_REQUESTED"].includes(
        String(review.state),
      ) ||
      !publishedSince(review.submitted_at, assignment.createdAt) ||
      body[0] !== `Review outcome: ${claim.outcome}`
    )
      return null;
    const resolutionLines = body.filter((line) => line.startsWith("Resolved finding: "));
    const expectedResolutions = claim.resolvedFindingIds.map(
      (id) => `Resolved finding: ${findingUrl(target, id)}`,
    );
    if (
      resolutionLines.length !== expectedResolutions.length ||
      expectedResolutions.some((line) => !resolutionLines.includes(line))
    )
      return null;

    const roots = snapshot.comments.filter(
      (item) => item?.pull_request_review_id === claim.reviewId && item.in_reply_to_id == null,
    );
    if (roots.length !== claim.findingIds.length) return null;
    const bodies: unknown[] = [];
    for (const id of claim.findingIds) {
      const root = roots.find((item) => item?.id === id);
      if (
        !root ||
        !authored(root, assignment) ||
        commitSha(root.original_commit_id) !== claim.headSha ||
        typeof root.body !== "string" ||
        !root.body.trim()
      )
        return null;
      bodies.push([id, root.body, root.path]);
    }
    return {
      proof: digest([review.body, review.state, bodies]),
      submittedAt: String(review.submitted_at),
    };
  }

  if ("dispositions" in claim) {
    const bodies: unknown[] = [];
    for (const disposition of claim.dispositions) {
      const reply = snapshot.comments.find((item) => item?.id === disposition.replyId);
      const body = lines(reply?.body);
      if (
        !reply ||
        !authored(reply, assignment) ||
        reply.in_reply_to_id !== disposition.findingId ||
        !publishedSince(reply.created_at, assignment.createdAt) ||
        body[0] !== `Decision: ${disposition.decision}` ||
        !body.slice(1).some((line) => line && !line.startsWith("https://"))
      )
        return null;
      let issueBody: unknown;
      if (disposition.issueNumber !== null) {
        const issueUrl = `https://github.com/${target.repository}/issues/${disposition.issueNumber}`;
        if (!body.includes(issueUrl)) return null;
        const issue = object(await github.readIssue(target, disposition.issueNumber, signal));
        if (
          !issue ||
          issue.number !== disposition.issueNumber ||
          issue.pull_request ||
          !authored(issue, assignment) ||
          !publishedSince(issue.created_at, assignment.createdAt) ||
          typeof issue.body !== "string" ||
          !issue.body.split(/\s/).includes(findingUrl(target, disposition.findingId))
        )
          return null;
        issueBody = issue.body;
      }
      bodies.push([disposition.replyId, reply.body, issueBody]);
    }
    return { proof: digest(bodies) };
  }

  const result = object(await github.readCommit(target, claim.publishedHeadSha, signal));
  const commit = object(result?.commit);
  const parents: unknown[] = Array.isArray(result?.parents) ? result.parents : [];
  if (
    commitSha(result?.sha) !== claim.publishedHeadSha ||
    parents.length !== 1 ||
    commitSha(object(parents[0])?.sha) !== claim.headSha ||
    object(result?.committer)?.id !== assignment.producerId ||
    object(commit?.verification)?.verified !== true
  )
    return null;
  return { proof: digest([claim.publishedHeadSha, claim.headSha, assignment.producerId]) };
}

export function candidatePublications(
  target: PullRequestTarget,
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
) {
  const { input } = assignment;
  if (input.role === "reviewer") {
    return snapshot.reviews.flatMap((item) =>
      positiveInteger(item?.id) &&
      authored(item, assignment) &&
      commitSha(item.commit_id) === assignment.headSha &&
      publishedSince(item.submitted_at, assignment.createdAt)
        ? [`${pullUrl(target)}#pullrequestreview-${item.id}`]
        : [],
    );
  }
  if (input.role === "adjudicator") {
    return snapshot.comments.flatMap((item) =>
      positiveInteger(item?.id) &&
      positiveInteger(item.in_reply_to_id) &&
      input.findingIds.includes(item.in_reply_to_id) &&
      authored(item, assignment) &&
      publishedSince(item.created_at, assignment.createdAt)
        ? [findingUrl(target, item.id)]
        : [],
    );
  }
  return [];
}

export function conflictingReply(
  snapshot: PublicationSnapshot,
  item: Disposition,
  assignment: PrAssignment,
) {
  return snapshot.comments.some(
    (comment) =>
      positiveInteger(comment?.id) &&
      comment.id > item.replyId &&
      comment.in_reply_to_id === item.findingId &&
      authored(comment, assignment) &&
      decisions.some(
        (decision) =>
          decision !== item.decision && lines(comment.body)[0] === `Decision: ${decision}`,
      ),
  );
}
