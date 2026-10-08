import assert from "node:assert/strict";
import test from "node:test";
import { review } from "../src/review.ts";
import { defaultConfig } from "../src/config.ts";
import { openSnapshot } from "../src/repository.ts";
import { baseFiles, changedCount, fixture } from "./helpers.mjs";
import { httpFixture, openaiResponse } from "./http.mjs";

export const finding = {
  title: "Keep zero as a valid numeric result",
  severity: "P2",
  trigger: 'A consumer calls count("0").toFixed(0).',
  impact: "The new null result throws in the existing consumer.",
  location: {
    path: "src/count.ts",
    revision: "head",
    startLine: 2,
    endLine: 2,
  },
  evidence: [
    {
      path: "src/count.ts",
      revision: "head",
      startLine: 2,
      endLine: 2,
      quote: "  return Number(raw) || null;",
    },
    {
      path: "src/view.ts",
      revision: "head",
      startLine: 2,
      endLine: 2,
      quote: "export const label = (raw: string) => count(raw).toFixed(0);",
    },
  ],
  suggestion: {
    startLine: 2,
    endLine: 2,
    original: "  return Number(raw) || null;",
    replacement: "  return Number(raw);",
  },
};

async function setup(t, policy = defaultConfig()) {
  const f = await fixture(t, baseFiles);
  const head = await f.commit({ "src/count.ts": changedCount });
  const snapshot = await openSnapshot(f.repo, f.base, head);
  return { snapshot, config: policy };
}

function reviewReply(findings = [finding]) {
  return JSON.stringify({
    summary: "The count function now returns null for zero.",
    findings,
  });
}

function verifyReply(disposition = "confirmed", extra = {}) {
  return JSON.stringify({
    verdicts: [
      {
        id: "F1",
        disposition,
        explanation: "The existing view calls toFixed on the returned value.",
        evidence: finding.evidence,
        suggestionApproved: disposition === "confirmed",
        ...extra,
      },
    ],
  });
}

test("review verifies exact evidence in a separate session and emits an actionable suggestion", async (t) => {
  const { snapshot, config } = await setup(t);
  config.summary.instructions = "Explain affected consumers.";
  const api = await httpFixture(t, (_request, round) => ({
    body: openaiResponse(round === 1 ? reviewReply() : verifyReply()),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.headSha, snapshot.headSha);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].verification, "source_supported");
  assert.equal(
    result.findings[0].suggestion.markdown,
    "```suggestion\n  return Number(raw);\n```",
  );
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.requests, 2);
  assert.ok(
    api.requests[0].body.instructions.includes("Explain affected consumers."),
  );
  assert.equal(
    api.requests[1].body.input.length,
    1,
    "verification must use a fresh conversation",
  );
  assert.match(api.requests[1].body.instructions, /verif/i);
});

test("an unchanged location in an edited file cannot become a finding", async (t) => {
  const { snapshot, config } = await setup(t);
  const candidate = {
    ...finding,
    location: { ...finding.location, startLine: 3, endLine: 3 },
  };
  const api = await httpFixture(t, (_request, round) => ({
    body: openaiResponse(
      round === 1 ? reviewReply([candidate]) : verifyReply(),
    ),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.errors.join(" "), /changed line/i);
  assert.equal(api.requests.length, 1);
});

for (const disposition of ["rejected", "uncertain", "confirmed"])
  test(`contradictory suggestion approval is rejected for ${disposition}`, async (t) => {
    const { snapshot, config } = await setup(t);
    const candidate = { ...finding };
    if (disposition === "confirmed") delete candidate.suggestion;
    const api = await httpFixture(t, (_request, round) => ({
      body: openaiResponse(
        round === 1
          ? reviewReply([candidate])
          : verifyReply(disposition, { suggestionApproved: true }),
      ),
    }));
    const result = await review(snapshot, config, {
      keys: { openai: "fixture-key" },
      endpoints: { openai: api.endpoint },
    });
    assert.equal(result.status, "incomplete");
    assert.match(result.errors.join(" "), /suggestion approval/i);
  });

test("provider startup failure is failed while verifier failure retains incomplete candidates", async (t) => {
  const { snapshot, config } = await setup(t);
  for (const failAt of [1, 2]) {
    const api = await httpFixture(t, (_request, round) =>
      round === failAt
        ? { status: 503, body: {} }
        : { body: openaiResponse(reviewReply()) },
    );
    const result = await review(snapshot, config, {
      keys: { openai: "fixture-key" },
      endpoints: { openai: api.endpoint },
    });
    assert.equal(result.status, failAt === 1 ? "failed" : "incomplete");
    assert.equal(result.candidates.length, failAt === 1 ? 0 : 1);
    assert.match(result.errors.join(" "), /503/);
  }
});

test("a reviewer can read unchanged source through a bounded tool round trip", async (t) => {
  const { snapshot, config } = await setup(t);
  const api = await httpFixture(t, (_request, round) => ({
    body: openaiResponse(
      round === 1
        ? [
            {
              type: "function_call",
              call_id: "read_consumer",
              name: "read_file",
              arguments: JSON.stringify({
                revision: "head",
                path: "src/view.ts",
                startLine: 1,
                endLine: 2,
              }),
            },
          ]
        : round === 2
          ? reviewReply()
          : verifyReply(),
    ),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.usage.toolCalls, 1);
  const output = JSON.parse(api.requests[1].body.input.at(-1).output);
  assert.equal(output.path, "src/view.ts");
  assert.equal(
    output.lines[1].text,
    "export const label = (raw: string) => count(raw).toFixed(0);",
  );
});

test("fabricated quotations cannot become verified findings", async (t) => {
  const { snapshot, config } = await setup(t);
  const invalid = structuredClone(finding);
  invalid.evidence[0].quote = "fabricated code";
  const api = await httpFixture(t, () => ({
    body: openaiResponse(reviewReply([invalid])),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.findings.length, 0);
  assert.match(result.errors.join(" "), /evidence|quotation/i);
  assert.equal(api.requests.length, 1);
});

for (const disposition of ["rejected", "uncertain"])
  test(`verifier ${disposition} is recorded without publishing the candidate`, async (t) => {
    const { snapshot, config } = await setup(t);
    const api = await httpFixture(t, (_request, round) => ({
      body: openaiResponse(
        round === 1
          ? reviewReply()
          : verifyReply(disposition, { suggestionApproved: false }),
      ),
    }));
    const result = await review(snapshot, config, {
      keys: { openai: "fixture-key" },
      endpoints: { openai: api.endpoint },
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.dispositions[0].disposition, disposition);
    assert.equal(
      result.status,
      disposition === "uncertain" ? "incomplete" : "completed",
    );
  });

test("missing verification verdicts do not silently discard candidates", async (t) => {
  const { snapshot, config } = await setup(t);
  const api = await httpFixture(t, (_request, round) => ({
    body: openaiResponse(round === 1 ? reviewReply() : '{"verdicts":[]}'),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.errors.join(" "), /verdict/i);
});

test("a defect can be confirmed while its proposed fix is withheld", async (t) => {
  const { snapshot, config } = await setup(t);
  const api = await httpFixture(t, (_request, round) => ({
    body: openaiResponse(
      round === 1
        ? reviewReply()
        : verifyReply("confirmed", { suggestionApproved: false }),
    ),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].suggestion, undefined);
  assert.match(result.findings[0].suggestionOmittedReason, /verif/i);
});

test("request exhaustion preserves the candidate as unverified and reports incomplete", async (t) => {
  const { snapshot, config } = await setup(t);
  config.limits.maxRequests = 1;
  const api = await httpFixture(t, () => ({
    body: openaiResponse(reviewReply()),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.findings.length, 0);
  assert.equal(result.candidates.length, 1);
  assert.match(result.errors.join(" "), /budget|limit/i);
  assert.equal(api.requests.length, 1);
});

test("tool attempts outside the repository cannot produce a clean result", async (t) => {
  const { snapshot, config } = await setup(t);
  const api = await httpFixture(t, () => ({
    body: openaiResponse([
      {
        type: "function_call",
        call_id: "escape",
        name: "read_file",
        arguments:
          '{"revision":"head","path":"../secret","startLine":1,"endLine":2}',
      },
    ]),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.errors.join(" "), /path/i);
  assert.equal(api.requests.length, 1);
});

test("an omitted changed file prevents a clean result even when the model finds nothing", async (t) => {
  const { snapshot, config } = await setup(t);
  config.limits.maxFileBytes = 20;
  const api = await httpFixture(t, () => ({
    body: openaiResponse(reviewReply([])),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.coverage.complete, false);
});

test("missing verifier credentials fail before spending reviewer requests", async (t) => {
  const { snapshot, config } = await setup(t);
  config.models.verifier = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
  };
  const api = await httpFixture(t, () => ({
    body: openaiResponse(reviewReply()),
  }));
  const result = await review(snapshot, config, {
    keys: { openai: "fixture-key" },
    endpoints: { openai: api.endpoint },
  });
  assert.equal(result.status, "failed");
  assert.match(result.errors.join(" "), /anthropic.*key/i);
  assert.equal(api.requests.length, 0);
});

for (const tool of ["read_file", "search"])
  test(`credential exclusions apply to the ${tool} model tool`, async (t) => {
    const secret = "FAKE_TEST_CREDENTIAL_DO_NOT_SEND";
    const f = await fixture(t, {
      ...baseFiles,
      "config/credentials.json": JSON.stringify({ password: secret }),
    });
    const head = await f.commit({ "src/count.ts": changedCount });
    const snapshot = await openSnapshot(f.repo, f.base, head);
    const api = await httpFixture(t, (_request, round) => ({
      body: openaiResponse(
        round === 1
          ? [
              {
                type: "function_call",
                call_id: "credentials",
                name: tool,
                arguments: JSON.stringify(
                  tool === "search"
                    ? { revision: "head", query: "password" }
                    : {
                        revision: "head",
                        path: "config/credentials.json",
                        startLine: 1,
                        endLine: 1,
                      },
                ),
              },
            ]
          : reviewReply([]),
      ),
    }));
    const result = await review(snapshot, defaultConfig(), {
      keys: { openai: "fixture-key" },
      endpoints: { openai: api.endpoint },
    });
    assert.equal(JSON.stringify(api.requests).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    if (tool === "read_file") {
      assert.equal(result.status, "incomplete");
      assert.match(result.errors.join(" "), /excluded/i);
    } else {
      assert.equal(result.status, "completed");
      assert.equal(api.requests.length, 2);
      assert.deepEqual(
        JSON.parse(api.requests[1].body.input.at(-1).output).matches,
        [],
      );
    }
  });
