import { createHash } from "node:crypto";
import { object, text } from "./config.ts";
import { isExcluded, sourceLines } from "./context.ts";
import { validatePath } from "./repository.ts";
import type { Snapshot } from "./repository.ts";
import type {
  Candidate,
  Config,
  Context,
  Evidence,
  Location,
  Verdict,
} from "./types.ts";

export function location(value: unknown): Location {
  const input = object(value, "source location");
  const path = text(input.path, "source path", 1024);
  validatePath(path);
  if (input.revision !== "head" && input.revision !== "base")
    throw new Error("Invalid source revision");
  const { startLine, endLine } = input;
  if (
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine >= 200
  )
    throw new Error("Invalid source line range");
  return { path, revision: input.revision, startLine, endLine };
}

export async function sourceAt(
  snapshot: Snapshot,
  config: Config,
  where: Location,
): Promise<string> {
  if (isExcluded(where.path, config))
    throw new Error("Source path excluded by policy");
  const content = await snapshot.readFile(
    where.revision,
    where.path,
    config.limits.maxFileBytes,
  );
  if (content === null)
    throw new Error("Source path is absent at the selected revision");
  const lines = sourceLines(content);
  if (where.endLine > lines.length)
    throw new Error("Source line range is outside the file");
  return lines.slice(where.startLine - 1, where.endLine).join("\n");
}

export async function evidenceList(
  raw: unknown,
  snapshot: Snapshot,
  config: Config,
  required = true,
): Promise<Evidence[]> {
  if (!Array.isArray(raw) || raw.length > 12 || (required && raw.length === 0))
    throw new Error("Invalid evidence list");
  const result: Evidence[] = [];
  for (const item of raw) {
    const input = object(item, "evidence");
    const where = location(input);
    const quote = text(input.quote, "evidence quotation");
    if ((await sourceAt(snapshot, config, where)) !== quote)
      throw new Error("Evidence quotation does not match the frozen source");
    result.push({ ...where, quote });
  }
  return result;
}

export async function parseCandidates(
  raw: unknown,
  snapshot: Snapshot,
  context: Context,
  config: Config,
): Promise<{ summary: string; candidates: Candidate[] }> {
  const input = object(raw, "review result");
  const summary = text(input.summary, "change summary");
  if (!Array.isArray(input.findings) || input.findings.length > 10)
    throw new Error(
      "Invalid findings list; at most 10 candidates are accepted",
    );
  const candidates: Candidate[] = [];
  const fingerprints = new Set<string>();
  for (const item of input.findings) {
    const value = object(item, "finding");
    const where = location(value.location);
    const changed = context.changedFiles.find(
      (file) =>
        (where.revision === "head"
          ? file.path
          : (file.oldPath ?? file.path)) === where.path,
    );
    if (!changed)
      throw new Error(
        "Finding location must refer to an included changed file",
      );
    if (
      !changed.hunks.some((hunk) =>
        (where.revision === "head" ? hunk.addedLines : hunk.deletedLines).some(
          (line) => line >= where.startLine && line <= where.endLine,
        ),
      )
    )
      throw new Error("Finding location must overlap a changed line");
    await sourceAt(snapshot, config, where);
    const evidence = await evidenceList(value.evidence, snapshot, config);
    const title = text(value.title, "finding title", 200);
    const trigger = text(value.trigger, "finding trigger", 4000);
    const impact = text(value.impact, "finding impact", 4000);
    if (!["P1", "P2", "P3"].includes(String(value.severity)))
      throw new Error("Invalid finding severity");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          path: where.path,
          title,
          trigger,
          evidence: evidence.map(({ path, quote }) => ({ path, quote })),
        }),
      )
      .digest("hex");
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    candidates.push({
      id: `F${candidates.length + 1}`,
      title,
      severity: value.severity as Candidate["severity"],
      trigger,
      impact,
      location: where,
      evidence,
      fingerprint,
      ...(value.suggestion == null ? {} : { suggestion: value.suggestion }),
    });
  }
  return { summary, candidates };
}

export async function parseVerdicts(
  raw: unknown,
  candidates: Candidate[],
  snapshot: Snapshot,
  config: Config,
): Promise<Verdict[]> {
  const input = object(raw, "verification result");
  if (
    !Array.isArray(input.verdicts) ||
    input.verdicts.length !== candidates.length
  )
    throw new Error("A verification verdict is required for every candidate");
  const ids = new Set(candidates.map((candidate) => candidate.id));
  const verdicts: Verdict[] = [];
  for (const item of input.verdicts) {
    const value = object(item, "verification verdict");
    const id = text(value.id, "candidate ID", 32);
    if (!ids.delete(id))
      throw new Error("Unknown or duplicate verification verdict ID");
    if (
      !["confirmed", "rejected", "uncertain"].includes(
        String(value.disposition),
      )
    )
      throw new Error("Invalid verification disposition");
    if (typeof value.suggestionApproved !== "boolean")
      throw new Error("Missing suggestion verification decision");
    if (
      value.suggestionApproved &&
      (value.disposition !== "confirmed" ||
        candidates.find((candidate) => candidate.id === id)?.suggestion ===
          undefined)
    )
      throw new Error(
        "Invalid suggestion approval for this candidate disposition",
      );
    verdicts.push({
      id,
      disposition: value.disposition as Verdict["disposition"],
      explanation: text(value.explanation, "verification explanation", 4000),
      evidence: await evidenceList(
        value.evidence,
        snapshot,
        config,
        value.disposition === "confirmed",
      ),
      suggestionApproved: value.suggestionApproved,
    });
  }
  return verdicts;
}
