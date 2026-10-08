# Local Review Engine

## Approved Direction

Andrew Code Review is a provider-independent review engine for a future public GitHub Marketplace Action.
The operator approved an independent TypeScript CLI, OpenAI and Anthropic support, affected-code exploration, candidate verification, custom summaries, and explicit SHA-bound results.
This milestone delivers the local engine.
GitHub App hosting, review publication, and Marketplace releases are subsequent milestones.

## User Commands

`andrew-code-review inspect --repo /absolute/repository --base main --head HEAD` produces a JSON snapshot and routing recommendation without model calls.
`andrew-code-review review --repo /absolute/repository --base main --head HEAD` runs a bounded API-backed review and prints JSON.
Use `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for the selected provider.
The CLI does not read subscription credentials or automatically load `.env` files.
The CLI only reads committed code.
It reports that uncommitted changes are outside its input.

## Repository Snapshot

Verify the explicit repository root to prevent accidental upward discovery of another Git repository.
Resolve base and head to immutable commit IDs before analysis.
Use their unique merge-base for the candidate diff.
Reject ambiguous merge-bases rather than selecting one silently.
Retain the current base commit separately as the trusted policy revision.
Read `.andrew-review.yml` only from the base commit.
Reject malformed or unknown configuration keys.

Read regular tracked text blobs only.
Do not follow symlinks, submodules, worktree files, textconv filters, or external diff commands.
Use argument arrays for Git commands and freeze each revision before passing it to content commands.
Use bounded file, blob, context, request, output-token, and wall-time limits.
Record every relevant omission that prevents the planned review from completing.

## Context and Risk

Collect changed file patches and complete bounded before/after files.
Collect unchanged text files that reference identifiers from changed lines.
Include relevant repository guidance and requirement documents only as analysis data.
Use a bounded literal search and revision-bound read tool for additional exploration.
Label all initial relationships `textual`; semantic call-graph analysis is not part of this milestone.
The absence of textual references does not prove an absence of consumers.

Start with small changes at no more than 5 files and 200 changed lines.
Use medium for no more than 15 files and 600 changed lines, otherwise large.
Sensitive paths such as authorization, migrations, credentials, payments, and concurrency raise risk regardless of line count.
Use a single reviewer for this milestone.
Use a separate verification session for candidate findings.
Large or sensitive changes raise reviewer effort to `high` unless the configured effort is already higher.
Document provider/model availability rather than silently substituting another provider.

## Model Execution

Support OpenAI Responses and Anthropic Messages through separate protocol adapters.
Preserve provider-native tool and reasoning blocks within each session.
Allow only snapshot file reads and literal searches.
Do not expose a shell, network fetch, filesystem mutation, or GitHub publishing tool.
Refusals, truncated responses, invalid JSON, invalid tool calls, missing usage, and exhausted budgets cannot become a clean result.
Do not retry provider requests automatically in this milestone.
Bound API requests, tool calls, per-response output tokens, total serialized conversation bytes, and elapsed time.
Report token usage without claiming an exact dollar budget.
Dollar-denominated admission control requires a later versioned pricing implementation.

The default reviewer is `gpt-6.1-sol` at `medium` effort.
The default verifier is a separate `gpt-6.1-sol` session at `high` effort.
Configuration can select a supported OpenAI or Anthropic model and effort for either role.
Supporting both providers does not require both credentials unless the selected roles use both.
All candidate findings require verification; a model agreement is still classified as source-supported, not execution-reproduced.
Custom summary instructions affect the change summary, not evidence rules or tool permissions.

## Findings and Output

Each candidate includes a concrete trigger, impact, changed-code location, and at least one source reference.
Each source reference includes a revision, path, line range, and exact quotation.
The engine validates the location and quotation against the frozen snapshot.
Findings about pre-existing unrelated code are out of scope.
The verifier returns a disposition for every candidate: confirmed, rejected, or uncertain.
Confirmed findings retain verification evidence and a stable content fingerprint.
Rejected and uncertain candidates remain visible in the result, separate from confirmed findings.
Uncertain findings make the result incomplete.
Deduplicate identical findings without treating matching line numbers as identity.

## Suggested Code Changes

The operator additionally requested actionable GitHub `suggestion` blocks.
Allow an optional single-file, contiguous replacement attached to a confirmed finding.
Bind the replacement to exact original text and a head-side changed-line range.
The verification session must assess the proposed replacement separately from confirming the defect.
Omit the suggestion when it is unverified, requires coordinated edits, does not change the original, contains an unsafe Markdown fence, or overlaps another accepted suggestion.
Retain the finding when its suggestion is withheld.
Render the accepted replacement as a GitHub `suggestion` code fence and return its required comment anchor.
This milestone produces the comment payload locally and never posts or applies the suggestion.
Report source-based verification without claiming that the replacement was compiled or executed.

Results contain schema version, exact commit IDs, execution status, summary, coverage, risk, model selection, usage, findings, dispositions, and limitations.
`completed` means the bounded plan finished, not that the code has no bugs.
`incomplete` means coverage, verification, protocol, or budget requirements were unmet.
`failed` means review execution could not start or an infrastructure failure prevented useful analysis.
The CLI returns 0 for completed review or successful inspection, 2 for incomplete review, and 1 for invalid input or failed execution.
Finding severity does not determine the process exit code in this advisory milestone.

## Acceptance Checks

1. Real Git fixtures prove merge-base selection, current-base policy, immutable object reads, deletion and rename behavior, symlink exclusion, sensitive-path escalation, and affected unchanged-file collection.
2. Configuration fixtures prove that PR-side policy changes cannot alter execution and unsupported models or keys fail visibly.
3. Local HTTP servers prove actual OpenAI and Anthropic request formats, tool round trips, native history preservation, usage accounting, and refusal or truncated-response handling.
4. Review integration fixtures prove exact evidence validation, separate verification, candidate dispositions, budget exhaustion, and no false clean result.
5. Subprocess CLI tests prove JSON output, meaningful exit codes, missing-key handling, and no API calls from inspection.
6. Type checks, the complete test suite, the build, scoped formatting, and Trunk checks pass.
7. Suggestion tests apply a replacement in memory and verify the resulting source, unchanged surrounding lines, Markdown output, and rejection of stale, overlapping, or unverified edits.

## Deferred Work

- Semantic indexing and language-specific call graphs.
- Isolated test execution and reproduced findings.
- Historical-PR evaluation and comparative quality measurements.
- Incremental result reuse, GitHub checks, inline review anchors, and stale-head publication guards.
- Dollar budgets, caching, provider failover, and concurrent reviewer tasks.
- CodeRabbit configuration import, automatic fixes, and persistent learned rules.
- GitHub App hosting and Marketplace release.

## Protocol Sources

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Claude tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [GitHub pull request security](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

Sources were inspected on 2026-10-08.
