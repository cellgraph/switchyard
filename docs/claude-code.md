# Claude Code execution

Install the native `claude` CLI on the trusted local host and make it available on `PATH`. Set up the account and permissions with Claude Code's normal facilities. Switchyard inherits that configuration. For subscription use, check `claude auth status` and check that API-key or routed-provider settings are absent from the invocation environment and native settings. Treat full auth-status output as private account metadata. Optionally pass `--model` for a native model name or alias and `--config-dir` for the directory selected by `CLAUDE_CONFIG_DIR`. Prepare the working directory before starting the assignment. [Claude Code subscription auth](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code)

```sh
npm start --silent -- agent run --provider claude-code --cwd /path/to/clone \
  --prompt /path/to/assignment.txt --schema /path/to/schema.json
npm start --silent -- agent run --session SESSION_ID --prompt /path/to/follow-up.txt
```

The adapter pipes the prompt to print mode, reads the native JSON event stream and passes an optional schema via `--json-schema`. It records the reported session ID and uses `--resume` with that ID for continuation. The terminal result carries `result` text and, when supplied, the separate `structured_output` field. A native error result records `failed`. An authentication diagnostic without a confirmed terminal result leaves the outcome `unknown`.

## Inspecting an interrupted session

In the original working directory, `claude --resume NATIVE_SESSION_ID` opens the native interactive session for inspection. Use the native ID from `agent status`, and avoid submitting a new prompt while Switchyard holds the session. The interactive trust flow can appear even after successful print-mode invocations. The Phase A inspection reached that gate in the disposable repository and stopped there. The interrupted print-mode process supplied no terminal result to Switchyard, which retained its hold. [Phase A verification report](native-execution-verification.md) · [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) · [Claude Code programmatic usage](https://code.claude.com/docs/en/headless)
