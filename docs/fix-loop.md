# Historical controller-owned fix loop

Phase A, Increment 1 removed this pipeline. Its CLI commands, unattended fix advancement, controller-run validation and controller-owned commits and pushes have been retired. The previous guide is available in the [PR #24 baseline](https://github.com/cellgraph/switchyard/blob/cc539ff9b07f15bbc4937057d1d990c977c38f14/docs/fix-loop.md) as a record of the earlier implementation.

[ADR-0006](adr/0006-orchestrate-through-native-tools.md) assigns these responsibilities to agents and their environments. [Plan 003](plans/003-architectural-simplification.md) sequences the replacement. For current operations, see [unattended polling](unattended.md), [explicit agent turns](agent-sessions.md), and [review operations](reviews.md).
