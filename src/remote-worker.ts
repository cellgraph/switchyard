import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentOperationWorker, AgentTurnEvidence } from "./agent-operation.ts";
import {
  remoteLeaseMs,
  remotePollMs,
  RemoteProtocolError,
  type Capabilities,
  type Placement,
  type RemoteTask,
} from "./remote-protocol.ts";
import type { remoteClient } from "./remote-http.ts";
import type { Worktree, WorktreeLocation, WorktreeTarget } from "./worktree.ts";

export type RemoteProfile = Placement & {
  worker: AgentOperationWorker;
  locate(target: WorktreeTarget): WorktreeLocation;
};
type Request = ReturnType<typeof remoteClient>;
type Log = (event: Record<string, unknown>) => void;

export async function runRemoteWorker({
  capabilities,
  profiles,
  request,
  signal,
  log,
  pollMs = remotePollMs,
}: {
  capabilities: Capabilities;
  profiles: RemoteProfile[];
  request: Request;
  signal: AbortSignal;
  log: Log;
  pollMs?: number;
}) {
  const instance = randomUUID();

  function reportError(event: string, error: unknown, operationId?: string) {
    log({
      event,
      operationId,
      ...(error instanceof RemoteProtocolError ? { status: error.status } : {}),
    });
  }

  async function wait(ms: number, signal: AbortSignal) {
    try {
      await delay(ms, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  async function execute(task: RemoteTask, claimedAt: number) {
    const { intent, fence, repository, prompt, previous } = task;
    const { operationId, workflowId, branch, expectedHead, remote } = intent;
    const key = { operationId, instance, fence };
    const canceled = new AbortController();
    const done = new AbortController();
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.floor(remote.timeoutMs - (performance.now() - claimedAt))),
    );
    const runSignal = AbortSignal.any([signal, timeout, canceled.signal]);
    const heartbeatSignal = AbortSignal.any([runSignal, done.signal]);
    let latestReference: AgentTurnEvidence["reference"];
    let renewedAt = claimedAt;
    const watchdog = setInterval(() => {
      if (performance.now() - renewedAt >= remoteLeaseMs) canceled.abort();
    }, 500);
    const heartbeat = (async () => {
      while (!heartbeatSignal.aborted) {
        await wait(5_000, heartbeatSignal);
        if (heartbeatSignal.aborted) break;
        const sentAt = performance.now();
        try {
          await request("renew", { ...key, reference: latestReference });
          renewedAt = sentAt;
        } catch (error) {
          reportError("remote_heartbeat_failed", error, operationId);
          if (error instanceof RemoteProtocolError && error.status < 500) canceled.abort();
        }
      }
    })();
    let report: AgentTurnEvidence;
    let launchRequested = false;
    try {
      runSignal.throwIfAborted();
      const profile = profiles.find(
        (entry) =>
          entry.repository === repository &&
          entry.provider === remote.provider &&
          entry.model === remote.model,
      );
      if (
        !profile ||
        intent.fix ||
        intent.mode !== "awaiting_review" ||
        expectedHead !== intent.expectedPullRequestHead ||
        createHash("sha256").update(prompt).digest("hex") !== intent.promptDigest
      )
        throw new Error("Remote dispatch does not match the bounded worker profile.");
      const target = { workflowId, branch, expectedHead };
      const location = profile.locate(target);
      const runtime = profile.worker.runtime();
      if (
        previous &&
        (previous.status !== "active" || !isDeepStrictEqual(previous.runtime, runtime))
      )
        throw new Error("Continuation requires the original worker runtime.");
      await request("start", { ...key, runtime, location });
      runSignal.throwIfAborted();
      let worktree: Worktree | undefined;
      report = await profile.worker.execute({
        operationId,
        target,
        prompt,
        previous,
        signal: runSignal,
        recordExpectedWorktree(expected) {
          if (!isDeepStrictEqual(expected, location)) throw new Error("Checkout location changed.");
        },
        recordWorkspace(checkout) {
          worktree = checkout;
        },
        recordSession(reference) {
          latestReference = reference;
        },
        async authorizeLaunch() {
          runSignal.throwIfAborted();
          launchRequested = true;
          try {
            await request("launch", { ...key, worktree });
          } catch (error) {
            if (error instanceof RemoteProtocolError && error.status < 500) launchRequested = false;
            throw error;
          }
          runSignal.throwIfAborted();
        },
      });
    } catch (error) {
      reportError("remote_execution_error", error, operationId);
      report = launchRequested
        ? {
            agent: { outcome: "unknown" },
            error: "Remote execution ended without provider terminal evidence.",
          }
        : {
            error:
              "Remote worker could not complete launch preflight. Inspect its profile and checkout.",
          };
    }
    if (latestReference && !report.reference) report.reference = latestReference;
    if (runSignal.aborted && report.agent?.outcome !== "interrupted")
      report = {
        ...report,
        agent: { outcome: "unknown" },
        error: "Remote execution reached a cancellation or timeout boundary.",
      };
    // Keep heartbeating while retrying a possibly lost completion response.
    try {
      for (;;) {
        try {
          const result = await request<{ result: unknown }>("complete", {
            ...key,
            evidence: report,
          });
          log({ event: "remote_completion", operationId, result: result.result });
          return;
        } catch (error) {
          reportError("remote_completion_failed", error, operationId);
          if (signal.aborted || (error instanceof RemoteProtocolError && error.status < 500))
            return;
          await wait(pollMs, signal);
        }
      }
    } finally {
      done.abort();
      clearInterval(watchdog);
      await heartbeat;
    }
  }

  let registered = false;
  while (!signal.aborted) {
    try {
      if (!registered) {
        await request("register", { capabilities });
        registered = true;
        log({ event: "remote_worker_registered" });
      }
      if (signal.aborted) break;
      const claimedAt = performance.now();
      const { task } = await request<{ task: RemoteTask | null }>("claim", { instance });
      if (task) {
        log({ event: "remote_claimed", operationId: task.intent.operationId });
        await execute(task, claimedAt);
      }
    } catch (error) {
      reportError("remote_poll_failed", error);
      registered = false;
    }
    await wait(pollMs, signal);
  }
}
