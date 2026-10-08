import { parseDocument } from "yaml";
import type { Config, Effort, ModelSelection, Risk } from "./types.ts";
import type { Snapshot } from "./repository.ts";

const efforts: Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const models: Record<string, { provider: string; supportsNone: boolean }> = {
  "gpt-6-astra": { provider: "openai", supportsNone: false },
  "gpt-6.1-sol": { provider: "openai", supportsNone: false },
  "gpt-5.6-terra": { provider: "openai", supportsNone: true },
  "gpt-6-luna": { provider: "openai", supportsNone: true },
  "claude-fable-5-1": { provider: "anthropic", supportsNone: false },
  "claude-opus-5-5": { provider: "anthropic", supportsNone: false },
  "claude-sonnet-5-5": { provider: "anthropic", supportsNone: false },
  "claude-haiku-5-5": { provider: "anthropic", supportsNone: false },
};

export function defaultConfig(): Config {
  return {
    version: 1,
    models: {
      reviewer: { provider: "openai", model: "gpt-6.1-sol", effort: "medium" },
      verifier: { provider: "openai", model: "gpt-6.1-sol", effort: "high" },
    },
    summary: {
      instructions:
        "Explain the behavioral change, affected consumers, and analysis limitations.",
    },
    review: {
      instructions:
        "Report concrete correctness and security regressions introduced by this change.",
      excludePaths: [],
    },
    limits: {
      maxFiles: 250,
      maxFileBytes: 32_768,
      maxScanBytes: 1_048_576,
      maxContextBytes: 65_536,
      maxRelatedFiles: 12,
      maxRequests: 8,
      maxToolCalls: 24,
      maxOutputTokens: 8_192,
      maxConversationBytes: 524_288,
      timeoutSeconds: 180,
    },
  };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}`);
}

export function text(
  value: unknown,
  label: string,
  maxLength = 16_000,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(`Invalid ${label}`);
  return value;
}

function parseModel(value: unknown): ModelSelection {
  const input = object(value, "model");
  keys(input, ["provider", "model", "effort"], "model");
  const name = text(input.model, "model name");
  const capability = Object.hasOwn(models, name) ? models[name] : undefined;
  if (!capability || input.provider !== capability.provider)
    throw new Error("Unsupported provider or model");
  if (
    !efforts.includes(input.effort as Effort) ||
    (input.effort === "none" && !capability.supportsNone)
  )
    throw new Error("Unsupported model effort");
  return {
    model: name,
    provider: input.provider as ModelSelection["provider"],
    effort: input.effort as Effort,
  };
}

export function parseConfig(source: string): Config {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error("Invalid YAML policy");
  const input = object(document.toJS({ maxAliasCount: 0 }), "policy");
  keys(input, ["version", "models", "summary", "review", "limits"], "policy");
  if (input.version !== 1) throw new Error("Unsupported policy version");
  const config = defaultConfig();
  if (input.models !== undefined) {
    const roles = object(input.models, "models");
    keys(roles, ["reviewer", "verifier"], "models");
    for (const role of ["reviewer", "verifier"] as const)
      if (roles[role] !== undefined)
        config.models[role] = parseModel(roles[role]);
  }
  for (const section of ["summary", "review"] as const) {
    if (input[section] === undefined) continue;
    const value = object(input[section], section);
    keys(
      value,
      section === "summary"
        ? ["instructions"]
        : ["instructions", "excludePaths"],
      section,
    );
    if (value.instructions !== undefined)
      config[section].instructions = text(
        value.instructions,
        `${section} instructions`,
      );
    if (section === "review" && value.excludePaths !== undefined) {
      if (!Array.isArray(value.excludePaths) || value.excludePaths.length > 100)
        throw new Error("Invalid excludePaths");
      config.review.excludePaths = value.excludePaths.map((path) =>
        text(path, "excluded path", 256),
      );
    }
  }
  if (input.limits !== undefined) {
    const limits = object(input.limits, "limits");
    keys(limits, Object.keys(config.limits), "limits");
    const ceilings: Config["limits"] = {
      maxFiles: 1000,
      maxFileBytes: 131_072,
      maxScanBytes: 8_388_608,
      maxContextBytes: 262_144,
      maxRelatedFiles: 50,
      maxRequests: 24,
      maxToolCalls: 100,
      maxOutputTokens: 32_768,
      maxConversationBytes: 2_097_152,
      timeoutSeconds: 600,
    };
    for (const [key, value] of Object.entries(limits)) {
      const limit = key as keyof Config["limits"];
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > ceilings[limit]
      )
        throw new Error(`Invalid limit: ${key}`);
      config.limits[limit] = value;
    }
  }
  return config;
}

export async function loadConfig(snapshot: Snapshot): Promise<Config> {
  const policy = await snapshot.readPolicy();
  return policy === null ? defaultConfig() : parseConfig(policy);
}

export function selectReviewer(config: Config, risk: Risk): ModelSelection {
  const selected = { ...config.models.reviewer };
  if (
    risk.level !== "small" &&
    efforts.indexOf(selected.effort) < efforts.indexOf("high")
  )
    selected.effort = "high";
  return selected;
}
