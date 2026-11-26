# Claude Code execution

Install the native `claude` CLI on the trusted local host and make it available on `PATH`. Set up the account and permissions with Claude Code's normal facilities. Switchyard inherits that configuration. Optionally pass `--model` for a native model name or alias and `--config-dir` for the directory selected by `CLAUDE_CONFIG_DIR`. Prepare the working directory before starting the assignment.

```sh
npm start -- agent run --provider claude-code --cwd /path/to/clone \
  --prompt /path/to/assignment.txt --schema /path/to/schema.json
npm start -- agent run --session SESSION_ID --prompt /path/to/follow-up.txt
```

The adapter pipes the prompt to print mode, reads the native JSON event stream and passes an optional schema via `--json-schema`. It records the reported session ID and uses `--resume` with that ID for continuation. A terminal error or reported account authentication failure appears as an execution failure. Inspect a held execution using the [local execution guide](agent-sessions.md#recovery).

Use the [Phase A verification procedure](agent-sessions.md#remaining-phase-a-verification) with the configured native account. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) · [Claude Code programmatic usage](https://code.claude.com/docs/en/headless)
