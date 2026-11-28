import { createHash } from "node:crypto";
import { commitSha } from "./github-data.ts";
import type { GitHubRepository } from "./github-app.ts";
import type { PlanGitHubReader } from "./github-api.ts";
import type { Approval, ApprovedIncrement } from "./plan-store.ts";

export function parseIncrements(markdown: string): ApprovedIncrement[] {
  const increments: ApprovedIncrement[] = [];
  let section = false;
  let found = false;
  let fence: string | undefined;
  let current: { title: string; lines: string[] } | undefined;
  function finish() {
    if (!current) return;
    const scope = current.lines.join("\n").trim();
    if (!scope) throw new Error("Every implementation increment needs an explicit scope.");
    increments.push({ number: increments.length + 1, title: current.title, scope });
    current = undefined;
  }
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (current) current.lines.push(line);
      if (
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = undefined;
      continue;
    }
    if (/^ {0,3}#{1,2}\s/.test(line)) {
      if (section) finish();
      section = /^## Increments\s*$/.test(line);
      if (section && found) throw new Error("The plan must contain only one Increments section.");
      if (section) found = true;
      continue;
    }
    if (section && /^ {0,3}###\s/.test(line)) {
      finish();
      const heading = /^### ([1-9]\d*)\. (\S.*)$/.exec(line);
      if (!heading || Number(heading[1]) !== increments.length + 1)
        throw new Error("Use consecutive increment headings such as ### 1. Title.");
      current = { title: heading[2]!.trim(), lines: [] };
      continue;
    }
    if (section && !current && line.trim())
      throw new Error("Put implementation scope under a numbered increment heading.");
    if (marker) fence = marker[1];
    if (current) current.lines.push(line);
  }
  finish();
  if (!increments.length || increments.length > 50 || fence)
    throw new Error("The plan needs 1–50 increments in a complete Markdown Increments section.");
  return increments;
}

export async function loadApproval(
  github: Pick<PlanGitHubReader, "readPlanFile" | "readDefaultBranch">,
  target: GitHubRepository,
  path: string,
  suppliedRevision: string,
): Promise<Approval> {
  const revision = commitSha(suppliedRevision);
  if (!revision)
    throw new Error("Plan approval requires a full 40-character repository commit SHA.");
  if (!/^docs\/plans\/[a-z0-9][a-z0-9._-]*\.md$/i.test(path))
    throw new Error("Use a Markdown plan under docs/plans/.");
  const { blobSha, bytes } = await github.readPlanFile(target, path, revision);
  const computed = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (bytes.length > 64 * 1024 || blobSha !== computed)
    throw new Error("The GitHub plan file exceeds 64 KiB or its blob identity does not match.");
  const increments = parseIncrements(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const baseBranch = await github.readDefaultBranch(target);
  return { repository: target.repository, path, revision, blobSha, baseBranch, increments };
}
