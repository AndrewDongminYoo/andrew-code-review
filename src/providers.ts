import { object, text } from "./config.ts";
import type { ModelSelection } from "./types.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  id: string;
  output: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelTurn {
  text: string;
  calls: ToolCall[];
  usage: Usage;
}

export interface SessionOptions {
  apiKey: string;
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  maxOutputTokens: number;
  maxConversationBytes: number;
  endpoint?: string;
}

export interface Session {
  next(results: ToolResult[], signal: AbortSignal): Promise<ModelTurn>;
}

export class ProviderConnectionError extends Error {}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid provider usage");
  return value;
}

function parseUsage(raw: unknown, provider: ModelSelection["provider"]): Usage {
  const usage = object(raw, "provider usage");
  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadInputTokens:
      provider === "anthropic"
        ? tokenCount(usage.cache_read_input_tokens ?? 0)
        : tokenCount(
            usage.input_tokens_details
              ? (object(usage.input_tokens_details, "usage details")
                  .cached_tokens ?? 0)
              : 0,
          ),
    cacheCreationInputTokens:
      provider === "anthropic"
        ? tokenCount(usage.cache_creation_input_tokens ?? 0)
        : 0,
  };
}

async function request(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal,
      redirect: "error",
    });
  } catch {
    if (signal.aborted) throw new Error("Provider request deadline exceeded");
    throw new ProviderConnectionError("Provider request failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderConnectionError(`Provider HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty provider response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4_194_304)
        throw new Error("Provider response byte limit exceeded");
      chunks.push(chunk.value);
    }
    return object(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      "provider response",
    );
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error(
      "Provider response is invalid, incomplete, or exceeds its byte limit",
    );
  } finally {
    reader.releaseLock();
  }
}

function openaiTurn(response: Record<string, unknown>): ModelTurn {
  if (response.status !== "completed")
    throw new Error("Provider response is incomplete");
  if (!Array.isArray(response.output))
    throw new Error("Invalid provider output");
  const calls: ToolCall[] = [];
  const parts: string[] = [];
  for (const raw of response.output) {
    const item = object(raw, "output item");
    if (item.type === "function_call") {
      let args: unknown;
      try {
        args = JSON.parse(text(item.arguments, "tool arguments", 32_768));
      } catch {
        throw new Error("Invalid provider tool arguments");
      }
      calls.push({
        id: text(item.call_id, "call ID", 256),
        name: text(item.name, "tool name", 128),
        arguments: args,
      });
    } else if (item.type === "message") {
      if (!Array.isArray(item.content))
        throw new Error("Invalid message content");
      for (const rawBlock of item.content) {
        const block = object(rawBlock, "message block");
        if (block.type === "refusal")
          throw new Error("Provider refused the review");
        if (block.type !== "output_text")
          throw new Error("Unsupported provider output block");
        parts.push(text(block.text, "output text", 1_048_576));
      }
    } else if (item.type !== "reasoning")
      throw new Error("Unsupported provider output item");
  }
  return {
    text: parts.join("\n"),
    calls,
    usage: parseUsage(response.usage, "openai"),
  };
}

function anthropicTurn(response: Record<string, unknown>): ModelTurn {
  if (response.stop_reason === "refusal")
    throw new Error("Provider refused the review");
  if (
    response.stop_reason !== "end_turn" &&
    response.stop_reason !== "tool_use"
  )
    throw new Error("Provider response is incomplete");
  if (!Array.isArray(response.content))
    throw new Error("Invalid provider content");
  const calls: ToolCall[] = [];
  const parts: string[] = [];
  for (const raw of response.content) {
    const block = object(raw, "content block");
    if (block.type === "tool_use")
      calls.push({
        id: text(block.id, "call ID", 256),
        name: text(block.name, "tool name", 128),
        arguments: block.input,
      });
    else if (block.type === "text")
      parts.push(text(block.text, "output text", 1_048_576));
    else if (block.type !== "thinking" && block.type !== "redacted_thinking")
      throw new Error("Unsupported provider content block");
  }
  if ((response.stop_reason === "tool_use") !== calls.length > 0)
    throw new Error("Invalid provider tool completion");
  return {
    text: parts.join("\n"),
    calls,
    usage: parseUsage(response.usage, "anthropic"),
  };
}

export function createSession(
  selection: ModelSelection,
  options: SessionOptions,
): Session {
  if (!options.apiKey.trim())
    throw new Error(`Missing ${selection.provider} API key`);
  let endpoint =
    selection.provider === "openai"
      ? "https://api.openai.com/v1"
      : "https://api.anthropic.com/v1";
  if (options.endpoint !== undefined) {
    const candidate = new URL(options.endpoint);
    if (
      candidate.protocol !== "http:" ||
      candidate.hostname !== "127.0.0.1" ||
      candidate.username ||
      candidate.password ||
      candidate.search ||
      candidate.hash ||
      candidate.pathname !== "/"
    )
      throw new Error("Custom endpoints must be local protocol fixtures");
    endpoint = candidate.origin;
  }
  const history: unknown[] = [{ role: "user", content: options.prompt }];
  let pending: string[] = [];
  let finished = false;
  return {
    async next(results, signal) {
      if (finished) throw new Error("Provider session already completed");
      if (
        results.length !== pending.length ||
        new Set(results.map((result) => result.id)).size !== results.length ||
        results.some((result) => !pending.includes(result.id))
      )
        throw new Error("Tool results do not match pending calls");
      if (results.length) {
        if (selection.provider === "openai")
          history.push(
            ...results.map((result) => ({
              type: "function_call_output",
              call_id: result.id,
              output: result.output,
            })),
          );
        else
          history.push({
            role: "user",
            content: results.map((result) => ({
              type: "tool_result",
              tool_use_id: result.id,
              content: result.output,
            })),
          });
      }
      const body =
        selection.provider === "openai"
          ? {
              model: selection.model,
              reasoning: { effort: selection.effort },
              instructions: options.system,
              input: history,
              tools: options.tools.map((tool) => ({
                type: "function",
                ...tool,
                strict: true,
              })),
              max_output_tokens: options.maxOutputTokens,
              store: false,
              include: ["reasoning.encrypted_content"],
            }
          : {
              model: selection.model,
              output_config: { effort: selection.effort },
              thinking: { type: "adaptive" },
              system: options.system,
              messages: history,
              tools: options.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
              max_tokens: options.maxOutputTokens,
            };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > options.maxConversationBytes)
        throw new Error("Conversation byte limit exceeded");
      const response = await request(
        `${endpoint}/${selection.provider === "openai" ? "responses" : "messages"}`,
        selection.provider === "openai"
          ? { authorization: `Bearer ${options.apiKey}` }
          : { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
        serialized,
        signal,
      );
      const turn =
        selection.provider === "openai"
          ? openaiTurn(response)
          : anthropicTurn(response);
      if (new Set(turn.calls.map((call) => call.id)).size !== turn.calls.length)
        throw new Error("Duplicate provider call IDs");
      if (selection.provider === "openai")
        history.push(...(response.output as unknown[]));
      else history.push({ role: "assistant", content: response.content });
      pending = turn.calls.map((call) => call.id);
      finished = pending.length === 0;
      if (finished && !turn.text.trim())
        throw new Error("Provider returned no final result");
      return turn;
    },
  };
}
