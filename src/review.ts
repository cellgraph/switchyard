export type ReviewOutcome = "clean" | "findings" | "incomplete";

// Native IDs are interpreted in the repository and PR of the owning workflow.
export type ReviewMetadata = {
  id: string;
  workflowId: string;
  headSha: string;
  githubReviewId: number | null;
  outcome: ReviewOutcome;
  completedAt: string | null;
  findingCommentIds: readonly number[];
};

export type DispositionReference = {
  kind: "review_comment" | "issue_comment";
  id: number;
};

type IssueReference = { repository: string; number: number };

export type FindingDisposition = { reasoning: DispositionReference } & (
  | { decision: "accept"; resolvedHeadSha?: string }
  | { decision: "reject" | "escalate" }
  | { decision: "defer"; issue: IssueReference }
);

export type ReviewFinding = {
  githubCommentId: number;
  disposition: FindingDisposition | null;
};
