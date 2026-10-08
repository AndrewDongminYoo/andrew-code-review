import { matchesGlob } from "node:path";
import type { Snapshot } from "./repository.ts";
import type { ChangedFile, Config, Context, Hunk, Risk } from "./types.ts";

const protectedPaths = [
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/credentials{,.*}",
  "**/secrets{,.*}",
  "**/secrets/**",
  "**/credentials/**",
  "**/token.{txt,json,yaml,yml}",
  "**/password{,s}.{txt,json,yaml,yml}",
  "**/service-account*.json",
];
const commonWords = new Set(
  "const let var function return export import from string number boolean void null undefined true false class public private async await default typeof throw new this else interface type extends implements readonly static value error Error test describe expect assert".split(
    " ",
  ),
);

export function isExcluded(path: string, config: Config): boolean {
  const hidden = path
    .split("/")
    .some((part) => part.startsWith(".") && part !== ".github");
  return (
    hidden ||
    protectedPaths.some((pattern) =>
      matchesGlob(path.toLowerCase(), pattern.toLowerCase()),
    ) ||
    config.review.excludePaths.some((pattern) => matchesGlob(path, pattern))
  );
}

export function sourceLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function parsePatch(patch: string): {
  hunks: Hunk[];
  additions: number;
  deletions: number;
  identifiers: Set<string>;
  identifiersTruncated: boolean;
} {
  const hunks: Hunk[] = [];
  const identifiers = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let identifiersTruncated = false;
  for (const line of patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        addedLines: [],
        deletedLines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      hunks.push(hunk);
    } else if (hunk && (line.startsWith("+") || line.startsWith("-"))) {
      if (line.startsWith("+")) {
        additions++;
        hunk.addedLines.push(newLine++);
      } else {
        deletions++;
        hunk.deletedLines.push(oldLine++);
      }
      for (const token of line.slice(1).match(/[A-Za-z_$][\w$]{2,}/g) ?? []) {
        if (commonWords.has(token) || identifiers.has(token)) continue;
        if (identifiers.size < 100) identifiers.add(token);
        else identifiersTruncated = true;
      }
    } else if (hunk && line.startsWith(" ")) {
      oldLine++;
      newLine++;
    } else if (line.startsWith("diff --git ")) {
      hunk = undefined;
    }
  }
  return { hunks, additions, deletions, identifiers, identifiersTruncated };
}

function classify(
  paths: string[],
  changedLines: number,
  complete: boolean,
): Risk {
  const sensitive = paths.filter((path) =>
    /(?:^|[/_.-])(auth\w*|security|permissions?|credentials?|tokens?|payments?|migrations?|schema|concurrency|locks?)(?:[/_.-]|$)/i.test(
      path,
    ),
  );
  if (sensitive.length)
    return {
      level: "high",
      reasons: sensitive.map((path) => `Sensitive path: ${path}`),
    };
  if (!complete)
    return {
      level: "high",
      reasons: ["Incomplete context requires increased scrutiny"],
    };
  if (paths.length <= 5 && changedLines <= 200)
    return {
      level: "small",
      reasons: ["At most 5 files and 200 changed lines"],
    };
  if (paths.length <= 15 && changedLines <= 600)
    return {
      level: "medium",
      reasons: ["At most 15 files and 600 changed lines"],
    };
  return {
    level: "large",
    reasons: ["More than 15 files or 600 changed lines"],
  };
}

export async function collectContext(
  snapshot: Snapshot,
  config: Config,
): Promise<Context> {
  const changedFiles: ChangedFile[] = [];
  const relatedFiles: Context["relatedFiles"] = [];
  const omissions: Context["coverage"]["omissions"] = [];
  const identifiers = new Set<string>();
  let contextBytes = 0;
  let scanBytes = 0;
  let scannedFiles = 0;
  const admit = (value: unknown): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (contextBytes + bytes > config.limits.maxContextBytes) return false;
    contextBytes += bytes;
    return true;
  };
  for (const change of snapshot.changes) {
    try {
      if (
        isExcluded(change.path, config) ||
        (change.oldPath && isExcluded(change.oldPath, config))
      )
        throw new Error("Excluded by source policy");
      if (changedFiles.length >= config.limits.maxFiles)
        throw new Error("Changed-file limit reached");
      const before = await snapshot.readFile(
        "base",
        change.oldPath ?? change.path,
        config.limits.maxFileBytes,
      );
      const after = await snapshot.readFile(
        "head",
        change.path,
        config.limits.maxFileBytes,
      );
      const patch = await snapshot.patch(change);
      const parsed = parsePatch(patch);
      if ((before ?? "") !== (after ?? "") && parsed.hunks.length === 0)
        throw new Error("Changed text has no usable diff hunks");
      const file = {
        ...change,
        before,
        after,
        patch,
        hunks: parsed.hunks,
        additions: parsed.additions,
        deletions: parsed.deletions,
      };
      if (!admit(file)) throw new Error("Context byte limit reached");
      changedFiles.push(file);
      if (parsed.identifiersTruncated)
        omissions.push({
          path: change.path,
          reason:
            "Changed-identifier limit reached; related-source discovery is incomplete",
        });
      for (const identifier of parsed.identifiers) identifiers.add(identifier);
    } catch (error) {
      omissions.push({
        path: change.path,
        reason: error instanceof Error ? error.message : "Unreadable change",
      });
    }
  }
  const changedPaths = new Set(snapshot.changes.map((change) => change.path));
  const candidates = snapshot
    .paths("head")
    .filter(
      (path) =>
        !changedPaths.has(path) &&
        /(?:\.(?:[cm]?[jt]sx?|py|go|rs|swift|kt|java|dart|[ch](?:pp)?|sh|sql|ya?ml|json|md|toml)|(?:^|\/)(?:Makefile|Dockerfile))$/i.test(
          path,
        ) &&
        !isExcluded(path, config),
    );
  if (identifiers.size) {
    for (const path of candidates) {
      if (
        scannedFiles >= config.limits.maxFiles ||
        scanBytes >= config.limits.maxScanBytes
      ) {
        omissions.push({
          path,
          reason:
            "Related-source scan limit reached; remaining candidates were not scanned",
        });
        break;
      }
      scannedFiles++;
      let content: string | null;
      try {
        content = await snapshot.readFile(
          "head",
          path,
          config.limits.maxFileBytes,
        );
      } catch {
        omissions.push({
          path,
          reason: "Related-source candidate is not bounded regular text",
        });
        continue;
      }
      if (content === null) continue;
      scanBytes += Buffer.byteLength(content);
      if (scanBytes > config.limits.maxScanBytes) {
        omissions.push({
          path,
          reason: "Related-source scan byte limit reached",
        });
        break;
      }
      const words = new Set(content.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);
      if (![...identifiers].some((identifier) => words.has(identifier)))
        continue;
      const related = { path, content, relationship: "textual" as const };
      if (
        relatedFiles.length >= config.limits.maxRelatedFiles ||
        !admit(related)
      ) {
        omissions.push({ path, reason: "Related context limit reached" });
        continue;
      }
      relatedFiles.push(related);
    }
  }
  const complete = omissions.length === 0;
  return {
    baseSha: snapshot.baseSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    headSha: snapshot.headSha,
    changedFiles,
    relatedFiles,
    coverage: {
      complete,
      changedFiles: snapshot.changes.length,
      includedChangedFiles: changedFiles.length,
      scannedFiles,
      omissions,
    },
    risk: classify(
      snapshot.changes.map((change) => change.path),
      changedFiles.reduce(
        (total, file) => total + file.additions + file.deletions,
        0,
      ),
      complete,
    ),
    limitations: [
      "Only committed Git objects are reviewed; uncommitted changes are excluded.",
      "Relationships are textual references, not a semantic call graph.",
      "Dynamic dispatch, external consumers, and runtime behavior are not verified.",
    ],
  };
}
