import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FixCycle, ValidationCommand, ValidationResult } from "./fix-store.ts";
import { git, runGit, type WorktreeManager } from "./worktree.ts";

function paths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

export function createFixGit(worktrees: WorktreeManager, remote: string) {
  function destination(cycle: FixCycle): string {
    const ref = `refs/heads/${cycle.remoteBranch}`;
    git(cycle.config.repositoryDirectory, "check-ref-format", ref);
    // A local URL rewrite could cause a correct-looking ref to be updated in another repository.
    const config = paths(
      git(cycle.worktree?.path ?? cycle.config.repositoryDirectory, "config", "--null", "--list"),
    );
    if (config.some((entry) => /^url\..+\.(insteadof|pushinsteadof)\n/i.test(entry)))
      throw new Error(
        "Git URL rewriting is configured. Use a clone without URL rewrites for publication.",
      );
    if (!remote.startsWith("git@github.com:") && !remote.startsWith("/"))
      throw new Error("Unsupported publication destination.");
    return ref;
  }

  function assertAllowed(cycle: FixCycle, changed: string[]) {
    if (!changed.length) throw new Error("The agent supplied no candidate changes.");
    for (const path of changed) {
      if (
        !cycle.config.allowedPaths.some(
          (scope) => path === scope || (scope.endsWith("/") && path.startsWith(scope)),
        )
      )
        throw new Error("Candidate contains changes outside the authorized paths.");
    }
  }

  function stagedTree(cycle: FixCycle): string {
    const { path } = cycle.worktree!;
    const changed = paths(git(path, "diff", "--cached", "--name-only", "--no-renames", "-z", "--"));
    assertAllowed(cycle, changed);
    if (
      git(path, "diff", "--name-only", "-z", "--") ||
      git(path, "ls-files", "--others", "--exclude-standard", "-z")
    )
      throw new Error("The candidate has unstaged changes or untracked files.");
    const changedSet = new Set(changed);
    for (const entry of paths(git(path, "ls-files", "--stage", "-z"))) {
      const tab = entry.indexOf("\t");
      const name = entry.slice(tab + 1);
      if (!changedSet.has(name)) continue;
      const [mode, blob] = entry.slice(0, tab).split(" ");
      const stat = lstatSync(join(path, name));
      if (
        !stat.isFile() ||
        mode !== (stat.mode & 0o100 ? "100755" : "100644") ||
        git(path, "hash-object", "--no-filters", "--", name).trim() !== blob
      )
        throw new Error(
          "A staged file is not a regular file with the exact bytes in the checkout.",
        );
    }
    return git(path, "write-tree").trim();
  }

  function assertCandidate(cycle: FixCycle) {
    const worktree = cycle.worktree!;
    if (
      worktrees.checkpoint(worktree, cycle.head) !== cycle.candidate?.checkpoint ||
      stagedTree(cycle) !== cycle.candidate.tree
    )
      throw new Error("The checkout or index changed after the candidate was captured.");
  }

  function verifyCommit(cycle: FixCycle) {
    const { path } = cycle.worktree!;
    const commit = cycle.commit!;
    const parent = git(path, "rev-list", "--parents", "-n", "1", commit).trim();
    if (
      parent !== `${commit} ${cycle.head}` ||
      git(path, "rev-parse", `${commit}^{tree}`).trim() !== cycle.candidate?.tree
    )
      throw new Error("Publication commit does not match the validated tree and parent.");
  }

  return {
    stage(
      cycle: FixCycle,
      agentCheckpoint: string,
      ignoredCheckpoint: string,
    ): NonNullable<FixCycle["candidate"]> {
      const worktree = cycle.worktree!;
      const { changedPaths } = worktrees.validate(worktree, cycle.head);
      if (worktrees.checkpoint(worktree, cycle.head) !== agentCheckpoint)
        throw new Error("The checkout changed since the agent result was recorded.");
      assertAllowed(cycle, changedPaths);
      const content = worktrees.contentCheckpoint(worktree, cycle.head);
      git(worktree.path, "add", "-A", "--");
      const tree = stagedTree(cycle);
      if (worktrees.ignoredCheckpoint(worktree, cycle.head) !== ignoredCheckpoint)
        throw new Error("Ignored inputs changed before validation. Verify the checkout setup.");
      if (worktrees.contentCheckpoint(worktree, cycle.head) !== content)
        throw new Error("Checkout content changed during staging.");
      return { tree, content, checkpoint: worktrees.checkpoint(worktree, cycle.head) };
    },
    assertCandidate,
    createCommit(cycle: FixCycle): string {
      assertCandidate(cycle);
      return git(
        cycle.worktree!.path,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        cycle.candidate!.tree,
        "-p",
        cycle.head,
        "-m",
        "fix: address accepted PR review findings",
        "-m",
        `Switchyard-Cycle: ${cycle.id}`,
      ).trim();
    },
    attachCommit(cycle: FixCycle) {
      verifyCommit(cycle);
      const worktree = cycle.worktree!;
      if (git(worktree.path, "rev-parse", "HEAD").trim() === cycle.commit) {
        this.verifyCheckout(cycle);
        return;
      }
      assertCandidate(cycle);
      git(worktree.path, "update-ref", `refs/heads/${worktree.branch}`, cycle.commit!, cycle.head);
      this.verifyCheckout(cycle);
    },
    verifyCheckout(cycle: FixCycle) {
      verifyCommit(cycle);
      const worktree = cycle.worktree!;
      if (
        worktrees.validate(worktree, cycle.commit!).changedPaths.length ||
        worktrees.contentCheckpoint(worktree, cycle.commit!) !== cycle.candidate!.content
      )
        throw new Error(
          "The published commit is no longer checked out cleanly with the validated files.",
        );
      return worktrees.checkpoint(worktree, cycle.commit!);
    },
    remoteHead(cycle: FixCycle): string | null {
      const ref = destination(cycle);
      const result = git(
        cycle.config.repositoryDirectory,
        "ls-remote",
        "--refs",
        "--",
        remote,
        ref,
      ).trim();
      if (!result) return null;
      const [sha, name] = result.split("\t");
      if (!sha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) || name !== ref)
        throw new Error("Remote branch lookup returned unexpected evidence.");
      return sha;
    },
    push(cycle: FixCycle, authorizeDispatch: () => void) {
      this.verifyCheckout(cycle);
      const ref = destination(cycle);
      const hooksPath = mkdtempSync(join(tmpdir(), "switchyard-push-"));
      try {
        // Git sends the advertised old SHA to receive-pack for the server's ref CAS.
        // This hook also rejects an advertised reset to an older ancestor.
        writeFileSync(
          join(hooksPath, "pre-push"),
          `#!/bin/sh
IFS=' ' read -r local_ref local_sha remote_ref remote_sha || exit 1
[ "$local_sha" = "$SWITCHYARD_PUSH_COMMIT" ] &&
[ "$remote_ref" = "$SWITCHYARD_PUSH_REF" ] &&
[ "$remote_sha" = "$SWITCHYARD_PUSH_BASE" ] || exit 1
if IFS= read -r extra; then exit 1; fi
exit 0
`,
          { mode: 0o700 },
        );
        authorizeDispatch();
        runGit(
          cycle.worktree!.path,
          [
            "-c",
            "push.followTags=false",
            "-c",
            "push.recurseSubmodules=no",
            "-c",
            "push.pushOption=",
            "push",
            "--no-signed",
            "--porcelain",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--",
            remote,
            `${cycle.commit}:${ref}`,
          ],
          {
            hooksPath,
            env: {
              SWITCHYARD_PUSH_COMMIT: cycle.commit!,
              SWITCHYARD_PUSH_REF: ref,
              SWITCHYARD_PUSH_BASE: cycle.head,
            },
          },
        );
      } finally {
        rmSync(hooksPath, { recursive: true, force: true });
      }
    },
  };
}

export type FixGit = ReturnType<typeof createFixGit>;

export function runValidation(
  command: ValidationCommand,
  cwd: string,
  timeoutMs: number,
): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const [file, ...args] = command.argv;
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    const child = spawn(file!, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let remaining = 8192;
    const output: Buffer[] = [];
    let timedOut = false;
    let error: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
            error = "Could not stop validation process group.";
        }
      }
    }, timeoutMs);
    function capture(chunk: Buffer) {
      if (remaining <= 0) return;
      const bounded = chunk.subarray(0, remaining);
      output.push(bounded);
      remaining -= bounded.length;
    }
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", () => {
      error = "Could not run validation command.";
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        id: command.id,
        exitCode,
        status:
          timedOut || error || exitCode === null ? "unknown" : exitCode === 0 ? "passed" : "failed",
        output: [
          error,
          timedOut ? "Validation timed out." : undefined,
          Buffer.concat(output).toString("utf8"),
          remaining === 0 ? "[output capped]" : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    });
  });
}
