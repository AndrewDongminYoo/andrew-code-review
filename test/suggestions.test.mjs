import assert from "node:assert/strict";
import test from "node:test";
import { collectContext } from "../src/context.ts";
import { defaultConfig } from "../src/config.ts";
import { openSnapshot } from "../src/repository.ts";
import { prepareSuggestion, applyReplacement } from "../src/suggestions.ts";
import { baseFiles, changedCount, fixture } from "./helpers.mjs";

async function setup(t) {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  const config = defaultConfig();
  const context = await collectContext(snapshot, config);
  const candidate = {
    location: {
      path: "src/count.ts",
      revision: "head",
      startLine: 2,
      endLine: 2,
    },
    suggestion: {
      startLine: 2,
      endLine: 2,
      original: "  return Number(raw) || null;",
      replacement: "  return Number(raw);",
    },
  };
  return { snapshot, config, context, candidate };
}

test("a verified suggestion renders the exact replacement and preserves surrounding source", async (t) => {
  const { snapshot, config, context, candidate } = await setup(t);
  const result = await prepareSuggestion(
    snapshot,
    context,
    config,
    candidate,
    true,
    [],
  );
  assert.equal(
    result.suggestion.markdown,
    "```suggestion\n  return Number(raw);\n```",
  );
  assert.deepEqual(result.suggestion.anchor, {
    path: "src/count.ts",
    startLine: 2,
    endLine: 2,
    side: "RIGHT",
    headSha: snapshot.headSha,
  });
  assert.equal(
    applyReplacement(changedCount, result.suggestion),
    "export function count(raw: string): number | null {\n  return Number(raw);\n}\n",
  );
});

test("multiline and deletion suggestions replace only their selected lines", () => {
  const source = "before\nold one\nold two\nafter\n";
  assert.equal(
    applyReplacement(source, {
      startLine: 2,
      endLine: 3,
      original: "old one\nold two",
      replacement: "new one\nnew two\nnew three",
    }),
    "before\nnew one\nnew two\nnew three\nafter\n",
  );
  assert.equal(
    applyReplacement(source, {
      startLine: 2,
      endLine: 3,
      original: "old one\nold two",
      replacement: "",
    }),
    "before\nafter\n",
  );
  assert.throws(
    () =>
      applyReplacement(source, {
        startLine: 2,
        endLine: 3,
        original: "stale",
        replacement: "new",
      }),
    /original/i,
  );
});

for (const [label, mutate, approved, occupied, reason] of [
  ["unverified", () => {}, false, [], /verif/i],
  [
    "unchanged hunk context",
    (candidate) => {
      candidate.location.startLine = 3;
      candidate.location.endLine = 3;
      candidate.suggestion.startLine = 3;
      candidate.suggestion.endLine = 3;
      candidate.suggestion.original = "}";
      candidate.suggestion.replacement = "};";
    },
    true,
    [],
    /changed-line/i,
  ],
  [
    "stale original",
    (candidate) => {
      candidate.suggestion.original = "different old content";
    },
    true,
    [],
    /original/i,
  ],
  [
    "unchanged replacement",
    (candidate) => {
      candidate.suggestion.replacement = candidate.suggestion.original;
    },
    true,
    [],
    /unchanged/i,
  ],
  [
    "Markdown fence",
    (candidate) => {
      candidate.suggestion.replacement = "```\nmisleading text";
    },
    true,
    [],
    /fence/i,
  ],
  [
    "overlapping range",
    () => {},
    true,
    [{ path: "src/count.ts", startLine: 2, endLine: 3 }],
    /overlap/i,
  ],
  [
    "base-side location",
    (candidate) => {
      candidate.location.revision = "base";
    },
    true,
    [],
    /head/i,
  ],
  [
    "outside the diff",
    (candidate) => {
      candidate.suggestion.startLine = 99;
      candidate.suggestion.endLine = 99;
    },
    true,
    [],
    /range/i,
  ],
])
  test(`${label} suggestion is withheld without throwing away the finding`, async (t) => {
    const { snapshot, config, context, candidate } = await setup(t);
    mutate(candidate);
    const result = await prepareSuggestion(
      snapshot,
      context,
      config,
      candidate,
      approved,
      occupied,
    );
    assert.equal(result.suggestion, undefined);
    assert.match(result.reason, reason);
  });
