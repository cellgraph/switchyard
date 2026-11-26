# Local agent execution

The development CLI runs assignments directly through the Codex TypeScript SDK or native Claude Code CLI. An assignment can run in a regular local clone with no PR or GitHub App credentials.

Prepare the working directory, dependencies, and native agent account and permissions on the local host. Use the native runtime's ordinary settings for credentials, tools and billing. The runtime and agent handle worktrees, validation, commits and publication as required by the assignment. Preserve the local native profile and session history for continuation.

## Run and continue

Point `SWITCHYARD_DB_PATH` at a fresh development database. On each invocation, write the assignment prompt in a private text file. When a response schema is needed, supply a JSON Schema object in a separate file.

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard-dev.sqlite

npm start -- agent run --provider codex --cwd /path/to/clone \
  --execution codex-first --prompt /path/to/first.txt

npm start -- agent status codex-first

npm start -- agent run --session SESSION_ID \
  --execution codex-next --prompt /path/to/next.txt --schema /path/to/schema.json
```

Use the Switchyard ID in `session.id` for `--session`. The adapter resumes the native reference in `session.nativeId` using the stored provider and invocation context. Each continuation submits a new assignment by default. Set `--model` to override the native default and `--config-dir` to select a Codex home or [Claude Code configuration directory](claude-code.md) when starting a session. Omit `--cwd` to use the current directory. When model or configuration directory is omitted, the provider uses its normal defaults and inherited environment.

Before dispatch, `agent run` prints its execution ID to stderr, including when the command generates the ID. Use `agent status EXECUTION_ID` with that ID to inspect an interrupted run. The command's stdout carries one JSON result with an `execution` and a `session` when the record is available. When the current invocation completes, it also returns `result.response` and any `result.structuredOutput`. Treat stdout as potentially sensitive. SQLite and `agent status` retain coordination metadata and the reference only. Keep secrets out of prompts, schemas and labels.

Supply `--execution ID` to reserve an ID you can inspect after a crash. The execution ID also serves as the assignment ID unless you pass `--assignment ID`. Reusing a recorded execution ID with the same assignment and context returns its metadata, with no dispatch or stored response. Use a new execution ID with the same assignment ID for an explicit retry after `not_started`.

## Recovery

| Status        | Meaning                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------ |
| `running`     | SQLite committed the intent and claimed dispatch. The owner may still record an outcome.                     |
| `completed`   | The runtime supplied the required completion result, and Switchyard recorded the terminal status.            |
| `not_started` | Switchyard has evidence of non-execution, such as pre-launch cancellation or failure to spawn the runtime.   |
| `failed`      | The runtime reported a failure or returned unusable result data after a known turn. Side effects can remain. |
| `unknown`     | The outcome could not be established. The assignment and any associated session are held for inspection.     |

`agent run` exits nonzero when the stored execution status is anything other than `completed`. Native errors appear as fixed diagnostics. Ctrl-C requests cancellation through the native interface. If cancellation leaves no authoritative result, the status is `unknown`.

A confirmed turn that omits required output or returns unusable output fails the assignment. A later assignment can still use the recorded session. If SQLite is briefly busy or locked, the current owner retries saving the observed ID and outcome. The CLI returns a native result only after the write is confirmed. A persistent write failure leaves the claim held for recovery.

Run `npm start -- agent recover` to mark claims whose local owner exited before recording an outcome. A live or reused PID leaves the claim intact. A crash can leave native processes or external effects in progress. Inspect the execution record, native session and any external effects using the runtime and environment. The development CLI keeps uncertain assignments and sessions held. Use the database on the same persistent local host as the execution processes.

## Remaining Phase A verification

The offline suite covers both adapters and the durable lifecycle using fixtures. In the operator's preconfigured environments, start a session with each native provider, record a harmless test phrase, and continue the same session in another process after running recovery. Ask the second assignment to return the phrase without repeating it in the prompt. Exercise structured output and check the durable terminal state and native ID across invocations. Verify cancellation and inspection behavior in a disposable environment and record any limitations. Record the observed native account and continuation behavior separately from the offline tests. Use the operator's existing accounts and configurations for this verification.

[Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript) · [Claude Code programmatic usage](https://code.claude.com/docs/en/headless)
