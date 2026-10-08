import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { Change, Revision } from "./types.ts";

const execute = promisify(execFile);
const MAX_GIT_BYTES = 8 * 1024 * 1024;

interface TreeEntry {
  mode: string;
  oid: string;
  size: number;
}

export function validatePath(path: string): void {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error("Invalid repository-relative path");
  }
}

export async function runGit(
  repo: string,
  args: string[],
  maxBuffer = MAX_GIT_BYTES,
): Promise<string> {
  try {
    const { stdout } = await execute(
      "git",
      ["--no-pager", "--literal-pathspecs", "-C", repo, ...args],
      {
        encoding: "utf8",
        maxBuffer,
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    return stdout;
  } catch {
    throw new Error(`Git ${args[0] ?? "command"} failed or exceeded its limit`);
  }
}

async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (!ref || ref.includes("\0") || ref.startsWith("-"))
    throw new Error("Invalid revision");
  try {
    const sha = (
      await runGit(repo, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Invalid revision");
    return sha;
  } catch {
    throw new Error("Cannot resolve revision to a commit");
  }
}

async function readTree(
  repo: string,
  sha: string,
): Promise<Map<string, TreeEntry>> {
  const output = await runGit(repo, ["ls-tree", "-rlz", sha]);
  const tree = new Map<string, TreeEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\s+(\d+|-)$/.exec(
      record.slice(0, separator),
    );
    if (!match) throw new Error("Invalid Git tree entry");
    tree.set(record.slice(separator + 1), {
      mode: match[1]!,
      oid: match[3]!,
      size: Number(match[4]),
    });
    if (tree.size > 10_000)
      throw new Error("Repository tree exceeds the 10000-entry limit");
  }
  return tree;
}

export class Snapshot {
  readonly repo: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly changes: Change[];
  private readonly trees: Record<Revision, Map<string, TreeEntry>>;
  private readonly policyTree: Map<string, TreeEntry>;

  constructor(
    repo: string,
    baseSha: string,
    mergeBaseSha: string,
    headSha: string,
    changes: Change[],
    trees: Record<Revision, Map<string, TreeEntry>>,
    policyTree: Map<string, TreeEntry>,
  ) {
    this.repo = repo;
    this.baseSha = baseSha;
    this.mergeBaseSha = mergeBaseSha;
    this.headSha = headSha;
    this.changes = changes;
    this.trees = trees;
    this.policyTree = policyTree;
  }

  paths(revision: Revision): string[] {
    return [...this.trees[revision].keys()];
  }

  private async readEntry(
    tree: Map<string, TreeEntry>,
    path: string,
    maxBytes: number,
  ): Promise<string | null> {
    validatePath(path);
    const entry = tree.get(path);
    if (!entry) return null;
    if (entry.mode !== "100644" && entry.mode !== "100755")
      throw new Error("Not a regular file");
    if (!Number.isSafeInteger(entry.size) || entry.size > maxBytes)
      throw new Error("File exceeds the byte limit");
    const content = await runGit(
      this.repo,
      ["cat-file", "blob", entry.oid],
      maxBytes + 1024,
    );
    if (content.includes("\0") || content.includes("\uFFFD"))
      throw new Error("Not a UTF-8 text file");
    return content;
  }

  async readFile(
    revision: Revision,
    path: string,
    maxBytes: number,
  ): Promise<string | null> {
    return this.readEntry(this.trees[revision], path, maxBytes);
  }

  async readPolicy(): Promise<string | null> {
    return this.readEntry(this.policyTree, ".andrew-review.yml", 64 * 1024);
  }

  async patch(change: Change): Promise<string> {
    return runGit(this.repo, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--text",
      "--find-renames",
      "--unified=3",
      this.mergeBaseSha,
      this.headSha,
      "--",
      ...(change.oldPath ? [change.oldPath] : []),
      change.path,
    ]);
  }
}

export async function openSnapshot(
  repo: string,
  base: string,
  head: string,
): Promise<Snapshot> {
  if (!isAbsolute(repo)) throw new Error("Use an absolute repository root");
  const actual = await realpath(repo);
  const discovered = await realpath(
    (await runGit(actual, ["rev-parse", "--show-toplevel"])).trim(),
  );
  if (actual !== discovered)
    throw new Error("The path must be the repository root");
  const baseSha = await resolveCommit(actual, base);
  const headSha = await resolveCommit(actual, head);
  const mergeBases = (
    await runGit(actual, ["merge-base", "--all", baseSha, headSha])
  )
    .trim()
    .split("\n");
  if (mergeBases.length !== 1 || !/^[a-f0-9]{40,64}$/.test(mergeBases[0]!))
    throw new Error("A unique merge-base is required");
  const mergeBaseSha = mergeBases[0]!;
  const [baseTree, headTree, policyTree] = await Promise.all([
    readTree(actual, mergeBaseSha),
    readTree(actual, headSha),
    readTree(actual, baseSha),
  ]);
  const records = (
    await runGit(actual, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      mergeBaseSha,
      headSha,
    ])
  ).split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < records.length - 1;) {
    const status = records[i++]!;
    const first = records[i++]!;
    if (status.startsWith("R") || status.startsWith("C"))
      changes.push({ status: status[0]!, oldPath: first, path: records[i++]! });
    else changes.push({ status, path: first });
  }
  return new Snapshot(
    actual,
    baseSha,
    mergeBaseSha,
    headSha,
    changes,
    { base: baseTree, head: headTree },
    policyTree,
  );
}
