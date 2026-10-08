import { object, text } from "./config.ts";
import { sourceLines } from "./context.ts";
import { location, sourceAt } from "./findings.ts";
import type { Snapshot } from "./repository.ts";
import type {
  Candidate,
  Config,
  Context,
  PreparedSuggestion,
  Replacement,
} from "./types.ts";

export function applyReplacement(source: string, edit: Replacement): string {
  const lines = sourceLines(source);
  if (
    !Number.isSafeInteger(edit.startLine) ||
    !Number.isSafeInteger(edit.endLine) ||
    edit.startLine < 1 ||
    edit.endLine < edit.startLine ||
    edit.endLine > lines.length
  )
    throw new Error("Invalid replacement range");
  if (
    lines.slice(edit.startLine - 1, edit.endLine).join("\n") !== edit.original
  )
    throw new Error("Replacement original does not match source");
  lines.splice(
    edit.startLine - 1,
    edit.endLine - edit.startLine + 1,
    ...(edit.replacement === "" ? [] : edit.replacement.split("\n")),
  );
  return (
    lines.join("\n") + (source.endsWith("\n") && lines.length > 0 ? "\n" : "")
  );
}

export async function prepareSuggestion(
  snapshot: Snapshot,
  context: Context,
  config: Config,
  candidate: Pick<Candidate, "location" | "suggestion">,
  approved: boolean,
  occupied: { path: string; startLine: number; endLine: number }[],
): Promise<{ suggestion?: PreparedSuggestion; reason?: string }> {
  if (candidate.suggestion === undefined) return {};
  try {
    if (!approved)
      throw new Error("The verifier did not approve the proposed replacement");
    if (candidate.location.revision !== "head")
      throw new Error("Suggestions require a head-side location");
    const raw = object(candidate.suggestion, "suggestion");
    const where = location({
      ...raw,
      path: candidate.location.path,
      revision: "head",
    });
    const file = context.changedFiles.find(
      (changed) => changed.path === where.path,
    );
    if (
      !file?.hunks.some((hunk) =>
        Array.from(
          { length: where.endLine - where.startLine + 1 },
          (_, index) => where.startLine + index,
        ).every((line) => hunk.addedLines.includes(line)),
      )
    )
      throw new Error(
        "Suggestion range must fit one head-side changed-line block",
      );
    if (
      where.startLine > candidate.location.endLine ||
      where.endLine < candidate.location.startLine
    )
      throw new Error("Suggestion range must cover the finding location");
    const original = text(raw.original, "suggestion original");
    if ((await sourceAt(snapshot, config, where)) !== original)
      throw new Error("Suggestion original does not match the reviewed head");
    if (
      typeof raw.replacement !== "string" ||
      raw.replacement.length > 16_000 ||
      raw.replacement.includes("\0")
    )
      throw new Error("Invalid replacement text");
    const replacement = raw.replacement;
    if (replacement === original)
      throw new Error("Suggestion replacement is unchanged");
    if (/`{3,}/.test(replacement))
      throw new Error("Suggestion contains a Markdown fence");
    if (
      occupied.some(
        (edit) =>
          edit.path === where.path &&
          edit.startLine <= where.endLine &&
          edit.endLine >= where.startLine,
      )
    )
      throw new Error("Suggestion overlaps an accepted replacement");
    return {
      suggestion: {
        startLine: where.startLine,
        endLine: where.endLine,
        original,
        replacement,
        markdown: `\`\`\`suggestion\n${replacement}\n\`\`\``,
        anchor: {
          path: where.path,
          startLine: where.startLine,
          endLine: where.endLine,
          side: "RIGHT",
          headSha: snapshot.headSha,
        },
      },
    };
  } catch (error) {
    return {
      reason:
        error instanceof Error
          ? error.message
          : "Suggestion could not be verified",
    };
  }
}
