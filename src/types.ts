export type Provider = "openai" | "anthropic";
export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type Revision = "base" | "head";

export interface ModelSelection {
  provider: Provider;
  model: string;
  effort: Effort;
}

export interface Config {
  version: 1;
  models: { reviewer: ModelSelection; verifier: ModelSelection };
  summary: { instructions: string };
  review: { instructions: string; excludePaths: string[] };
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxScanBytes: number;
    maxContextBytes: number;
    maxRelatedFiles: number;
    maxRequests: number;
    maxToolCalls: number;
    maxOutputTokens: number;
    maxConversationBytes: number;
    timeoutSeconds: number;
  };
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: number[];
  deletedLines: number[];
}

export interface Change {
  path: string;
  oldPath?: string;
  status: string;
}

export interface ChangedFile extends Change {
  before: string | null;
  after: string | null;
  patch: string;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

export interface Omission {
  path: string;
  reason: string;
}

export interface Risk {
  level: "small" | "medium" | "large" | "high";
  reasons: string[];
}

export interface Context {
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  changedFiles: ChangedFile[];
  relatedFiles: { path: string; content: string; relationship: "textual" }[];
  coverage: {
    complete: boolean;
    changedFiles: number;
    includedChangedFiles: number;
    scannedFiles: number;
    omissions: Omission[];
  };
  risk: Risk;
  limitations: string[];
}

export interface Location {
  path: string;
  revision: Revision;
  startLine: number;
  endLine: number;
}

export interface Evidence extends Location {
  quote: string;
}

export interface Replacement {
  startLine: number;
  endLine: number;
  original: string;
  replacement: string;
}

export interface PreparedSuggestion extends Replacement {
  markdown: string;
  anchor: {
    path: string;
    startLine: number;
    endLine: number;
    side: "RIGHT";
    headSha: string;
  };
}

export interface Candidate {
  id: string;
  title: string;
  severity: "P1" | "P2" | "P3";
  trigger: string;
  impact: string;
  location: Location;
  evidence: Evidence[];
  fingerprint: string;
  suggestion?: unknown;
}

export interface Verdict {
  id: string;
  disposition: "confirmed" | "rejected" | "uncertain";
  explanation: string;
  evidence: Evidence[];
  suggestionApproved: boolean;
}

export interface Finding extends Omit<Candidate, "suggestion"> {
  verification: "source_supported";
  verificationEvidence: Evidence[];
  verificationExplanation: string;
  suggestion?: PreparedSuggestion;
  suggestionOmittedReason?: string;
}
