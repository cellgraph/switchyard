import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PullRequestState, PullRequestTarget } from "./github-api.ts";
import { GitHubWriteRejected } from "./github-app.ts";
import { object, positiveInteger } from "./github-data.ts";
import { identifier, type FindingInput } from "./review.ts";

type Anchor = {
  workflowId: string;
  repository: string;
  pullRequest: number;
  headSha: string;
  reviewedSha: string;
  content: string;
  rootCommentId: number | null;
  rootNodeId: string | null;
};

type Publication = {
  id: string;
  body: string;
  bot_login: string;
  state: "pending" | "writing" | "rejected" | "published" | "blocked";
  comment_id: number | null;
  node_id: string | null;
  observation: string | null;
  error: string | null;
  attempts: number;
};

type Thread = { id: string; resolved: boolean; outdated: boolean };

type RemoteComment = {
  id: number;
  nodeId: string;
  body: string;
  login: unknown;
  parent: unknown;
  path: unknown;
  originalSha: unknown;
  line: unknown;
  originalLine: unknown;
  originalStart: unknown;
  side: unknown;
  startSide: unknown;
};

function remoteComment(value: unknown): RemoteComment | null {
  const row = object(value);
  if (
    !positiveInteger(row?.id) ||
    typeof row.node_id !== "string" ||
    !row.node_id ||
    typeof row.body !== "string"
  )
    return null;
  return {
    id: row.id,
    nodeId: row.node_id,
    body: row.body,
    login: object(row.user)?.login,
    parent: row.in_reply_to_id ?? null,
    path: row.path,
    originalSha: row.original_commit_id,
    line: row.line,
    originalLine: row.original_line,
    originalStart: row.original_start_line,
    side: row.side,
    startSide: row.start_side,
  };
}

export function createReviewPublications(db: DatabaseSync, transaction: <T>(run: () => T) => T) {
  function anchor(findingId: string): Anchor {
    const row = db
      .prepare(
        `SELECT w.id AS workflowId,w.repository,w.pull_request AS pullRequest,
      w.head_sha AS headSha,r.head_sha AS reviewedSha,f.content,
      f.root_comment_id AS rootCommentId,f.root_node_id AS rootNodeId
      FROM review_findings f JOIN review_runs r ON f.run_id=r.id
      JOIN workflows w ON r.workflow_id=w.id WHERE f.id=?`,
      )
      .get(findingId) as Anchor | undefined;
    if (!row) throw new Error("Review finding does not exist.");
    return row;
  }

  function get(id: string) {
    return db.prepare("SELECT * FROM review_publications WHERE id=?").get(id) as
      Publication | undefined;
  }

  return {
    anchor,
    prepare(findingId: string, actionId: string | null, botLogin: string, publish: boolean) {
      return transaction(() => {
        const id = createHash("sha256")
          .update(JSON.stringify([findingId, actionId]))
          .digest("hex");
        const existing = get(id);
        if (existing && existing.bot_login !== botLogin)
          throw new Error("Publication intent belongs to a different GitHub App bot.");
        if (existing) return existing;

        const finding = anchor(findingId);
        const content = JSON.parse(finding.content) as FindingInput;
        let message = [
          `[${content.severity}] ${content.title}`,
          content.explanation,
          content.evidence,
          content.recommendation,
        ]
          .filter((part) => part !== null)
          .join("\n\n");
        if (actionId !== null) {
          const action = db
            .prepare(
              `SELECT action,rationale,actor FROM finding_actions
            WHERE id=? AND finding_id=? AND action IN ('accepted','deferred','rejected')`,
            )
            .get(actionId, findingId) as
            { action: string; rationale: string; actor: string } | undefined;
          if (!action) throw new Error("Disposition does not belong to this finding.");
          message = `Disposition: ${action.action}\nRecorded by: ${action.actor}\n\n${action.rationale}`;
        } else if (finding.rootCommentId !== null) {
          return undefined;
        }
        if (!publish) return undefined;
        // Indented code renders untrusted model text literally, including mentions and HTML.
        const body = `${message
          .split(/\r\n|\r|\n/)
          .map((line) => `    ${line}`)
          .join("\n")}\n\n<!-- switchyard-review:v1:${id} -->`;
        const error =
          actionId === null && !content.path
            ? "GitHub review comments require a file or diff-line anchor."
            : null;
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO review_publications
          (id,finding_id,action_id,bot_login,body,state,error,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          findingId,
          actionId,
          botLogin,
          body,
          error ? "blocked" : "pending",
          error,
          now,
          now,
        );
        return get(id)!;
      });
    },
    get,
    observeRoot(findingId: string, rootId: number, observation: string) {
      db.prepare(
        `UPDATE review_findings SET root_observation=?,root_observed_at=?
        WHERE id=? AND root_comment_id=?`,
      ).run(observation, new Date().toISOString(), findingId, rootId);
    },
    observeThread(findingId: string, rootId: number, thread: Thread | null, error?: string) {
      const conflict = transaction(() => {
        const row = db
          .prepare("SELECT github_thread_id FROM review_findings WHERE id=? AND root_comment_id=?")
          .get(findingId, rootId);
        if (!row)
          throw new Error("Finding root changed before the GitHub thread could be recorded.");
        const conflict = Boolean(
          row.github_thread_id && thread && row.github_thread_id !== thread.id,
        );
        const observedAt = new Date().toISOString();
        const observation = conflict
          ? { state: "conflict", observedAt }
          : thread
            ? {
                state: "observed",
                resolved: thread.resolved,
                outdated: thread.outdated,
                observedAt,
              }
            : error
              ? { state: "unavailable", error, observedAt }
              : { state: "missing", observedAt };
        db.prepare(
          `UPDATE review_findings SET github_thread_id=COALESCE(github_thread_id, ?),
          thread_observation=? WHERE id=?`,
        ).run(conflict ? null : (thread?.id ?? null), JSON.stringify(observation), findingId);
        return conflict;
      });
      if (conflict) throw new Error("GitHub thread conflicts with the stored finding association.");
    },
    claim(
      findingId: string,
      publication: Publication,
      expectedHead: string,
      actionId: string | null,
    ) {
      return transaction(() => {
        const current = anchor(findingId);
        if (
          actionId === null &&
          (current.headSha !== expectedHead || current.reviewedSha !== expectedHead)
        )
          throw new Error("Finding publication requires the current reviewed PR head.");
        return (
          db
            .prepare(
              `UPDATE review_publications SET state='writing',attempts=attempts+1,
          updated_at=?,error=NULL,observation=NULL WHERE id=? AND attempts=? AND state IN ('pending','rejected')`,
            )
            .run(new Date().toISOString(), publication.id, publication.attempts).changes === 1
        );
      });
    },
    recordComment(
      publication: Publication,
      findingId: string,
      actionId: string | null,
      comment: RemoteComment,
    ) {
      transaction(() => {
        const current = get(publication.id)!;
        if (current.comment_id !== null && current.comment_id !== comment.id)
          throw new Error("Publication already links to a different GitHub comment.");
        if (current.state !== "published" && current.state !== "writing")
          throw new Error("GitHub comment cannot be linked without a dispatched intent.");
        const now = new Date().toISOString();
        db.prepare(
          `UPDATE review_publications SET state='published',comment_id=?,node_id=?,
          observation='present',error=NULL,updated_at=? WHERE id=?`,
        ).run(comment.id, comment.nodeId, now, publication.id);
        if (actionId === null) {
          const result = db
            .prepare(
              `UPDATE review_findings SET root_comment_id=?,root_node_id=?,
            root_observation=?,root_observed_at=? WHERE id=? AND
            (root_comment_id IS NULL OR root_comment_id=?)`,
            )
            .run(
              comment.id,
              comment.nodeId,
              threadObservation(comment),
              now,
              findingId,
              comment.id,
            );
          if (!result.changes) throw new Error("Finding already has a different GitHub thread.");
        }
      });
    },
    observe(publication: Publication, observation: string) {
      db.prepare(
        `UPDATE review_publications SET observation=?,updated_at=?
        WHERE id=? AND attempts=? AND state=?`,
      ).run(
        observation,
        new Date().toISOString(),
        publication.id,
        publication.attempts,
        publication.state,
      );
    },
    fail(publication: Publication, error: unknown) {
      const rejected = error instanceof GitHubWriteRejected;
      db.prepare(
        `UPDATE review_publications SET state=?,error=?,updated_at=?
        WHERE id=? AND attempts=? AND state='writing'`,
      ).run(
        rejected ? "rejected" : "writing",
        error instanceof Error ? error.message : "Unknown publication error.",
        new Date().toISOString(),
        publication.id,
        publication.attempts + 1,
      );
    },
  };
}

function threadObservation(comment: RemoteComment): string {
  return comment.line === null && positiveInteger(comment.originalLine) ? "outdated" : "present";
}

type ReviewGitHub = {
  completeReconciliation(target: PullRequestTarget): void;
  readAppBot(target: PullRequestTarget): Promise<string>;
  readReviewThread(target: PullRequestTarget, rootId: number): Promise<Thread | null>;
  readPullRequest(target: PullRequestTarget): Promise<PullRequestState>;
  readReviewComments(target: PullRequestTarget): Promise<unknown[]>;
  postReviewComment(
    target: PullRequestTarget,
    parentId: number | null,
    body: Record<string, unknown>,
  ): Promise<unknown>;
};

export async function syncReviewPublication(
  publications: ReturnType<typeof createReviewPublications>,
  github: ReviewGitHub,
  targets: PullRequestTarget[],
  input: { findingId: unknown; actionId?: unknown; mode: unknown },
) {
  const findingId = identifier(input.findingId, "finding ID");
  const actionId = input.actionId == null ? null : identifier(input.actionId, "disposition ID");
  if (input.mode !== "publish" && input.mode !== "reconcile")
    throw new Error("Review synchronization mode must be publish or reconcile.");
  const finding = publications.anchor(findingId);
  const target = targets.find(
    (entry) =>
      entry.repository === finding.repository.toLowerCase() &&
      entry.pullRequest === finding.pullRequest,
  );
  if (!target) throw new Error("Review PR is missing from the configured GitHub App targets.");
  function complete<T>(result: T): T {
    github.completeReconciliation(target!);
    return result;
  }
  const publish = input.mode === "publish";
  const botLogin = await github.readAppBot(target);
  const publication = publications.prepare(findingId, actionId, botLogin, publish);
  if (publication?.state === "blocked") return publication;
  const comments = (await github.readReviewComments(target)).map(remoteComment);
  if (comments.some((comment) => comment === null))
    throw new Error("GitHub review comment response was incomplete.");
  const visible = comments.filter((comment) => comment !== null);
  const root =
    finding.rootCommentId === null
      ? undefined
      : visible.find(
          (comment) =>
            comment.id === finding.rootCommentId &&
            comment.parent === null &&
            (!finding.rootNodeId || comment.nodeId === finding.rootNodeId),
        );
  if (finding.rootCommentId !== null)
    publications.observeRoot(
      findingId,
      finding.rootCommentId,
      root ? threadObservation(root) : "missing",
    );
  async function reconcileThread(comment: RemoteComment | undefined) {
    const rootId = comment?.id ?? finding.rootCommentId;
    if (publish || rootId === null) return;
    if (!comment) {
      publications.observeThread(findingId, rootId, null);
      return;
    }
    let thread;
    try {
      thread = await github.readReviewThread(target!, rootId);
    } catch (error) {
      publications.observeThread(
        findingId,
        rootId,
        null,
        error instanceof Error ? error.message : "Thread query failed.",
      );
      throw error;
    }
    publications.observeThread(findingId, rootId, thread);
  }

  if (!publication) {
    await reconcileThread(root);
    return complete({
      rootCommentId: finding.rootCommentId,
      observation: root
        ? threadObservation(root)
        : finding.rootCommentId === null
          ? "unpublished"
          : "missing",
    });
  }

  const content = JSON.parse(finding.content) as FindingInput;
  function matches(comment: RemoteComment) {
    return (
      typeof comment.login === "string" &&
      comment.login.toLowerCase() === botLogin &&
      comment.body.replace(/\r\n/g, "\n").trimEnd() === publication!.body &&
      (actionId !== null
        ? Boolean(root && comment.parent === root.id)
        : comment.parent === null &&
          comment.path === content.path &&
          comment.originalSha === finding.reviewedSha &&
          (content.endLine === null
            ? comment.originalLine == null
            : comment.originalLine === content.endLine &&
              comment.side === content.side &&
              (content.startLine === content.endLine ||
                (comment.originalStart === content.startLine &&
                  comment.startSide === content.side))))
    );
  }
  const found = visible.filter(matches);
  if (
    found.length > 1 ||
    (found[0] && publication.comment_id !== null && publication.comment_id !== found[0].id)
  ) {
    publications.observe(publication, "conflict");
    throw new Error("GitHub has conflicting matches for this review publication.");
  }
  if (found[0]) {
    publications.recordComment(publication, findingId, actionId, found[0]);
    await reconcileThread(actionId === null ? found[0] : root);
    return complete(publications.get(publication.id)!);
  }

  const observed =
    publication.comment_id !== null && visible.some(({ id }) => id === publication.comment_id)
      ? "changed"
      : "missing";
  publications.observe(publication, observed);
  if (!publish || publication.state === "published" || publication.state === "writing") {
    await reconcileThread(root);
    return complete(publications.get(publication.id)!);
  }
  if (actionId !== null && !root)
    throw new Error(
      "A disposition reply requires its finding's original top-level review comment.",
    );
  const latest = await github.readPullRequest(target);
  if (latest.state !== "open") throw new Error("Review publication requires an open pull request.");
  if (!publications.claim(findingId, publication, latest.headSha, actionId))
    return complete(publications.get(publication.id)!);

  const { path, startLine, endLine, side } = content;
  const body =
    actionId !== null
      ? { body: publication.body }
      : {
          body: publication.body,
          commit_id: finding.reviewedSha,
          path,
          ...(endLine === null ? { subject_type: "file" } : { line: endLine, side }),
          ...(startLine !== endLine ? { start_line: startLine, start_side: side } : {}),
        };
  try {
    const result = remoteComment(
      await github.postReviewComment(target, actionId === null ? null : root!.id, body),
    );
    if (!result || !matches(result))
      throw new Error("GitHub response did not establish the publication identity.");
    publications.recordComment(publication, findingId, actionId, result);
  } catch (error) {
    publications.fail(publication, error);
    throw error;
  }
  return complete(publications.get(publication.id)!);
}
