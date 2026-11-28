import { createHash } from "node:crypto";
import { commitSha, object, positiveInteger } from "./github-data.ts";
import { GitHubResponseError } from "./github-app.ts";
import type { PullRequestTarget } from "./github-api.ts";
import {
  decisions,
  findingUrl,
  pullUrl,
  type Disposition,
  type PrAssignment,
  type ReviewClaim,
} from "./pr-assignments.ts";

export type PublicationReader = {
  readReviews(target: PullRequestTarget, signal?: AbortSignal): Promise<unknown[]>;
  readReviewComments(target: PullRequestTarget, signal?: AbortSignal): Promise<unknown[]>;
  readIssue(target: PullRequestTarget, number: number, signal?: AbortSignal): Promise<unknown>;
  readCommit(target: PullRequestTarget, sha: string, signal?: AbortSignal): Promise<unknown>;
  readComparison(
    target: PullRequestTarget,
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
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

function normalizeLink(link: string): string {
  return link.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+/i, (repository) =>
    repository.toLowerCase(),
  );
}

function authored(item: Record<string, unknown> | undefined, assignment: PrAssignment) {
  return object(item?.user)?.id === assignment.producerId;
}

function publishedSince(item: unknown, timestamp: string) {
  if (typeof item !== "string") return false;
  // REST timestamps have second precision.
  return Date.parse(item) >= Math.floor(Date.parse(timestamp) / 1000) * 1000;
}

async function deferredIssueProof(
  github: PublicationReader,
  target: PullRequestTarget,
  assignment: PrAssignment,
  disposition: Disposition,
  signal?: AbortSignal,
): Promise<string | null> {
  if (disposition.issueNumber === null) return null;
  let issue;
  try {
    issue = object(await github.readIssue(target, disposition.issueNumber, signal));
  } catch (error) {
    if (error instanceof GitHubResponseError && error.status === 404) return null;
    throw error;
  }
  if (
    !issue ||
    issue.number !== disposition.issueNumber ||
    issue.pull_request ||
    !authored(issue, assignment) ||
    !publishedSince(issue.created_at, assignment.createdAt) ||
    typeof issue.body !== "string" ||
    !issue.body
      .split(/\s/)
      .some((link) => normalizeLink(link) === findingUrl(target, disposition.findingId))
  )
    return null;
  return issue.body;
}

function reviewPublication(
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  claim: ReviewClaim,
) {
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
  return review;
}

function findingProof(
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  claim: ReviewClaim,
  id: number,
) {
  const root = snapshot.comments.find((item) => item?.id === id);
  if (
    !root ||
    root.pull_request_review_id !== claim.reviewId ||
    root.in_reply_to_id != null ||
    !authored(root, assignment) ||
    commitSha(root.original_commit_id) !== claim.headSha ||
    typeof root.body !== "string" ||
    !root.body.trim()
  )
    return null;
  return digest([root.body, root.path]);
}

export function conflictingReviews(
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  claim: ReviewClaim,
  supersededReviewIds: ReadonlySet<number>,
): number[] {
  if (!reviewPublication(snapshot, assignment, claim)) return [];
  return snapshot.reviews.flatMap((review) => {
    if (
      !positiveInteger(review?.id) ||
      review.id === claim.reviewId ||
      supersededReviewIds.has(review.id) ||
      !authored(review, assignment) ||
      commitSha(review.commit_id) !== claim.headSha ||
      !publishedSince(review.submitted_at, assignment.createdAt) ||
      !["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(String(review.state))
    )
      return [];
    const contrary = claim.outcome === "clean" ? "findings" : "clean";
    const contraryState = claim.outcome === "clean" ? "CHANGES_REQUESTED" : "APPROVED";
    const competingClaim = { ...claim, reviewId: review.id };
    const hasOtherFindings = snapshot.comments.some(
      (item) =>
        positiveInteger(item?.id) && findingProof(snapshot, assignment, competingClaim, item.id),
    );
    return review.state === contraryState ||
      lines(review.body)[0] === `Review outcome: ${contrary}` ||
      hasOtherFindings
      ? [review.id]
      : [];
  });
}

function savedProof(assignment: PrAssignment) {
  return assignment.proof?.startsWith("{") ? object(JSON.parse(assignment.proof)) : undefined;
}

export function verifiedOriginalFinding(
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  id: number,
) {
  const { claim } = assignment;
  if (!claim || !("reviewId" in claim) || !claim.findingIds.includes(id)) return false;
  const prior = savedProof(assignment);
  const review = reviewPublication(snapshot, assignment, claim);
  const original = findingProof(snapshot, assignment, claim, id);
  return Boolean(
    review &&
    original &&
    prior?.review === digest([review.body, review.state]) &&
    object(prior?.findings)?.[id] === original,
  );
}

async function dispositionProof(
  github: PublicationReader,
  target: PullRequestTarget,
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  disposition: Disposition,
  signal?: AbortSignal,
): Promise<string | null> {
  const reply = snapshot.comments.find((item) => item?.id === disposition.replyId);
  const body = lines(reply?.body);
  if (
    !reply ||
    !authored(reply, assignment) ||
    reply.in_reply_to_id !== disposition.findingId ||
    !publishedSince(reply.created_at, assignment.createdAt) ||
    body[0] !== `Decision: ${disposition.decision}` ||
    !body.slice(1).some((line) => line && !/^https?:\/\//i.test(line))
  )
    return null;
  let issueBody: unknown;
  if (disposition.issueNumber !== null) {
    const issueUrl = `https://github.com/${target.repository}/issues/${disposition.issueNumber}`;
    if (!body.some((line) => normalizeLink(line) === issueUrl)) return null;
    issueBody = await deferredIssueProof(github, target, assignment, disposition, signal);
    if (issueBody === null) return null;
  }
  return digest([reply.body, issueBody]);
}

export async function verifyDisposition(
  github: PublicationReader,
  target: PullRequestTarget,
  snapshot: PublicationSnapshot,
  assignment: PrAssignment,
  disposition: Disposition,
  signal?: AbortSignal,
): Promise<boolean> {
  const proof = await dispositionProof(github, target, snapshot, assignment, disposition, signal);
  return proof !== null && savedProof(assignment)?.[disposition.findingId] === proof;
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
    const review = reviewPublication(snapshot, assignment, claim);
    if (!review) return null;
    const body = lines(review.body);
    const resolutionPrefix = "Resolved finding: ";
    const resolutionLines = body
      .filter((line) => line.startsWith(resolutionPrefix))
      .map((line) => normalizeLink(line.slice(resolutionPrefix.length)));
    const expectedResolutions = claim.resolvedFindingIds.map((id) => findingUrl(target, id));
    if (
      resolutionLines.length !== expectedResolutions.length ||
      expectedResolutions.some((line) => !resolutionLines.includes(line))
    )
      return null;

    const roots = snapshot.comments.filter(
      (item) => item?.pull_request_review_id === claim.reviewId && item.in_reply_to_id == null,
    );
    if (roots.length !== claim.findingIds.length) return null;
    const findings: Record<number, string> = {};
    for (const id of claim.findingIds) {
      const proof = findingProof(snapshot, assignment, claim, id);
      if (!proof) return null;
      findings[id] = proof;
    }
    return {
      proof: JSON.stringify({ review: digest([review.body, review.state]), findings }),
      submittedAt: String(review.submitted_at),
    };
  }

  if ("dispositions" in claim) {
    const findings: Record<number, string> = {};
    for (const disposition of claim.dispositions) {
      const proof = await dispositionProof(
        github,
        target,
        snapshot,
        assignment,
        disposition,
        signal,
      );
      if (!proof) return null;
      findings[disposition.findingId] = proof;
    }
    return { proof: JSON.stringify(findings) };
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

export async function includesCommit(
  github: PublicationReader,
  target: PullRequestTarget,
  base: string,
  head: string,
  signal?: AbortSignal,
): Promise<boolean | null> {
  if (base === head) return true;
  const comparison = object(await github.readComparison(target, base, head, signal));
  const mergeBase = commitSha(object(comparison?.merge_base_commit)?.sha);
  if (commitSha(object(comparison?.base_commit)?.sha) !== base || !mergeBase) return null;
  if (comparison?.status === "ahead" && mergeBase === base) return true;
  if ((comparison?.status === "diverged" || comparison?.status === "behind") && mergeBase !== base)
    return false;
  return null;
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
