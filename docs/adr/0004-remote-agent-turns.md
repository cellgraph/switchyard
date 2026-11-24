# ADR-0004: Poll for leased agent turns

- Status: Accepted for Phase 5.6B

## Decision

Add an execution listener to the controller host. It opens the same SQLite database as the workflow controller. Remote workers initiate versioned JSON requests for registration, claims, progress, launch authorization, renewal, and completion. Bind the listener to loopback. Use SSH local forwarding to exe.dev for the first deployment or an operator-managed HTTPS reverse proxy with end-to-end credential handling. The Mac needs no inbound listener. Polling trades claim latency for simple reconnects and avoids a broker, public worker services, and long-lived application streams.

The operator provisions an opaque ID and a distinct high-entropy bearer token per worker. The controller has a static ID-to-token-digest allowlist. A worker configures its own repository clones, provider installation, profile, model and credentials. It advertises exact repository/provider/model combinations, an operating system, an architecture, isolated checkout and read-only execution support, and one slot. The controller matches the task against those capabilities and pins continuations to their original worker and runtime. Separate worker processes and identities supply parallel capacity.

An explicit operator request atomically stores a normal durable agent turn and its bounded remote payload. A claim atomically records the worker, worker-process instance, unique fence, and expiration before returning the payload. Start and progress reports augment the existing operation evidence. The controller grants launch once after rechecking the recorded workflow authorization, observation revision, and current fence. The worker independently verifies the checkout and provider session. The controller accepts terminal evidence only from the current lease, validates its shape and binding, and atomically records the result through the existing agent operation store. Workers cannot send workflow commands.

A claim is delivered at most once. A lost claim or launch response is ambiguous and never redelivered. Heartbeats extend the lease up to a hard deadline. An expired lease produces an unknown outcome, holds the session and escalates the workflow. A valid late result can be retained as evidence without changing that decision. The same terminal result can be acknowledged again after a lost reply. Controller restart resumes unexpired leases in SQLite. A restarted worker polls with a fresh process identity and never resumes an in-flight claim. A confirmable provider failure may be recorded as known but still holds the session. No elapsed timeout proves the old process stopped or authorizes replay.

## Scope and trust

The first remote operation is an explicitly requested read-only turn on a reconciled PR awaiting review. The existing local adapters enforce the remote read-only profile and the existing worktree and session checks. The controller verifies exact Git head and empty changed paths on success. Workers are trusted to enforce their local execution policy and report evidence faithfully, with no authority to update GitHub or determine workflow readiness. Credentials and local repository configuration never travel in task payloads. Worker evidence can contain local path and session identifiers.

Local agent and fix execution remain available. Remote sessions cannot enter the local fix pipeline. Remote candidate transfer, controller-side verification and distributed validation/publication require a separate design. Existing review, CI, approval and no-merge rules apply unchanged.
