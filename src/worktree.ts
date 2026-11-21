import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export type WorktreeTarget = { workflowId: string; branch: string; expectedHead: string };
export type WorktreeLocation = {
  path: string;
  repository: string;
  branch: string;
  workflowId: string;
};
export type Worktree = WorktreeLocation & { checkoutIdentity: string };
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

export function git(cwd: string, ...args: string[]): string {
  return runGit(cwd, args);
}

export function runGit(
  cwd: string,
  args: string[],
  options?: { hooksPath?: string; env?: Record<string, string> },
): string {
  // Git's environment overrides can redirect even commands explicitly given a working directory.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, options?.env);
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  try {
    return execFileSync(
      "git",
      [
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        `core.hooksPath=${options?.hooksPath ?? "/dev/null"}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
        killSignal: "SIGKILL",
      },
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

function checkOperations(gitDir: string): void {
  const operation = operations.find((name) =>
    lstatSync(join(gitDir, name), { throwIfNoEntry: false }),
  );
  if (operation) throw new Error(`Worktree has an active Git operation or lock (${operation}).`);
}

function checkoutStatus(path: string) {
  // Git status can omit changes to files with either of these index flags.
  const entries = git(path, "ls-files", "-v", "-z");
  if (/(?:^|\0)[Ss] /.test(entries))
    throw new Error("Workflow worktree has skip-worktree index entries.");
  if (/(?:^|\0)[a-z] /.test(entries))
    throw new Error("Workflow worktree has assume-unchanged index entries.");
  const status = git(
    path,
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  const changedPaths = status
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const code = entry.slice(0, 2);
      if (code.includes("U") || code === "AA" || code === "DD")
        throw new Error("Workflow worktree has unresolved conflicts.");
      return entry.slice(3);
    });
  return { status, changedPaths };
}

function contentCheckpoint(pathRoot: string, hash = createHash("sha256")): string {
  // Include ignored files and raw bytes, since Git status can report the same paths after edits.
  let remainingBytes = 64 * 1024 * 1024;
  let remainingEntries = 10_000;
  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      if (directory === pathRoot && name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (--remainingEntries < 0 || (remainingBytes -= stat.size) < 0)
        throw new Error("Worktree exceeds the bounds for a durable checkout checkpoint.");
      hash.update(JSON.stringify([relative(pathRoot, path), stat.mode]));
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink())
        hash.update(
          createHash("sha256")
            .update(readlinkSync(path, { encoding: "buffer" }))
            .digest(),
        );
      else if (stat.isFile()) hash.update(createHash("sha256").update(readFileSync(path)).digest());
      else throw new Error("Worktree contains an unsupported file type.");
    }
  }
  visit(pathRoot);
  return hash.digest("hex");
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

  function locate({ workflowId, branch }: WorktreeTarget): WorktreeLocation {
    if (!semanticBranch.test(branch)) throw new Error("A semantic workflow branch is required.");
    git(source, "check-ref-format", `refs/heads/${branch}`);
    return { path: join(root, worktreeName(workflowId)), repository, branch, workflowId };
  }

  function registrations(worktree: WorktreeLocation): RegisteredWorktree[] {
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

  function inspect(
    worktree: WorktreeLocation,
    { expectedCheckout, expectedHead }: { expectedCheckout?: string; expectedHead?: string } = {},
  ) {
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
    const gitDir = realpathSync(gitPath(worktree.path, "--git-dir"));
    const { dev, ino, birthtimeNs } = statSync(gitDir, { bigint: true });
    const directory = statSync(worktree.path, { bigint: true });
    // Git may reuse a worktree administration path after a checkout is removed.
    const checkoutIdentity = JSON.stringify([
      gitDir,
      String(dev),
      String(ino),
      String(birthtimeNs),
      String(directory.dev),
      String(directory.ino),
      String(directory.birthtimeNs),
    ]);
    if (expectedCheckout !== undefined && checkoutIdentity !== expectedCheckout)
      throw new Error("Workflow worktree is a different linked checkout.");
    checkOperations(gitDir);
    const head = git(worktree.path, "rev-parse", "--verify", "HEAD^{commit}").trim();
    if (expectedHead !== undefined && head !== expectedHead)
      throw new Error("Workflow worktree is at a different commit.");
    return {
      checkoutIdentity,
      head,
      ...checkoutStatus(worktree.path),
    };
  }

  function validate(worktree: Worktree, expectedHead: string) {
    if (!commitSha.test(expectedHead)) throw new Error("Expected a full Git commit SHA.");
    const { head, changedPaths } = inspect(worktree, {
      expectedCheckout: worktree.checkoutIdentity,
      expectedHead,
    });
    return { head, changedPaths };
  }

  return {
    locate,

    open(target: WorktreeTarget, create: boolean | "new"): Worktree {
      const worktree = locate(target);
      if (!commitSha.test(target.expectedHead)) throw new Error("Expected a full Git commit SHA.");
      const registered = registrations(worktree);
      const present = registered.some(({ path }) => path === worktree.path);
      if (present && create === "new")
        throw new Error("A workflow worktree already exists without a durable session binding.");
      if (!present) {
        if (!create) throw new Error("Workflow worktree is missing.");
        if (lstatSync(worktree.path, { throwIfNoEntry: false }))
          throw new Error("Workflow worktree path already exists without a matching registration.");
        if (registered.some(({ branch }) => branch === worktree.branch))
          throw new Error("Workflow branch is already checked out.");
        checkOperations(gitPath(source, "--git-dir"));
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
      const { checkoutIdentity, changedPaths } = inspect(worktree, {
        expectedHead: target.expectedHead,
      });
      if (create && changedPaths.length)
        throw new Error("A new agent session requires a clean workflow worktree.");
      return { ...worktree, checkoutIdentity };
    },

    validate,

    checkpoint(worktree: Worktree, expectedHead: string): string {
      const { status } = inspect(worktree, {
        expectedCheckout: worktree.checkoutIdentity,
        expectedHead,
      });
      // Porcelain distinguishes intent-to-add from staged addition even when index blobs match.
      const hash = createHash("sha256").update(
        JSON.stringify([status, git(worktree.path, "ls-files", "--stage", "-z")]),
      );
      return contentCheckpoint(worktree.path, hash);
    },

    contentCheckpoint(worktree: Worktree, expectedHead: string): string {
      validate(worktree, expectedHead);
      return contentCheckpoint(worktree.path);
    },

    observe(worktree: Worktree, beforeHead: string) {
      const state = inspect(worktree, { expectedCheckout: worktree.checkoutIdentity });
      const committed =
        state.head === beforeHead
          ? []
          : git(
              worktree.path,
              "diff",
              "--name-only",
              "--no-ext-diff",
              "--no-renames",
              "--ignore-submodules=none",
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
