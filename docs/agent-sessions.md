# Native agent execution

Switchyard runs explicit Codex SDK and Claude Code CLI assignments in a local directory or through Rex. It can start a new native session or continue a recorded one. The execution CLI needs a controller SQLite database and does not require PR or GitHub App context.

Prepare the working directory, software and native account on the execution host. The native runtime owns credentials, permissions, billing and conversation history. The npm Codex SDK uses its own bundled CLI. Check subscription sign-in through that CLI's `login status` or through `claude auth status` in the invocation environment. For subscription runs, also check inherited environment and native settings for billing or routing overrides.

## Run and continue

Point `SWITCHYARD_DB_PATH` at a fresh [controller database](state-model.md#sqlite-baseline). Write each prompt in a private text file. To request structured output, supply a JSON Schema object in a separate file.

```sh
export SWITCHYARD_DB_PATH=/absolute/path/to/switchyard-dev.sqlite

npm start --silent -- agent run --provider codex --cwd /path/to/clone \
  --execution codex-first --prompt /path/to/first.txt

npm start --silent -- agent run --agent remote-claude --agents /path/to/agents.json \
  --execution claude-first --prompt /path/to/first.txt --schema /path/to/schema.json

npm start --silent -- agent run --session SESSION_ID \
  --execution claude-next --prompt /path/to/next.txt --schema /path/to/schema.json
```

Use the Switchyard `session.id` with `--session`. Continuation uses the stored provider, invocation context, placement and `session.nativeId`. Each execution creates a new assignment by default. Set `--assignment` to use an existing assignment ID. A duplicate execution ID with matching context returns SQLite metadata without dispatch. An explicit retry after `not_started` uses a new execution ID with the same assignment ID.

For inline local execution, omit `--cwd` to use the current directory. Set `--model` to choose a model or `--config-dir` to select a Codex home or [Claude Code configuration directory](claude-code.md). The providers otherwise inherit their ordinary defaults.

The run command prints the execution ID on stderr before dispatch and returns JSON on stdout. A successful new run returns the native response and any structured output. If SQLite records a Rex completion but the final file cannot be retrieved and verified, the command exits with an error. Inspect the same execution to retrieve its result. Treat native output as potentially sensitive.

## Rex placement on Linux

The controller runs as `switchyard` on `switchyard-controller.exe.xyz`. The executor runs as `exedev` on `switchyard-agent.exe.xyz`. Rex preview.25 (API revision 24) is installed on both hosts. On the agent VM, Rex runs under persistent systemd user units. The controller account uses its existing VM-scoped SSH identity and strict host-key verification to reach the execution account's Unix socket.

Prepare the reviewed Switchyard source and locked runtime dependencies on both hosts, a working directory on the agent VM, and an agent-owned state directory with mode `0700`. Prepare a dedicated Rex session on the agent VM and obtain the full `session_id` from `rex new --json` using the endpoint below. Keep the session available for dispatch, file transfer and process inspection.

```sh
sudo -u switchyard -H /usr/local/bin/rex --autostart=false \
  -S ssh://exedev@switchyard-agent.exe.xyz/run/user/1000/rex/server.sock server status
```

The named agent file can contain several entries sharing one VM and Rex session. Each entry needs `provider`, `placement` and an absolute `workingDirectory`. Optional `model` and absolute `configDirectory` apply on the execution host. A named local agent sets `placement` to `local` and omits `rex`.

```json
{
  "agents": {
    "remote-claude": {
      "provider": "claude-code",
      "placement": "rex",
      "workingDirectory": "/home/exedev/checkout",
      "rex": {
        "endpoint": "ssh://exedev@switchyard-agent.exe.xyz/run/user/1000/rex/server.sock",
        "session": "session:00000000-0000-0000-0000-000000000000",
        "executable": "/usr/local/bin/rex",
        "node": "/usr/local/bin/node",
        "executor": "/home/exedev/switchyard/src/remote-executor.ts",
        "stateDirectory": "/home/exedev/switchyard-state"
      }
    }
  }
}
```

Substitute the real session ID and paths. `executable` is on the controller. The other paths are on the agent VM. The executor validates the working directory directly because Rex can fall back to the user's home for an invalid terminal cwd.

SQLite commits the claim with an attempt key before any Rex contact. Switchyard uses that key as the remote directory name, stages the private request with `rex cp`, and launches the one-shot executor with `rex run --shell=none --keep-open`. The executor claims the directory once and publishes correlated metadata, any observed native session ID and the final result through atomic file replacement. It removes the request after reading it. The controller retrieves the file with `rex cp`. It stores the outcome and final evidence digest in SQLite and leaves native transcripts in the native profiles.

## Recovery

| Status        | Meaning                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `running`     | SQLite claimed dispatch and an outcome may still arrive.                                                   |
| `completed`   | Switchyard recorded a confirmed native completion.                                                         |
| `not_started` | Switchyard has affirmative evidence of non-execution, such as failure before the Rex launch was attempted. |
| `failed`      | The runtime reported failure or unusable output after a known turn. Side effects can remain.               |
| `unknown`     | Switchyard holds the assignment and session for inspection.                                                |

```sh
npm start --silent -- agent status EXECUTION_ID
npm start --silent -- agent inspect EXECUTION_ID
npm start --silent -- agent recover
npm start --silent -- agent cancel EXECUTION_ID
```

`status` reads SQLite only. Rex `inspect` checks the recorded attempt's files and block, reconciles available evidence and can return the same confirmed result repeatedly. `recover` does the same for unresolved remote attempts without returning response content. Run recovery in a separate CLI invocation after controller restart to keep GitHub polling independent of the Rex connection. Each operation observes existing work without dispatching.

Lost launch acknowledgement can leave a claim held without a block ID. A later inspection can recover it from executor metadata and validate the evidence against the original execution, assignment and session. A missing file, broken connection or process exit supplies no native outcome by itself. If a result later becomes available, recover the same attempt. The assignment remains protected from replacement dispatch while its outcome is uncertain.

Rex `cancel` verifies the running block's session, ID and attempt label before sending Ctrl-C. Its `interruption` field reports whether Rex acknowledged the request. Use `inspect` for process exit and the separately recorded native outcome. SIGINT or SIGTERM during `agent run` requests cancellation on the selected placement. A Rex process exit may leave descendants or external effects that require native inspection.

For local attempts, `recover` marks dead owners' claims unknown. A live or reused PID leaves the claim intact. The pinned Codex SDK can terminate its invoking Node process when its CLI exits early. With Rex, the crash is confined to the executor process and the original claim remains on the controller. Local runs use the standalone process boundary. Use supported native inspection when needed. [Codex App Server](https://developers.openai.com/codex/app-server) · [Claude Code session inspection](claude-code.md#inspecting-an-interrupted-session)

Keep the Rex session and evidence until the operator no longer needs inspection. The executor retains the claim marker and latest evidence file. An interruption during staging may leave a private request file, and the operator owns retention of these directories and Rex blocks. Process inspection and cancellation use the original session. If that session is gone, `inspect` and `recover` can still retrieve durable files through any available session on the same Rex endpoint. If the endpoint has no sessions, create one before retrieving the files. Phase D owns the active service and database cutover.
