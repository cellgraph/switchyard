# Distributed agent turns

**Implementation status.** This guide describes the existing implementation. [ADR-0006](adr/0006-orchestrate-through-native-tools.md) records the accepted architecture, and [Plan 003](plans/003-architectural-simplification.md) describes the pending replacement.

The controller host can run an execution listener alongside its normal GitHub poller. Both processes use the same local SQLite database. Workers connect outbound, poll for eligible turns, and execute in isolated worktrees using their own clones and provider profiles. See [ADR-0004](adr/0004-remote-agent-turns.md) for lease, delivery and transport decisions.

Phase 5.6B supports explicitly authorized, read-only turns on PRs awaiting review. Codex uses its read-only sandbox with approval and agent network access disabled. Claude Code uses the existing restricted profile with only read tools. The worker checks the checkout and transcript locally and the controller checks the bound checkout identity, exact commit, runtime, workflow revision, and empty changed paths before confirming success. Provider transcripts remain on the worker.

Run workers on trusted hosts that you control. An unchanged checkout is evidence about observed workspace contents. Provider-side or external actions can survive rejection or cancellation. This is the existing remote transport while its checkout verification and agent-turn records are available. See [Plan 003](plans/003-architectural-simplification.md#phase-c--investigate-rex-then-implement-explicit-remote-placement) for the remote placement decision.

## Controller setup

Run these commands on the controller host as the account that owns the Switchyard database. Generate a fresh 32-byte random token for each worker, such as with `openssl rand -hex 32`. Save the token in the worker's secret store. Compute the SHA-256 digest of the exact hex string without a trailing newline, and place only that digest in the controller configuration. Keep the bearer token out of config files, command arguments, prompts and logs.

```json
{
  "port": 8788,
  "workers": {
    "mac-mini": "64_LOWERCASE_HEX_CHARACTERS_FOR_SHA256_OF_WORKER_TOKEN"
  }
}
```

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard.sqlite
npm start -- --remote-controller remote-controller.json
```

The listener binds to `127.0.0.1`. The [GitHub controller](unattended.md) continues reconciling PR heads using its existing App credentials. The remote listener uses the revision recorded by that reconciliation at claim, start, launch and completion. Use a recently reconciled workflow for the smoke test. For same-host development, point the worker directly at this listener.

On the Mac mini, establish a local SSH forward using its existing exe.dev credentials and a verified VM host key.

```sh
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L 127.0.0.1:8788:127.0.0.1:8788 crow-ottoman.exe.xyz
```

Keep the SSH process running and restart it if the link drops. For workers with only HTTP access, an operator-managed HTTPS reverse proxy can forward the worker endpoint to the loopback listener. Configure the proxy to preserve authentication headers and keep them out of access logs. The [exe.dev forwarding example](https://exe.dev/deploy/computer-use#connect-an-agent-from-elsewhere) shows the same SSH topology.

## Worker setup

Install the repo-pinned Node.js and dependencies on the worker. Prepare a trusted repository clone and a private worktree root dedicated to this worker. Keep the clone, linked worktrees and provider profile outside the Switchyard source checkout so local lint and test discovery cannot descend into them. Fetch the exact PR commit into the clone before dispatch. The controller does not request fetches, provide credentials or send commands or worker-local paths. The repository mapping is operator configuration. Use independent clones and roots on workers that share a host.

Choose the exact provider/model combinations this worker can run. The example uses Codex. For Claude Code, use `"provider": "claude-code"` and the `claude` object from the [Claude Code guide](claude-code.md) in place of `codexHome`. The current Claude Code adapter requires its pinned native executable and an Anthropic Console API key. Configure provider authentication only in the worker environment or provider profile.

```json
{
  "id": "mac-mini",
  "controller": "http://127.0.0.1:8788",
  "profiles": [
    {
      "repository": "owner/repo",
      "provider": "codex",
      "model": "MODEL_AVAILABLE_TO_YOUR_ACCOUNT",
      "repositoryDirectory": "/absolute/path/to/clone",
      "worktreeRoot": "/absolute/path/to/worktree-root",
      "codexHome": "/absolute/path/to/private/codex-profile"
    }
  ]
}
```

Supply `SWITCHYARD_WORKER_TOKEN` through the worker's private process environment, then run `npm start -- --remote-worker remote-worker.json`. Keep the same ID and token on restart. Rotate or revoke a token by updating the allowlist and restarting the listener. Each ID has one slot. A process restart gets a fresh incarnation ID and cannot use an earlier incarnation's assignment. A registration records configured capabilities. Provider and checkout preflight verifies usability per turn.

## Two-process smoke test

1. Use a disposable reconciled PR in `awaiting_review` with no existing local agent session. For local development, start the listener and worker in separate terminals with loopback HTTP. For the Mac mini test, run the listener on exe.dev and the worker on the Mac through the SSH forward above. On the controller host run `npm start -- --remote-status` and verify the expected worker ID, architecture, provider, model and online status.
2. Save the request below on the controller host. Replace both SHAs with the reconciled PR head and use a fresh semantic branch on the worker clone. Run `npm start -- --remote-turn request.json`. This command records explicit operator authorization. It can return while the request is waiting for capacity.

   ```json
   {
     "operationId": "remote-smoke-1",
     "workflowId": "owner/repo#42",
     "branch": "test/remote-smoke-42",
     "expectedPullRequestHead": "FULL_PR_HEAD_SHA",
     "expectedHead": "FULL_PR_HEAD_SHA",
     "provider": "codex",
     "model": "MODEL_AVAILABLE_TO_YOUR_ACCOUNT",
     "timeoutMs": 120000,
     "prompt": "Read the repository README and summarize its purpose in one sentence."
   }
   ```

3. Run `npm start -- --remote-status` and `npm start -- --agent-status remote-smoke-1`. Expect `completed`, null error, a provider session reference and the exact head with an empty changed-path list. Check the provider transcript and linked checkout on the Mac. Re-submit the identical request and confirm there is still only one attempt.
4. On a separate disposable PR, stop the worker or tunnel after status shows a running turn and wait past the lease expiration shown by status. The workflow should escalate with an unknown outcome and a held session. Restart the worker and resubmit the same operation ID. Confirm the lease is fenced and the turn does not run again. A late result can appear in status as historical evidence.

## Credentialed execution record

Tested on the Mac mini and `crow-ottoman` with Switchyard commit `80b5f1b2d9f0bb5a21f1825e0298a0859091b0ce` and Codex `gpt-6.2-sol`.

- [PR #20](https://github.com/cellgraph/switchyard/pull/20) completed at `db94843ecde4f0f04d60e0061cdbf701fb26d55e`. The Mac transcript contained a final response, and the linked checkout was clean at that head. Resubmitting the operator's enqueue request returned the saved result with one attempt.
- [PR #19](https://github.com/cellgraph/switchyard/pull/19) ran at `d486e25d79e1ebbd9d4ea3ca629449aa2207e0e0`. The SSH tunnel was disconnected after the controller recorded a live Codex session. The lease expired, the operation became unknown, the session was held, and the worker was quarantined. Reconnecting the same worker retained its late interrupted result as evidence. Resubmitting the operator's enqueue request returned the held outcome with one attempt.

The same credentialed checks passed after the launch remediation on Switchyard commit `e7ad69c5653b608ff8326d00be9187692809cbbf`. PR #20 completed at the same exact head with a final Codex response, a clean linked worktree, and one attempt after enqueue resubmission. On PR #19, a second SSH disconnect after live session evidence again produced lease expiry, an unknown operation, a held session and worker quarantine. The same worker reconnected, its late interrupted report was retained, and resubmission left one attempt.

An automated HTTP test drops the first terminal-report acknowledgement after the controller commits it and verifies that the repeated report is acknowledged without a second transition. Credentialed cross-machine testing has not covered Claude Code, loss of the launch response, or restarting a worker process during an in-flight turn.

## Recovery

An authorized unclaimed request can wait indefinitely for a compatible worker. Reconciliation and the controller sweep retire revoked unclaimed requests and clear their queued prompts. A successful claim occupies the slot and removes the queued prompt from current rows. Restrict access to SQLite, backups, WAL files and worker transcripts. Operation evidence can include bounded diagnostics and worker-local path and session identifiers.

The worker renews every five seconds. A lease spans up to 30 seconds and cannot extend past the request deadline. The worker checks conservative monotonic bounds immediately before provider invocation, after synchronous checkout and session verification. A short controller outage can be bridged if the worker renews before expiry. The worker requests cancellation on timeout or loss of the lease. The controller holds unresolved attempts even when no launch acknowledgement was seen. Completed results can survive a lost acknowledgement through idempotent submission. If the worker exits before submitting, inspect its checkout, provider transcript and processes to recover evidence. A worker ID with an expired, interrupted, or unknown attempt stays quarantined, even if it reconnects or submits late evidence. Inspect and stop any surviving work before provisioning a fresh identity for other workflows. Retain the old records for diagnosis. There is no replay, automatic unquarantine, or session migration command.

Use the authoritative database and a correctly synchronized controller clock. Before restoring a database backup, isolate any workers attached to the old controller and inspect outstanding attempts so an old snapshot cannot reintroduce delivered work.
