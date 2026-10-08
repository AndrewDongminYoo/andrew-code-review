import { object, text } from "./config.ts";
import { isExcluded, sourceLines } from "./context.ts";
import { location, sourceAt } from "./findings.ts";
import type { Snapshot } from "./repository.ts";
import { createSession } from "./providers.ts";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  Usage,
} from "./providers.ts";
import type { Config, ModelSelection, Provider } from "./types.ts";

export interface Access {
  keys: Partial<Record<Provider, string>>;
  endpoints?: Partial<Record<Provider, string>>;
}

export interface Budget {
  deadline: number;
  requests: number;
  toolCalls: number;
  usage: Usage;
  usageComplete: boolean;
  omissions: string[];
}

export function createBudget(config: Config): Budget {
  return {
    deadline: Date.now() + config.limits.timeoutSeconds * 1000,
    requests: 0,
    toolCalls: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    usageComplete: true,
    omissions: [],
  };
}

const tools: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read numbered source lines from frozen Git objects. The base revision is the merge-base. No working-tree files or commands are available.",
    parameters: {
      type: "object",
      properties: {
        revision: { type: "string", enum: ["base", "head"] },
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["revision", "path", "startLine", "endLine"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Search frozen text files for a literal string. Results include coverage limits. This is a textual search, not a semantic reference index.",
    parameters: {
      type: "object",
      properties: {
        revision: { type: "string", enum: ["base", "head"] },
        query: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["revision", "query"],
      additionalProperties: false,
    },
  },
];

function checkDeadline(budget: Budget): void {
  if (Date.now() >= budget.deadline)
    throw new Error("Review wall-time budget exhausted");
}

async function useTool(
  call: ToolCall,
  snapshot: Snapshot,
  config: Config,
  budget: Budget,
): Promise<string> {
  checkDeadline(budget);
  if (budget.toolCalls >= config.limits.maxToolCalls)
    throw new Error("Tool-call budget exhausted");
  budget.toolCalls++;
  const input = object(call.arguments, "tool arguments");
  if (call.name === "read_file") {
    if (
      Object.keys(input).some(
        (key) => !["path", "revision", "startLine", "endLine"].includes(key),
      )
    )
      throw new Error("Unknown read_file argument");
    const where = location(input);
    const content = await sourceAt(snapshot, config, where);
    return JSON.stringify({
      ...where,
      lines: content.split("\n").map((line, index) => ({
        number: where.startLine + index,
        text: line,
      })),
    });
  }
  if (call.name !== "search")
    throw new Error("Unknown or unauthorized model tool");
  if (Object.keys(input).some((key) => !["revision", "query"].includes(key)))
    throw new Error("Unknown search argument");
  if (input.revision !== "head" && input.revision !== "base")
    throw new Error("Invalid search revision");
  const query = text(input.query, "literal query", 200);
  const matches: { path: string; line: number; text: string }[] = [];
  const omissions: string[] = [];
  let count = 0;
  let bytes = 0;
  for (const path of snapshot.paths(input.revision)) {
    checkDeadline(budget);
    if (isExcluded(path, config)) continue;
    if (
      count >= config.limits.maxFiles ||
      bytes >= config.limits.maxScanBytes ||
      matches.length >= 30
    ) {
      omissions.push(
        "Search limit reached before all remaining files were scanned",
      );
      break;
    }
    count++;
    let content: string | null;
    try {
      content = await snapshot.readFile(
        input.revision,
        path,
        config.limits.maxFileBytes,
      );
    } catch {
      omissions.push(`Unreadable search candidate: ${path}`);
      continue;
    }
    if (content === null) continue;
    bytes += Buffer.byteLength(content);
    if (bytes > config.limits.maxScanBytes) {
      omissions.push("Search byte limit reached");
      break;
    }
    const lines = sourceLines(content);
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]!.includes(query)) continue;
      if (matches.length >= 30) {
        omissions.push("Search match limit reached");
        break;
      }
      matches.push({
        path,
        line: index + 1,
        text: lines[index]!.slice(0, 1000),
      });
      if (lines[index]!.length > 1000)
        omissions.push(`Search line truncated: ${path}:${index + 1}`);
    }
  }
  budget.omissions.push(...omissions);
  return JSON.stringify({
    revision: input.revision,
    matches,
    complete: omissions.length === 0,
    omissions,
  });
}

export async function runAgent(
  snapshot: Snapshot,
  config: Config,
  selection: ModelSelection,
  system: string,
  prompt: string,
  access: Access,
  budget: Budget,
): Promise<unknown> {
  const endpoint = access.endpoints?.[selection.provider];
  const session = createSession(selection, {
    apiKey: access.keys[selection.provider] ?? "",
    system,
    prompt,
    tools,
    maxOutputTokens: config.limits.maxOutputTokens,
    maxConversationBytes: config.limits.maxConversationBytes,
    ...(endpoint === undefined ? {} : { endpoint }),
  });
  let results: ToolResult[] = [];
  while (true) {
    checkDeadline(budget);
    if (budget.requests >= config.limits.maxRequests)
      throw new Error("Model request budget exhausted");
    budget.requests++;
    let turn;
    try {
      turn = await session.next(
        results,
        AbortSignal.timeout(Math.max(1, budget.deadline - Date.now())),
      );
    } catch (error) {
      budget.usageComplete = false;
      throw error;
    }
    for (const key of Object.keys(budget.usage) as (keyof Usage)[])
      budget.usage[key] += turn.usage[key];
    checkDeadline(budget);
    if (turn.calls.length === 0) {
      try {
        return JSON.parse(turn.text);
      } catch {
        throw new Error("Model final output is not valid JSON");
      }
    }
    results = [];
    for (const call of turn.calls)
      results.push({
        id: call.id,
        output: await useTool(call, snapshot, config, budget),
      });
  }
}
