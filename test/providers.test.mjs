import assert from "node:assert/strict";
import test from "node:test";
import { createSession } from "../src/providers.ts";
import { anthropicResponse, httpFixture, openaiResponse } from "./http.mjs";

const selection = {
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "medium",
};
const tools = [
  {
    name: "read_file",
    description: "Read frozen source.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];
const options = {
  apiKey: "fixture-key",
  system: "Review only.",
  prompt: "Inspect the change.",
  tools,
  maxOutputTokens: 2048,
  maxConversationBytes: 65536,
};

test("OpenAI uses Responses and preserves reasoning across tool calls", async (t) => {
  const reasoning = {
    id: "rs_fixture",
    type: "reasoning",
    summary: [],
    encrypted_content: "fixture-encrypted-reasoning",
  };
  const tool = {
    type: "function_call",
    id: "fc_fixture",
    call_id: "call_read",
    name: "read_file",
    arguments: '{"path":"src/count.ts"}',
  };
  const api = await httpFixture(t, (_request, round) => ({
    body: openaiResponse(round === 1 ? [reasoning, tool] : '{"findings":[]}'),
  }));
  const session = createSession(selection, {
    ...options,
    endpoint: api.endpoint,
  });
  const first = await session.next([], AbortSignal.timeout(2000));
  assert.deepEqual(first.calls, [
    { id: "call_read", name: "read_file", arguments: { path: "src/count.ts" } },
  ]);
  const second = await session.next(
    [{ id: "call_read", output: "source content" }],
    AbortSignal.timeout(2000),
  );
  assert.equal(second.text, '{"findings":[]}');
  assert.equal(second.usage.inputTokens, 100);
  assert.equal(api.requests[0].url, "/responses");
  assert.equal(api.requests[0].headers.authorization, "Bearer fixture-key");
  assert.deepEqual(api.requests[0].body.reasoning, { effort: "medium" });
  assert.equal(api.requests[0].body.store, false);
  assert.deepEqual(api.requests[0].body.include, [
    "reasoning.encrypted_content",
  ]);
  assert.equal(api.requests[0].body.tools[0].type, "function");
  assert.ok(
    api.requests[1].body.input.some(
      (item) => item.encrypted_content === reasoning.encrypted_content,
    ),
  );
  assert.deepEqual(api.requests[1].body.input.at(-1), {
    type: "function_call_output",
    call_id: "call_read",
    output: "source content",
  });
});

test("Anthropic preserves signed thinking and returns tool_result in a user message", async (t) => {
  const thinking = {
    type: "thinking",
    thinking: "fixture summary",
    signature: "fixture-signature",
  };
  const tool = {
    type: "tool_use",
    id: "tool_read",
    name: "read_file",
    input: { path: "src/count.ts" },
  };
  const api = await httpFixture(t, (_request, round) => ({
    body:
      round === 1
        ? anthropicResponse([thinking, tool], { stop_reason: "tool_use" })
        : anthropicResponse('{"findings":[]}'),
  }));
  const session = createSession(
    { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" },
    { ...options, endpoint: api.endpoint },
  );
  await session.next([], AbortSignal.timeout(2000));
  const second = await session.next(
    [{ id: "tool_read", output: "source content" }],
    AbortSignal.timeout(2000),
  );
  assert.equal(second.text, '{"findings":[]}');
  assert.equal(api.requests[0].url, "/messages");
  assert.equal(api.requests[0].headers["x-api-key"], "fixture-key");
  assert.equal(api.requests[0].headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(api.requests[0].body.output_config, { effort: "high" });
  assert.deepEqual(api.requests[0].body.thinking, { type: "adaptive" });
  assert.equal(api.requests[0].body.tool_choice, undefined);
  assert.deepEqual(api.requests[1].body.messages[1].content, [thinking, tool]);
  assert.deepEqual(api.requests[1].body.messages[2], {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_read",
        content: "source content",
      },
    ],
  });
});

for (const [label, body, expected] of [
  [
    "incomplete output",
    openaiResponse("{}", {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }),
    /incomplete/i,
  ],
  [
    "refusal",
    openaiResponse([
      { type: "message", content: [{ type: "refusal", refusal: "declined" }] },
    ]),
    /refus/i,
  ],
  ["missing usage", openaiResponse("{}", { usage: null }), /usage/i],
])
  test(`OpenAI ${label} cannot become a completed turn`, async (t) => {
    const api = await httpFixture(t, () => ({ body }));
    const session = createSession(selection, {
      ...options,
      endpoint: api.endpoint,
    });
    await assert.rejects(session.next([], AbortSignal.timeout(2000)), expected);
  });

test("HTTP failures redact response bodies and are not retried", async (t) => {
  const api = await httpFixture(t, () => ({
    status: 429,
    body: { error: "sensitive echoed input" },
  }));
  const session = createSession(selection, {
    ...options,
    endpoint: api.endpoint,
  });
  await assert.rejects(
    session.next([], AbortSignal.timeout(2000)),
    (error) => /429/.test(error.message) && !/sensitive/.test(error.message),
  );
  assert.equal(api.requests.length, 1);
});

test("conversation limits stop a request before credentials are transmitted", async (t) => {
  const api = await httpFixture(t, () => ({ body: openaiResponse("{}") }));
  const session = createSession(selection, {
    ...options,
    endpoint: api.endpoint,
    maxConversationBytes: 10,
  });
  await assert.rejects(
    session.next([], AbortSignal.timeout(2000)),
    /conversation.*limit/i,
  );
  assert.equal(api.requests.length, 0);
});

test("provider redirects are rejected without following the new destination", async (t) => {
  const target = await httpFixture(t, () => ({ body: openaiResponse("{}") }));
  const api = await httpFixture(t, () => ({
    status: 307,
    headers: { location: `${target.endpoint}/capture` },
    body: {},
  }));
  const session = createSession(selection, {
    ...options,
    endpoint: api.endpoint,
  });
  await assert.rejects(session.next([], AbortSignal.timeout(2000)));
  assert.equal(target.requests.length, 0);
});

test("custom endpoints are restricted to local protocol fixtures", () => {
  assert.throws(
    () =>
      createSession(selection, {
        ...options,
        endpoint: "https://untrusted.example",
      }),
    /endpoint/i,
  );
});
