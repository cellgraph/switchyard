# Phase A native execution verification

## Live verification

On 2026-11-26, the operator's Apple silicon Mac mini ran macOS 27.2.1 and Node.js 26.13.1. The implementation worktree started at `f01aa5d` (PR #26). Each provider used a disposable local Git repository, and the runs shared a fresh Switchyard SQLite database. Prompts and the schema were private temporary files. Switchyard used the existing native settings and permissions.

| Provider    | Runtime used for assignments              | Account evidence                                                                        |
| ----------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Codex       | SDK 0.171.0 and bundled Codex CLI 0.171.0 | Bundled `codex login status` reported ChatGPT sign-in. The default provider was OpenAI. |
| Claude Code | Native CLI 2.1.332                        | `claude auth status` reported first-party Claude Max sign-in.                           |

The invocation environment and applicable settings checked showed no API-key or alternate endpoint overrides. The verification used native subscription authentication with no credentials supplied by Switchyard. Each provider received two successful assignments and one short continuation launched for interruption.

| Check                    | Codex                                                            | Claude Code                                                      |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Start and tool operation | Returned the exact value available only in the local fixture.    | Returned the exact value available only in the local fixture.    |
| Restart and recovery     | Start exited 0. A separate `agent recover` reported 0 changes.   | Start exited 0. A separate `agent recover` reported 0 changes.   |
| Continuation             | A new process exited 0 using the same Switchyard and native IDs. | A new process exited 0 using the same Switchyard and native IDs. |
| Structured response      | `result.structuredOutput` matched the remembered phrase.         | `result.structuredOutput` matched the remembered phrase.         |

The continuation prompt omitted the phrase. Switchyard parses Codex's last agent message as JSON when a schema is supplied. Claude Code passed the separate `structured_output` field in its terminal event. The fixture reads used the ordinary permissions of each profile. The test covered local reads only.

A separate SQLite reader saw `running` with an owner and no finish timestamp during each invocation. After exit, `agent status` returned the same execution and session metadata as the CLI result, with distinct assignment and execution IDs. Completed rows had a finish timestamp and no owner PID. Repeating a completed execution ID returned the same metadata with no result or new execution. The offline suite establishes the ordering of intent before dispatch and the terminal commit before returning a result.

### Cancellation and inspection

Each cancellation run used a short continuation of its disposable session. After detecting the launched native child, the harness sent SIGINT to the Switchyard process alone. Both observed native child processes exited. Neither adapter obtained a terminal result. Both Switchyard processes exited 1 with a cancellation diagnostic and a durable `unknown` record tied to the original native ID. A separate recovery reported zero changes. A new assignment on the held session and a new attempt for the held assignment were both refused.

- **Codex.** With the installed inspection CLI 0.172.0, a fresh App Server read the same thread via `thread/read`. Its local runtime status was `notLoaded`. The supported `thread/turns/list` request returned `interrupted`, `completed`, `completed` in newest-first order. Codex had recorded a native interruption even though the SDK stream delivered no terminal result to Switchyard. That status does not establish non-execution or the absence of side effects. [Codex App Server](https://developers.openai.com/codex/app-server)
- **Claude Code.** The supported interactive `claude --resume NATIVE_SESSION_ID` path reached the workspace trust screen in the original disposable working directory. Inspection stopped at that screen without changing trust or submitting a turn. The session's visibility and turn status after interruption remain unverified. The stored ID and direct process exit alone support keeping the hold. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)

The tested signal requests shutdown of the non-interactive subprocess. Interactive turn interruption is a separate native operation. Claude Code's documented Esc or Ctrl-C interrupt can leave the interactive session open. Codex App Server exposes `turn/interrupt` for a turn managed by that server. Neither was exercised live. The test observed direct subprocesses only. It did not establish descendant cleanup, the fate of server-side requests, or behavior after disconnection or hard shutdown. [Claude Code interactive controls](https://code.claude.com/docs/en/interactive-mode) · [Codex App Server](https://developers.openai.com/codex/app-server)

## Offline verification

- The automated controller and adapter fixtures cover intent visible from a second SQLite connection before native dispatch, early session persistence, terminal commit before response, duplicate execution IDs, and retry only after `not_started`. They also exercise a dead owner leaving a durable `running` claim, recovery to `unknown`, continued holds on the assignment and session, and zero automatic replay.
- The SDK process fixture supplies 4 MiB of synthetic input through the actual SDK's `runStreamed` and supported `codexPathOverride`. The executable is a local shell fixture that exits 2 without reading stdin. It cannot make a model request. On the pinned SDK, the isolated Node process exited 1 with an uncaught `Error: write EPIPE` and no JSON result. The observer survived. The durable intent remained `running` until recovery marked it `unknown` once and refused a replacement attempt for the same assignment.
- Running the same stdin trigger directly through the published 0.172.0 SDK also exited 1 with uncaught `EPIPE` and no caught error or stdout. The latest stable release and upstream source checked still attach the process error handler and write to stdin without handling stdin stream errors. The upstream issue is open. No supported fix was found. [PR #26 review thread](https://github.com/cellgraph/switchyard/pull/26#discussion_r4711736839) · [Upstream issue](https://github.com/openai/codex/issues/49670) · [0.172.0 SDK source](https://github.com/openai/codex/blob/rust-v0.172.0/sdk/typescript/src/exec.ts#L189-L203) · [Upstream source](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)

## Phase A assessment and follow-on gates

The local Phase A criteria are met. The CLI and persistence supported both providers without runtime changes. A3 records the operator's architectural decisions, updates the operating guides and adds the offline SDK regression. The Claude post-interruption inspection limit leaves the documented hold necessary.

- **Phase B.** GitHub reconciliation can proceed independently. Authoritative external evidence may establish a workflow objective while the native execution remains uncertain. Preserve the execution record and any hold required to prevent duplicate work.
- **Phase C.** The Rex executor confines the pinned SDK's early-exit crash to a remote process. The [C2 two-VM verification](rex-execution-verification.md#a3-containment-gate) confirms the controller survives, preserves its claim and declines to replay unresolved work. The standalone CLI retains the local process boundary.
- **Phase D.** Use Rex placement for long-lived role dispatch. Assign the existing named agent configurations to roles and clarify attribution and scoped external access as real role requirements emerge. Preserve operator-directed recovery for unclear outcomes. Wider permission behavior, autonomous role operation and production cutover remain future work.
