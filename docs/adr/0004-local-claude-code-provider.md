# ADR-0004: Run Claude Code through the local agent boundary

- Status: Accepted for Phase 5.6A
- Date: 2026-11-22

## Context

The local worker and durable session binding now need to support a second implementation provider. Claude Code's CLI provides noninteractive execution, structured results, and session continuation. Its Bash sandbox and transcript lookup have different guarantees from Codex's workspace-write sandbox and indexed rollout selection.

## Decisions

1. Select Codex or Claude Code in the local worker factory from the explicit request or saved fix-cycle settings. Preserve the existing Codex default and runtime fingerprint. Provider choice is independent of execution location.
2. Use the pinned Claude Code CLI with restricted, noninteractive file tools and per-cycle edit permissions. Exclude shell and general-purpose execution tools. Use a dedicated profile and the supported API key helper on unmanaged hosts. Refuse known managed settings sources and incompatible launch evidence. Keep validation under the existing controller.
3. Verify a matching initialization and result plus clean process exit. Bind the Claude transcript to the same checkout, provider session ID, file identity, and content digest. Resume by exact path. Reuse the existing owner claim, authorization, operation outcomes, and hold-on-ambiguity rules.
4. Store sanitized outcomes, usage, reported model, and cumulative cost estimates alongside existing runtime and checkout evidence. Raw CLI output and model content are ephemeral to Switchyard. Claude Code retains its transcript in the private profile.

## Consequences

Claude Code can read and edit files through its restricted tool API. Fixes that require commands during implementation need a provider with a supported shell boundary. Both providers leave Git publication to the separately authorized controller path. The Claude CLI pin requires renewed permission and transcript verification before an upgrade. A changed provider runtime or interrupted turn holds the existing binding. Remote worker identity and fencing remain a later phase.
