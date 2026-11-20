import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export type WorktreeTarget = { workflowId: string; branch: string; expectedHead: string };
export type Worktree = { path: string; repository: string; branch: string; workflowId: string };
type RegisteredWorktree = { path: string; branch?: string; unavailable: boolean };

const semanticBranch = /^(feat|fix|docs|refactor|test|chore)\/.+$/;
const commitSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const operations = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "BISECT_START",
  "index.lock",
];

function git(cwd: string, ...args: string[]): string {
  // Git's environment overrides can redirect even commands explicitly given a working directory.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_NO_LAZY_FETCH = "1";
  try {
    return execFileSync(
      "git",
      [
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (cause) {
    throw new Error(`Git command failed (${args[0]}).`, { cause });
  }
}

function gitPath(cwd: string, location: string): string {
  return git(cwd, "rev-parse", "--path-format=absolute", location).slice(0, -1);
}

function worktreeName(workflowId: string): string {
  if (!workflowId.trim()) throw new Error("Workflow ID is required.");
  return createHash("sha256").update(workflowId).digest("hex");
}

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function registeredWorktrees(repository: string): RegisteredWorktree[] {
  const records = git(repository, "worktree", "list", "--porcelain", "-z").split("\0\0");
  return records.filter(Boolean).map((record) => {
    const [path, ...fields] = record.split("\0");
    if (!path?.startsWith("worktree ")) throw new Error("Invalid Git worktree listing.");
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
    return {
      path: path.slice(9),
      ...(branch === undefined ? {} : { branch }),
      unavailable: fields.some((field) => /^(bare|locked|prunable)( |$)/.test(field)),
    };
  });
}

function checkOperations(path: string): void {
  const gitDir = gitPath(path, "--git-dir");
  const operation = operations.find((name) =>
    lstatSync(join(gitDir, name), { throwIfNoEntry: false }),
  );
  if (operation) throw new Error(`Worktree has an active Git operation or lock (${operation}).`);
}

function changedPaths(path: string): string[] {
  const status = git(
    path,
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  return status
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const code = entry.slice(0, 2);
      if (code.includes("U") || code === "AA" || code === "DD")
        throw new Error("Workflow worktree has unresolved conflicts.");
      return entry.slice(3);
    });
}

export function createWorktreeManager({
  repositoryDirectory,
  worktreeRoot,
}: {
  repositoryDirectory: string;
  worktreeRoot: string;
}) {
  const source = realpathSync(repositoryDirectory);
  const root = realpathSync(worktreeRoot);
  if (!statSync(root).isDirectory()) throw new Error("Worktree root must be a directory.");
  if (realpathSync(gitPath(source, "--show-toplevel")) !== source)
    throw new Error("Repository directory must be a Git checkout root.");
  const repository = realpathSync(gitPath(source, "--git-common-dir"));
  const repositoryStat = statSync(repository, { bigint: true });
  if (inside(repository, root)) throw new Error("Worktree root overlaps Git metadata.");

  function locate({ workflowId, branch }: WorktreeTarget): Worktree {
    if (!semanticBranch.test(branch)) throw new Error("A semantic workflow branch is required.");
    git(source, "check-ref-format", `refs/heads/${branch}`);
    return { path: join(root, worktreeName(workflowId)), repository, branch, workflowId };
  }

  function registrations(worktree: Worktree): RegisteredWorktree[] {
    const currentRepository = realpathSync(gitPath(source, "--git-common-dir"));
    const currentStat = statSync(currentRepository, { bigint: true });
    if (
      realpathSync(root) !== root ||
      currentRepository !== repository ||
      currentStat.dev !== repositoryStat.dev ||
      currentStat.ino !== repositoryStat.ino
    )
      throw new Error("Configured repository or worktree root moved.");
    const registered = registeredWorktrees(source);
    for (const [index, entry] of registered.entries()) {
      const path = lstatSync(entry.path, { throwIfNoEntry: false })
        ? realpathSync(entry.path)
        : entry.path;
      if (index > 0 && path !== source && path === worktree.path && entry.path === worktree.path)
        continue;
      if (inside(path, root) || inside(worktree.path, path))
        throw new Error("Workflow worktree would overlap an existing Git checkout.");
    }
    return registered;
  }

  function inspect(worktree: Worktree) {
    if (
      worktree.repository !== repository ||
      worktree.path !== join(root, worktreeName(worktree.workflowId))
    )
      throw new Error("Workflow worktree does not belong to this manager.");
    const entry = registrations(worktree).find(({ path }) => path === worktree.path);
    if (
      !entry ||
      entry.unavailable ||
      !lstatSync(worktree.path)?.isDirectory() ||
      realpathSync(worktree.path) !== worktree.path ||
      realpathSync(gitPath(worktree.path, "--show-toplevel")) !== worktree.path ||
      realpathSync(gitPath(worktree.path, "--git-common-dir")) !== repository
    )
      throw new Error("Workflow worktree does not match its registered repository and path.");
    if (
      entry.branch !== worktree.branch ||
      git(worktree.path, "symbolic-ref", "HEAD") !== `refs/heads/${worktree.branch}\n`
    )
      throw new Error("Workflow worktree is on a different branch.");
    checkOperations(worktree.path);
    return {
      head: git(worktree.path, "rev-parse", "--verify", "HEAD^{commit}").trim(),
      changedPaths: changedPaths(worktree.path),
    };
  }

  function validate(worktree: Worktree, expectedHead: string) {
    if (!commitSha.test(expectedHead)) throw new Error("Expected a full Git commit SHA.");
    const state = inspect(worktree);
    if (state.head !== expectedHead) throw new Error("Workflow worktree is at a different commit.");
    return state;
  }

  return {
    open(target: WorktreeTarget, create: boolean): Worktree {
      const worktree = locate(target);
      if (!commitSha.test(target.expectedHead)) throw new Error("Expected a full Git commit SHA.");
      const registered = registrations(worktree);
      if (!registered.some(({ path }) => path === worktree.path)) {
        if (!create) throw new Error("Workflow worktree is missing.");
        if (lstatSync(worktree.path, { throwIfNoEntry: false }))
          throw new Error("Workflow worktree path already exists without a matching registration.");
        if (registered.some(({ branch }) => branch === worktree.branch))
          throw new Error("Workflow branch is already checked out.");
        checkOperations(source);
        const ref = `refs/heads/${worktree.branch}`;
        const existing = git(source, "for-each-ref", "--format=%(refname)%09%(objectname)", ref)
          .split("\n")
          .find((line) => line.startsWith(`${ref}\t`))
          ?.slice(ref.length + 1);
        if (existing !== undefined) {
          if (existing !== target.expectedHead)
            throw new Error("Existing workflow branch is at a different commit.");
          git(source, "worktree", "add", "--", worktree.path, worktree.branch);
        } else {
          if (git(source, "cat-file", "-t", target.expectedHead) !== "commit\n")
            throw new Error("Expected SHA is not a commit in the configured repository.");
          git(
            source,
            "worktree",
            "add",
            "--no-track",
            "-b",
            worktree.branch,
            "--",
            worktree.path,
            target.expectedHead,
          );
        }
      }
      const state = validate(worktree, target.expectedHead);
      if (create && state.changedPaths.length)
        throw new Error("A new agent session requires a clean workflow worktree.");
      return worktree;
    },

    validate,

    observe(worktree: Worktree, beforeHead: string) {
      const state = inspect(worktree);
      const committed =
        state.head === beforeHead
          ? []
          : git(
              worktree.path,
              "diff",
              "--name-only",
              "--no-ext-diff",
              "--no-renames",
              "-z",
              beforeHead,
              state.head,
              "--",
            )
              .split("\0")
              .filter(Boolean);
      return {
        head: state.head,
        changedPaths: [...new Set([...committed, ...state.changedPaths])].sort(),
      };
    },
  };
}

export type WorktreeManager = ReturnType<typeof createWorktreeManager>;
