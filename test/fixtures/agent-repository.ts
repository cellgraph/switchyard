import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "../../src/workflow.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function agentRepository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "switchyard-agent-")));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  mkdirSync(repo);
  mkdirSync(worktrees);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  const head = git(repo, "rev-parse", "HEAD");
  const workflow: Workflow = {
    id: "owner/repo#1",
    identity: { repository: "owner/repo", pullRequest: 1 },
    state: "awaiting_review",
    headSha: head,
    requiredChecks: null,
    review: null,
    checks: [],
    fixCycles: 0,
    cycleAwaitingReview: false,
    validationHeadSha: null,
    escalationReason: null,
  };
  const request = {
    operationId: "first-turn",
    workflowId: workflow.id,
    branch: "feat/workflow-1",
    expectedPullRequestHead: head,
    expectedHead: head,
    prompt: "Edit the workflow checkout.",
  };
  return { root, repo, worktrees, workflow, request, db: join(root, "switchyard.sqlite") };
}
