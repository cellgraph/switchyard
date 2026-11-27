# Phase C2 verification on the Linux VMs

The controller ran Switchyard as `switchyard` on `switchyard-controller.exe.xyz` with fresh, disposable SQLite databases. It used Rex over the account's existing SSH access to the `exedev` user's Unix socket on `switchyard-agent.exe.xyz`. Rex was preview.25 with API revision 24. The agent VM ran Node.js 26.13.1 on Ubuntu 24.04. The checks used a disposable Git directory, one dedicated Rex session and private attempt directories. The active polling service and live database were outside the test.

## Native turns

Codex used SDK 0.171.0 and the SDK's bundled CLI with ChatGPT subscription sign-in. Claude Code CLI 2.1.332 used first-party Claude subscription sign-in. The Rex launch environment check found no common API-key or alternate-routing overrides. Each provider received two harmless turns.

| Check                              | Observed evidence                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex start and continuation       | Both executions completed. The second turn returned the remembered phrase using the same logical and native session IDs.                                                          |
| Claude Code start and continuation | Both executions completed. The second turn returned the remembered phrase using the same logical and native session IDs.                                                          |
| Correlation and repeat reads       | All four inspections matched the recorded execution, assignment and session and the schema-constrained phrase. Two post-exit reads produced identical results for each execution. |

## Recovery and interruption

These checks used offline assignments and the same Rex connection.

| Check                                       | Observed evidence                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client disconnection and controller restart | Killed a Rex wait client and the Switchyard dispatch process while the remote fixture was waiting. A new controller process read the original SQLite claim and observed the same running block. After releasing the fixture, recovery recorded completion on that claim.                                                                                                                                                        |
| Lost launch acknowledgement                 | A controller-side wrapper let the real Rex launch succeed, withheld its acknowledgement and temporarily failed subsequent Rex calls. Switchyard held the attempt as `unknown` with no block ID. After access returned, recovery found the original block through the correlated file. Reusing the execution ID and retrying under a new ID did not launch again. The one original block finished and reconciled to `completed`. |
| Targeted cancellation                       | Switchyard interrupted one waiting block. The fixture recorded the interrupt and Rex confirmed process exit. The native outcome stayed `unknown`. A second waiting block remained active and completed after being released.                                                                                                                                                                                                    |
| Missing final result                        | The SDK crash left valid start metadata and Rex exit evidence. Switchyard recorded `unknown` and kept the original assignment held. Automated tests also cover rewritten or conflicting result evidence and unavailable transport.                                                                                                                                                                                              |

## A3 containment gate

The [Phase A fixture](native-execution-verification.md#offline-verification) fed 4 MiB of offline input to the pinned SDK. Its stub executable exited before consuming stdin and made no model request. On the agent VM the Rex child exited 1 with uncaught `Error: write EPIPE`. The controller returned a structured, durable `unknown` record for the original claim. Two recovery calls preserved that record. Reusing the execution ID returned the held metadata, and an alternate execution ID for the same assignment was rejected. The stub's launch marker recorded one invocation. This closes the A3 containment gate for Rex-placed Codex dispatch.

The verification covered client and controller process loss, with the Rex server and execution VM still running. Rex server restart, VM reboot, full native descendant cleanup and provider-side effects after cancellation remain outside the observed results. [Operating guide](agent-sessions.md#recovery)
