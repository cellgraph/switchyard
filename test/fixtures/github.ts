import type { PullRequestState } from "../../src/github-api.ts";

export const headA = "a".repeat(40);
export const headB = "b".repeat(40);

export function openPull(
  repository: string,
  changes: Partial<PullRequestState> = {},
): PullRequestState {
  return {
    state: "open",
    headSha: headA,
    draft: false,
    merged: false,
    headRepository: repository,
    ...changes,
  };
}
