import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { baseFiles, changedCount, fixture } from "./helpers.mjs";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function cli(args) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

test("help is available without a repository or API credentials", () => {
  const result = cli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /inspect/);
  assert.match(result.stdout, /review/);
});

test("inspect emits frozen revisions and affected code without credentials", async (t) => {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const result = cli([
    "inspect",
    "--repo",
    f.repo,
    "--base",
    f.base,
    "--head",
    head,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "inspected");
  assert.equal(output.headSha, head);
  assert.equal(output.coverage.complete, true);
  assert.ok(output.relatedFiles.some((file) => file.path === "src/view.ts"));
});

test("review without a selected provider key returns a failed JSON result", async (t) => {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const result = cli([
    "review",
    "--repo",
    f.repo,
    "--base",
    f.base,
    "--head",
    head,
  ]);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "failed");
  assert.equal(output.headSha, head);
  assert.match(output.errors.join(" "), /API key/i);
  assert.equal(output.usage.requests, 0);
});

test("an empty review completes without an API request", async (t) => {
  const f = await fixture(t, baseFiles);
  const result = cli([
    "review",
    "--repo",
    f.repo,
    "--base",
    f.base,
    "--head",
    f.base,
  ]);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.usage.requests, 0);
});

test("unknown commands and missing revisions fail with machine-readable errors", () => {
  for (const args of [
    ["publish"],
    ["inspect"],
    ["inspect", "--repo", "/tmp", "--base", "main", "--unknown"],
  ]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).status, "failed");
  }
});
