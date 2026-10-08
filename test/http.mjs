import { createServer } from "node:http";
import assert from "node:assert/strict";

export async function httpFixture(t, handler) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const record = {
        url: request.url,
        headers: request.headers,
        body: JSON.parse(raw),
      };
      requests.push(record);
      const result = await handler(record, requests.length);
      response.writeHead(result.status ?? 200, {
        "content-type": "application/json",
        ...result.headers,
      });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      errors.push(error);
      response.writeHead(500);
      response.end("fixture handler failed");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, [], "HTTP fixture handlers must not fail");
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, requests };
}

export function openaiResponse(output, overrides = {}) {
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    model: "gpt-6.1-sol",
    status: "completed",
    error: null,
    incomplete_details: null,
    output:
      typeof output === "string"
        ? [
            {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: output, annotations: [] }],
            },
          ]
        : output,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
    ...overrides,
  };
}

export function anthropicResponse(content, overrides = {}) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content:
      typeof content === "string" ? [{ type: "text", text: content }] : content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}
