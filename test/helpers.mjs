import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trimEnd();
}

export async function fixture(t, initial = {}) {
  const repo = await realpath(
    await mkdtemp(join(tmpdir(), "andrew-review-test-")),
  );
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Review Fixture");
  git(repo, "config", "user.email", "review-fixture@example.invalid");
  async function write(files) {
    for (const [name, content] of Object.entries(files)) {
      const target = join(repo, name);
      await mkdir(dirname(target), { recursive: true });
      if (content === null) await rm(target);
      else await writeFile(target, content);
    }
  }
  async function commit(files, message = "fixture") {
    await write(files);
    git(repo, "add", "--all");
    git(
      repo,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    );
    return git(repo, "rev-parse", "HEAD");
  }
  const base = await commit(initial, "base fixture");
  return { repo, base, write, commit };
}

export const baseFiles = {
  "src/count.ts":
    "export function count(raw: string): number {\n  return Number(raw);\n}\n",
  "src/view.ts":
    'import { count } from "./count";\nexport const label = (raw: string) => count(raw).toFixed(0);\n',
  "README.md": "# Fixture\n",
};

export const changedCount =
  "export function count(raw: string): number | null {\n  return Number(raw) || null;\n}\n";
