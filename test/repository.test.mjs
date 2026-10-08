import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openSnapshot } from "../src/repository.ts";
import { collectContext } from "../src/context.ts";
import { defaultConfig } from "../src/config.ts";
import { baseFiles, changedCount, fixture, git } from "./helpers.mjs";

test("snapshot reads frozen objects and finds an unchanged caller", async (t) => {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  await f.write({ "src/count.ts": "uncommitted and unrelated\n" });
  assert.equal(
    await snapshot.readFile("head", "src/count.ts", 4096),
    changedCount,
  );
  const context = await collectContext(snapshot, defaultConfig());
  assert.equal(context.headSha, head);
  assert.equal(context.mergeBaseSha, f.base);
  assert.equal(context.changedFiles[0].path, "src/count.ts");
  assert.ok(
    context.relatedFiles.some(
      (file) => file.path === "src/view.ts" && file.relationship === "textual",
    ),
  );
  assert.equal(context.risk.level, "small");
});

test("mutable binary attributes cannot suppress frozen text changes", async (t) => {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  await f.write({ ".gitattributes": "*.ts -diff\n" });
  const context = await collectContext(snapshot, defaultConfig());
  assert.ok(context.changedFiles[0].hunks.length > 0);
  assert.ok(context.changedFiles[0].additions > 0);
  assert.ok(context.relatedFiles.some((file) => file.path === "src/view.ts"));
});

test("missing text hunks are explicit omissions", async (t) => {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  snapshot.patch = async () => "Binary files differ\n";
  const context = await collectContext(snapshot, defaultConfig());
  assert.equal(context.coverage.complete, false);
  assert.match(context.coverage.omissions[0].reason, /hunk/i);
});

test("credential data files are excluded from collected source", async (t) => {
  const f = await fixture(t, baseFiles);
  const secret = "FAKE_TEST_CREDENTIAL_DO_NOT_SEND";
  const head = await f.commit({
    "config/credentials.json": JSON.stringify({ password: secret }),
    "secrets.yaml": `password: ${secret}\n`,
    "token.txt": secret,
  });
  const context = await collectContext(
    await openSnapshot(f.repo, f.base, head),
    defaultConfig(),
  );
  assert.equal(context.changedFiles.length, 0);
  assert.equal(context.coverage.omissions.length, 3);
  assert.equal(JSON.stringify(context).includes(secret), false);
});

test("identifier truncation makes related-source coverage incomplete", async (t) => {
  const f = await fixture(t, {
    "consumer.ts": "export const result = lastIdentifier;\n",
  });
  const head = await f.commit({
    "large.ts":
      Array.from(
        { length: 101 },
        (_, index) => `export const identifier${index} = ${index};`,
      ).join("\n") + "\nexport const lastIdentifier = 1;\n",
  });
  const context = await collectContext(
    await openSnapshot(f.repo, f.base, head),
    defaultConfig(),
  );
  assert.equal(context.coverage.complete, false);
  assert.ok(
    context.coverage.omissions.some((item) => /identifier/i.test(item.reason)),
  );
});

test("diff uses merge-base while preserving the latest base policy revision", async (t) => {
  const f = await fixture(t, baseFiles);
  git(f.repo, "switch", "-q", "-c", "feature");
  const head = await f.commit({ "src/count.ts": changedCount });
  git(f.repo, "switch", "-q", "main");
  const baseTip = await f.commit({ "base-only.txt": "not in feature\n" });
  const snapshot = await openSnapshot(f.repo, "main", head);
  assert.equal(snapshot.baseSha, baseTip);
  assert.equal(snapshot.mergeBaseSha, f.base);
  assert.deepEqual(
    snapshot.changes.map((file) => file.path),
    ["src/count.ts"],
  );
});

test("repository root must be exact, not a directory inside another repository", async (t) => {
  const f = await fixture(t, baseFiles);
  const child = join(f.repo, "nested");
  await mkdir(child);
  await assert.rejects(openSnapshot(child, f.base, "HEAD"), /repository root/i);
  await assert.rejects(openSnapshot(f.repo, "--help", "HEAD"), /revision/i);
});

test("paths with spaces and tabs survive Git parsing; deleted blobs remain readable", async (t) => {
  const strange = "src/with space\tname.ts";
  const f = await fixture(t, { [strange]: "export const oldValue = 1;\n" });
  const head = await f.commit({
    [strange]: null,
    "new.ts": "export const nextValue = 2;\n",
  });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  assert.equal(
    await snapshot.readFile("base", strange, 1024),
    "export const oldValue = 1;\n",
  );
  assert.equal(await snapshot.readFile("head", strange, 1024), null);
  assert.ok(
    snapshot.changes.some(
      (file) => file.path === strange && file.status === "D",
    ),
  );
  await assert.rejects(snapshot.readFile("head", "../outside", 1024), /path/i);
});

test("symlinks cannot expose files outside the snapshot", async (t) => {
  const f = await fixture(t, baseFiles);
  await symlink("/etc/passwd", join(f.repo, "linked.ts"));
  const head = await f.commit({});
  const snapshot = await openSnapshot(f.repo, f.base, head);
  await assert.rejects(
    snapshot.readFile("head", "linked.ts", 4096),
    /regular file/i,
  );
  const context = await collectContext(snapshot, defaultConfig());
  assert.equal(context.coverage.complete, false);
  assert.ok(
    context.coverage.omissions.some((item) => item.path === "linked.ts"),
  );
});

test("a tiny authorization change raises review risk", async (t) => {
  const f = await fixture(t, {
    "src/auth/access.ts": "export const allowed = false;\n",
  });
  const head = await f.commit({
    "src/auth/access.ts": "export const allowed = true;\n",
  });
  const context = await collectContext(
    await openSnapshot(f.repo, f.base, head),
    defaultConfig(),
  );
  assert.equal(context.risk.level, "high");
  assert.match(context.risk.reasons.join(" "), /sensitive/i);
});

test("file and context limits produce explicit omissions", async (t) => {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const config = defaultConfig();
  config.limits.maxFileBytes = 20;
  const context = await collectContext(
    await openSnapshot(f.repo, f.base, head),
    config,
  );
  assert.equal(context.coverage.complete, false);
  assert.ok(
    context.coverage.omissions.some((item) => item.path === "src/count.ts"),
  );
});

test("renamed files retain the old path and binary files are not reported as reviewed", async (t) => {
  const f = await fixture(t, {
    "old.ts": baseFiles["src/count.ts"],
    "asset.bin": Buffer.from([0, 1, 2]),
  });
  const head = await f.commit({
    "old.ts": null,
    "new.ts": baseFiles["src/count.ts"],
    "asset.bin": Buffer.from([0, 4, 2]),
  });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  const renamed = snapshot.changes.find((file) => file.path === "new.ts");
  assert.equal(renamed.oldPath, "old.ts");
  const context = await collectContext(snapshot, defaultConfig());
  assert.equal(context.coverage.complete, false);
  assert.ok(
    context.coverage.omissions.some((item) => item.path === "asset.bin"),
  );
});
