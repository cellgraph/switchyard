import { commitSha, object, positiveInteger } from "./github-data.ts";

export const priorities = ["P0", "P1", "P2", "P3"] as const;
export const decisions = ["accepted", "deferred", "rejected"] as const;
export const resolutions = ["fixed", "reopened", "superseded"] as const;

export type FindingInput = {
  title: string;
  explanation: string;
  severity: (typeof priorities)[number];
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  side: "LEFT" | "RIGHT";
  evidence: string | null;
  recommendation: string | null;
  confidence: number | null;
};

export type ReviewResult =
  | { status: "completed"; evidence: string; findings: FindingInput[] }
  | { status: "failed" | "interrupted" | "unknown"; error: string };

export function record(value: unknown): Record<string, unknown> {
  const result = object(value);
  if (!result) throw new Error("Expected a JSON object.");
  return result;
}

export function boundedText(value: unknown, name: string, max = 2000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((char) => (char < " " && !"\t\r\n".includes(char)) || char === "\x7f")
  )
    throw new Error(`${name} must be nonempty text of at most ${max} characters.`);
  return value.trim();
}

export function identifier(value: unknown, name: string): string {
  const id = boundedText(value, name, 160);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) throw new Error(`Invalid ${name}.`);
  return id;
}

export function reviewHead(value: unknown): string {
  const sha = commitSha(value);
  if (!sha) throw new Error("A review requires a full GitHub commit SHA.");
  return sha;
}

export function parseFinding(value: unknown): FindingInput {
  const row = record(value);
  const severity = priorities.find((priority) => priority === row.severity);
  if (!severity) throw new Error("Finding severity must be P0, P1, P2, or P3.");
  const path = row.path == null ? null : boundedText(row.path, "path", 1024);
  if (
    path !== null &&
    (path !== row.path ||
      /[\\\t\r\n]/.test(path) ||
      /^[a-z]:/i.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new Error("Finding path must be repository-relative.");
  const endLine = row.endLine ?? null;
  const startLine = row.startLine ?? endLine;
  if (
    (endLine !== null || startLine !== null) &&
    (!path ||
      !positiveInteger(startLine) ||
      !positiveInteger(endLine) ||
      startLine > endLine ||
      endLine > 2_147_483_647)
  )
    throw new Error("Finding range must have positive, ordered lines and a path.");
  const side = row.side ?? "RIGHT";
  if (side !== "RIGHT" && side !== "LEFT") throw new Error("Invalid finding diff side.");
  const confidence = row.confidence ?? null;
  if (
    confidence !== null &&
    (typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1)
  )
    throw new Error("Finding confidence must be between zero and one.");
  return {
    title: boundedText(row.title, "title", 240),
    explanation: boundedText(row.explanation, "explanation", 8000),
    severity,
    path,
    startLine: startLine as number | null,
    endLine: endLine as number | null,
    side,
    evidence: row.evidence == null ? null : boundedText(row.evidence, "evidence", 4000),
    recommendation:
      row.recommendation == null ? null : boundedText(row.recommendation, "recommendation", 4000),
    confidence,
  };
}

export function parseReviewResult(value: unknown): ReviewResult {
  const row = record(value);
  if (row.status === "completed") {
    if (Object.hasOwn(row, "error"))
      throw new Error("A completed review cannot attach an execution error.");
    if (!Array.isArray(row.findings) || row.findings.length > 100)
      throw new Error("Completed review requires an explicit findings array (maximum 100).");
    const findings = Array.from(row.findings, parseFinding);
    if (new Set(findings.map((finding) => JSON.stringify(finding))).size !== findings.length)
      throw new Error("Review contains duplicate findings.");
    return {
      status: row.status,
      evidence: boundedText(row.evidence, "completion evidence"),
      findings,
    };
  }
  if (row.status === "failed" || row.status === "interrupted" || row.status === "unknown") {
    if (Object.hasOwn(row, "findings") || Object.hasOwn(row, "evidence"))
      throw new Error("An incomplete result cannot attach findings or completion evidence.");
    return { status: row.status, error: boundedText(row.error, "review error") };
  }
  throw new Error("Invalid review outcome.");
}
