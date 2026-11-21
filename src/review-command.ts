import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { createGitHubReader, type PullRequestTarget } from "./github-api.ts";
import { createGitHubAppClient } from "./github-app.ts";
import { identifier, record } from "./review.ts";
import { syncReviewPublication } from "./review-publications.ts";
import { WorkflowStore } from "./store.ts";

function readInput(path: string): unknown {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2_000_000)
      throw new Error("Review input must be a JSON file of at most 2 MB.");
    try {
      return JSON.parse(readFileSync(fd, "utf8")) as unknown;
    } catch {
      throw new Error("Review input is not valid JSON.");
    }
  } finally {
    closeSync(fd);
  }
}

export async function runReviewCommand(
  args: string[],
  dbPath: string,
  loadTargets: (path: string) => PullRequestTarget[],
): Promise<boolean> {
  const [command, first, second] = args;
  if (!command?.startsWith("--review-")) return false;
  const usage =
    "Usage: --review-start INPUT.json, --review-finish RUN_ID RESULT.json, " +
    "--review-status WORKFLOW_ID, --review-act INPUT.json, or --review-sync CONFIG.json INPUT.json";
  const arities = new Map([
    ["--review-start", 2],
    ["--review-finish", 3],
    ["--review-status", 2],
    ["--review-act", 2],
    ["--review-sync", 3],
  ]);
  if (args.length !== arities.get(command) || !first) throw new Error(usage);
  const store = new WorkflowStore(dbPath);
  try {
    const reviews = store.reviews();
    let result: unknown;
    switch (command) {
      case "--review-start":
        result = reviews.start(readInput(first));
        break;
      case "--review-finish":
        result = reviews.finish(identifier(first, "review ID"), readInput(second!));
        break;
      case "--review-status":
        result = reviews.inspect(first);
        break;
      case "--review-act":
        result = reviews.act(readInput(first));
        break;
      case "--review-sync": {
        const input = record(readInput(second!));
        const clientId = process.env.GITHUB_APP_CLIENT_ID;
        const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
        if (!clientId || !keyPath)
          throw new Error("Set GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_PATH.");
        const client = createGitHubAppClient({
          clientId,
          privateKey: readFileSync(keyPath, "utf8"),
          rateLimits: store.githubRateLimits(),
          retryDeadlines: store.reconciliationRetries(),
          reviewWrites: input.mode === "publish",
        });
        const reader = createGitHubReader(client);
        const synchronized = await syncReviewPublication(
          store.reviewPublications(),
          {
            ...reader,
            postReviewComment: client.postReviewComment,
            readAppBot: client.readAppBot,
            readReviewThread: client.readReviewThread,
          },
          loadTargets(first),
          { findingId: input.findingId, actionId: input.actionId, mode: input.mode },
        );
        if (
          "state" in synchronized &&
          (synchronized.state !== "published" || synchronized.observation !== "present")
        )
          process.exitCode = 1;
        result = synchronized;
        break;
      }
      default:
        throw new Error(usage);
    }
    console.info(JSON.stringify(result));
    return true;
  } finally {
    store.close();
  }
}
