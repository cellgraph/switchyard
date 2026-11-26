# Historical HTTP worker

Phase A2 retired the HTTP remote worker, its CLI commands and its SQLite tables. The code, tests, operating guide and prior live observations are available in the [last revision supporting the worker](https://github.com/cellgraph/switchyard/tree/167b0c021805c014951ae124958fb104bc841468). The original design is recorded in [ADR-0004](adr/0004-remote-agent-turns.md), which [ADR-0006](adr/0006-orchestrate-through-native-tools.md) supersedes.

The current [local execution path](agent-sessions.md) uses native runtimes on the configured host. [Phase C of Plan 003](plans/003-architectural-simplification.md#phase-c--investigate-rex-then-implement-explicit-remote-placement) will investigate Superlogical Rex before choosing a remote mechanism.
