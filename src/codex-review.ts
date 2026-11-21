import { commitSha, object, positiveInteger } from "./github-data.ts";
import type { GitHubReader } from "./github-api.ts";
import { parseFinding } from "./review.ts";
import type { CodexObservation, CodexParseFailure, ImportedFinding } from "./review-store.ts";

const bot = "chatgpt-codex-connector[bot]";
const marker = "<!-- codex-code-review-finding:v1 -->";

function codex(value: unknown) {
  const row = object(value);
  return row && object(row.user)?.login === bot && typeof row.body === "string"
    ? { row, body: row.body }
    : null;
}

export function observeCodexReview(
  sha: string,
  inputs: Awaited<ReturnType<GitHubReader["readReviewInputs"]>>,
): CodexObservation | CodexParseFailure | null {
  const summaries = new Map<
    number,
    { any: boolean; unresolved: boolean; updatedAt: string | null }
  >();
  const receipts = new Set<number>();
  const findings = new Map<number, ImportedFinding>();
  function indeterminate(error: string, source?: string, id?: unknown): CodexParseFailure {
    return {
      error,
      evidence: JSON.stringify({
        adapter: "codex-review-v1",
        summaries: [...summaries.keys()],
        receipts: [...receipts],
        findings: [...findings.keys()],
        source: source ?? null,
        sourceId: positiveInteger(id) ? id : null,
      }),
    };
  }
  for (const value of inputs.issueComments) {
    const comment = codex(value);
    if (!comment?.body.includes("<!-- codex-review-state:")) continue;
    const markers = [...comment.body.matchAll(/<!-- codex-review-state:([^]*?)-->/g)];
    if (
      markers.length !== 1 ||
      !markers[0]![1]!.startsWith("v1 ") ||
      !positiveInteger(comment.row.id)
    )
      return indeterminate(
        "Unsupported or duplicate Codex summary marker.",
        "issue_comment",
        comment.row.id,
      );
    let code;
    try {
      const payload = markers[0]![1]!.slice(3);
      if (payload.length > 8192)
        return indeterminate(
          "Codex summary marker exceeded the size limit.",
          "issue_comment",
          comment.row.id,
        );
      code = object(object(JSON.parse(payload))?.code_review);
    } catch {
      return indeterminate("Malformed Codex summary JSON.", "issue_comment", comment.row.id);
    }
    const reviewed = commitSha(code?.commit_sha);
    if (!reviewed)
      return indeterminate("Codex summary lacks a reviewed SHA.", "issue_comment", comment.row.id);
    if (reviewed !== sha) continue;
    const any = code?.has_any_findings;
    const unresolved = code?.has_unresolved_findings;
    if (
      code?.status !== "completed" ||
      typeof any !== "boolean" ||
      typeof unresolved !== "boolean" ||
      (!any && unresolved)
    )
      return indeterminate(
        "Codex summary lacks consistent completion flags.",
        "issue_comment",
        comment.row.id,
      );
    const earlier = summaries.get(comment.row.id);
    if (earlier && (earlier.any !== any || earlier.unresolved !== unresolved))
      return indeterminate(
        "Conflicting copies of a Codex summary.",
        "issue_comment",
        comment.row.id,
      );
    if (summaries.size >= 100 && !earlier) return indeterminate("Too many Codex summaries.");
    summaries.set(comment.row.id, {
      any,
      unresolved,
      updatedAt:
        typeof comment.row.updated_at === "string" ? comment.row.updated_at.slice(0, 30) : null,
    });
  }

  for (const value of inputs.reviews) {
    const review = codex(value);
    if (
      !review ||
      commitSha(review.row.commit_id) !== sha ||
      !review.body.includes("<!-- codex-review-receipt:")
    )
      continue;
    const prefix = /\*\*Reviewed commit:\*\* `([a-f0-9]{7,40})`/i
      .exec(review.body)?.[1]
      ?.toLowerCase();
    if (
      review.row.state !== "COMMENTED" ||
      !positiveInteger(review.row.id) ||
      !prefix ||
      !sha.startsWith(prefix) ||
      !/^<!-- codex-review-receipt:v1 -->/.test(review.body)
    )
      return indeterminate(
        "Unsupported or inconsistent Codex review receipt.",
        "review",
        review.row.id,
      );
    if (receipts.size >= 100 && !receipts.has(review.row.id))
      return indeterminate("Too many Codex receipts.");
    receipts.add(review.row.id);
  }

  for (const value of inputs.reviewComments) {
    const comment = codex(value);
    if (
      !comment ||
      comment.row.in_reply_to_id != null ||
      !comment.body.includes("<!-- codex-code-review-finding:")
    )
      continue;
    const { row, body } = comment;
    const originalSha = commitSha(row.original_commit_id);
    if (originalSha !== sha) {
      if (
        (!originalSha && commitSha(row.commit_id) === sha) ||
        (positiveInteger(row.pull_request_review_id) && receipts.has(row.pull_request_review_id))
      )
        return indeterminate(
          "Codex finding lacks a consistent original SHA.",
          "review_comment",
          row.id,
        );
      continue;
    }
    if (
      !body.trimEnd().endsWith(marker) ||
      body.length > 16_000 ||
      !positiveInteger(row.id) ||
      !positiveInteger(row.original_line) ||
      !positiveInteger(row.pull_request_review_id) ||
      !receipts.has(row.pull_request_review_id)
    )
      return indeterminate(
        "Codex finding lacks a valid marker, anchor, or source receipt.",
        "review_comment",
        row.id,
      );
    const [heading, ...paragraphs] = body.trimEnd().slice(0, -marker.length).trim().split(/\r?\n/);
    const title = /^\*\*<sub><sub>!\[(P[0-3]) Badge\]\([^)]+\)<\/sub><\/sub>\s+(.+)\*\*$/.exec(
      heading ?? "",
    );
    if (!title)
      return indeterminate("Unrecognized Codex finding heading.", "review_comment", row.id);
    try {
      const finding = {
        commentId: row.id,
        nodeId: typeof row.node_id === "string" ? row.node_id : null,
        content: parseFinding({
          title: title[2],
          severity: title[1],
          explanation: paragraphs.join("\n").replace(/\nUseful\? React with[^\n]*\s*$/, ""),
          path: row.path,
          startLine: row.original_start_line,
          endLine: row.original_line,
          side: row.side,
        }),
      };
      const previous = findings.get(row.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(finding))
        return indeterminate("Conflicting copies of a Codex finding.", "review_comment", row.id);
      findings.set(row.id, finding);
    } catch {
      return indeterminate("Invalid Codex finding content.", "review_comment", row.id);
    }
    if (findings.size > 100)
      return indeterminate("Codex review exceeded the finding limit.", "review_comment", row.id);
  }

  const flags = [...summaries.values()];
  const summary = flags[0];
  if (
    flags.some(({ any, unresolved }) => any !== summary?.any || unresolved !== summary?.unresolved)
  )
    return indeterminate("Codex summaries disagree.");
  if (!summary && !findings.size)
    return receipts.size ? indeterminate("Receipt alone cannot prove a clean review.") : null;
  if (summary && summary.any !== findings.size > 0)
    return indeterminate("Codex summary and source findings disagree.");
  return {
    evidence: JSON.stringify({
      adapter: "codex-review-v1",
      summaries: [...summaries.entries()],
      receipts: [...receipts].sort((a, b) => a - b),
    }),
    findings: [...findings.values()].sort((a, b) => a.commentId - b.commentId),
  };
}
