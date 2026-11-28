import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseAgentContext } from "../src/agent-config.ts";
import { loadConfig } from "../src/config.ts";

it("loads independent model and effort requests through the existing role mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-agent-config-"));
  try {
    const rex = {
      endpoint: "ssh://test@agent.test/run/rex.sock",
      session: "session:11111111-1111-1111-1111-111111111111",
      executable: "/opt/rex",
      node: "/opt/node",
      executor: "/opt/executor",
      stateDirectory: "/var/agent",
    };
    const review = { provider: "codex", model: "review-model", reasoningEffort: "xhigh" };
    const adjudicate = { provider: "claude-code", reasoningEffort: "max" };
    const implement = { provider: "codex", model: "implementation-model" };
    const base = { workingDirectory: "/repo" };
    const agents = Object.fromEntries(
      Object.entries({ review, adjudicate, implement }).map(([name, settings]) => [
        name,
        { ...base, ...settings, placement: "rex", rex },
      ]),
    );
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents }));
    const repository = "test/repo";
    const config = join(dir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        agentsFile: "agents.json",
        repositories: [{ repository, installationId: 1 }],
        requiredChecks: { [repository]: ["ci"] },
        prWorkflows: {
          [repository]: {
            reviewer: { agent: "review", githubUserId: 1 },
            adjudicator: { agent: "adjudicate", githubUserId: 2 },
            implementer: { agent: "implement", githubUserId: 3 },
            checkApps: { ci: 1 },
          },
        },
      }),
    );
    const roles = loadConfig(config).workflows.get(repository)!;
    expect(roles.reviewer.agent.context).toEqual({ ...base, ...review });
    expect(roles.adjudicator.agent.context).toEqual({ ...base, ...adjudicate });
    expect(roles.implementer.agent.context).toEqual({ ...base, ...implement });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ["codex", "unsupported"],
  ["codex", null],
  ["codex", 1],
  ["claude-code", "minimal"],
  ["claude-code", "ultra"],
  ["claude-code", "persistent"],
  ["claude-code", ""],
])("rejects invalid %s reasoning effort %s", (provider, reasoningEffort) => {
  expect(() =>
    parseAgentContext({ provider, workingDirectory: "/repo", reasoningEffort }, false),
  ).toThrow(`Invalid reasoningEffort for ${provider}`);
});
