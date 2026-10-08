#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, selectReviewer } from "./config.ts";
import { collectContext } from "./context.ts";
import { openSnapshot } from "./repository.ts";
import { review } from "./review.ts";

const help = `andrew-code-review

Usage:
  andrew-code-review inspect --repo /absolute/repository --base main [--head HEAD]
  andrew-code-review review  --repo /absolute/repository --base main [--head HEAD]

inspect reads committed Git objects and prints context without API calls.
review uses OPENAI_API_KEY and/or ANTHROPIC_API_KEY for configured roles.
Policy is read from .andrew-review.yml at the resolved base commit.
Results are printed as JSON. No files are changed and no reviews are posted.
Review exit codes: 0 completed, 2 incomplete, 1 failed or invalid input.
`;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const { values, positionals } = parseArgs({
    options: {
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    const command = positionals[0];
    if (
      positionals.length !== 1 ||
      (command !== "inspect" && command !== "review")
    )
      throw new Error("Choose inspect or review; use --help for usage");
    if (!values.repo || !values.base)
      throw new Error("Both --repo and --base are required");
    const snapshot = await openSnapshot(values.repo, values.base, values.head);
    const config = await loadConfig(snapshot);
    if (command === "inspect") {
      const context = await collectContext(snapshot, config);
      emit({
        schemaVersion: 1,
        status: "inspected",
        ...context,
        models: {
          reviewer: selectReviewer(config, context.risk),
          verifier: config.models.verifier,
        },
      });
    } else {
      const result = await review(snapshot, config, {
        keys: {
          openai: process.env.OPENAI_API_KEY ?? "",
          anthropic: process.env.ANTHROPIC_API_KEY ?? "",
        },
      });
      emit(result);
      process.exitCode =
        result.status === "completed"
          ? 0
          : result.status === "incomplete"
            ? 2
            : 1;
    }
  }
} catch (error) {
  emit({
    schemaVersion: 1,
    status: "failed",
    errors: [
      error instanceof Error ? error.message : "Unexpected review error",
    ],
  });
  process.exitCode = 1;
}
