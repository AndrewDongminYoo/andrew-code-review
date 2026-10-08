# Andrew Code Review

Evidence-based code reviews with explicit coverage and optional GitHub code suggestions.

The local CLI reviews immutable Git commits through OpenAI or Anthropic APIs.
It collects changed code and related unchanged text, permits bounded source exploration, and verifies candidate findings in a separate model session.
An accepted suggestion includes replacement code, exact original text, and the head-side anchor needed for a GitHub review comment.

**Status:** Local engine milestone.
GitHub publication, a Marketplace Action, and GitHub App hosting are not implemented yet.
Live API quality and GitHub rendering have not been validated.

## Run Locally

Install Node.js 24 or newer and Git.
From this repository:

```bash
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
```

Inspect a committed change without an API call:

```bash
node dist/cli.js inspect \
  --repo /absolute/path/to/project \
  --base main \
  --head feature-branch
```

Run a review after providing the configured provider's API key through your environment:

```bash
node dist/cli.js review \
  --repo /absolute/path/to/project \
  --base main \
  --head feature-branch
```

The default reviewer and verifier use `OPENAI_API_KEY`.
Roles configured for Anthropic use `ANTHROPIC_API_KEY`.
No subscription login or local coding-agent credentials are used.
Reviewing code sends the selected source context to the configured API providers and incurs their API charges.

The explicit repository must be its Git root.
The engine resolves base and head before reading files and compares their unique merge-base with head.
Uncommitted changes are excluded.
The engine does not fetch refs, execute reviewed code, modify files, apply suggestions, or publish anything.

## Repository Policy

Copy [.andrew-review.example.yml](.andrew-review.example.yml) to `.andrew-review.yml` in the reviewed repository and commit it to its base branch.
Only that base-commit policy controls execution; a PR cannot change its own review policy.
Unknown keys, duplicate YAML keys, aliases, unsupported models, and invalid limits fail visibly.

The initial model registry supports these model IDs:

| Provider  | Models                                                                         |
| --------- | ------------------------------------------------------------------------------ |
| OpenAI    | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-5.6-terra`, `gpt-6-luna`                    |
| Anthropic | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |

Each role can use `low`, `medium`, `high`, `xhigh`, or `max` effort.
Terra and Luna also accept `none`.
Model availability depends on the API account.
The engine does not silently substitute providers or models.

Small changes use the configured reviewer effort.
Larger changes, sensitive paths, or incomplete collected context raise effort to at least `high`.
Verification uses the separately configured role and a fresh conversation.
This routing policy is an initial evaluation baseline, not a measured quality ranking.

## Suggestions

Findings may include a `suggestion` with these fields:

- `original` and `replacement`: the exact selected source and replacement text.
- `startLine` and `endLine`: a contiguous block of added lines within one head-side diff hunk.
- `anchor`: path, range, right-hand side, and reviewed head SHA.
- `markdown`: a GitHub `suggestion` code block for that range.

The verifier must confirm the defect and approve the proposed replacement separately.
A confirmed defect can remain in the report while its suggestion is withheld.
Stale originals, no-op replacements, overlapping edits, unsupported fences, and ranges outside the diff are withheld.
Suggestions are source-supported proposals; they have not been compiled or executed.
Applying and publishing them are outside this milestone.

## Result Contract

Review output is one JSON object containing exact revision IDs, risk, coverage, models, summary, candidates, confirmed findings, verification dispositions, usage, errors, and limitations.
Inspection reports include collected source text; store them with the same care as the reviewed repository.

| Status       | Meaning                                                                           | Exit code |
| ------------ | --------------------------------------------------------------------------------- | --------- |
| `inspected`  | Context collection was attempted without model calls; inspect `coverage.complete` | 0         |
| `completed`  | The bounded review plan completed; this is not a defect-free certification        | 0         |
| `incomplete` | Coverage, verification, protocol, or budget requirements were unmet               | 2         |
| `failed`     | Invalid input or review initialization failed                                     | 1         |

Finding severity does not change the advisory exit code.
An empty findings list is meaningful only together with status and coverage.
Provider failures can leave token totals incomplete; check `usage.complete`.
Limits bound requests, tool calls, output tokens, conversation size, and model-loop time.
They do not promise a precise dollar ceiling.

## Current Boundaries

- Relationships are textual matches, not compiler-resolved references or call graphs.
- Source discovery supports common code and configuration extensions but cannot establish dynamic or external consumers.
- Hidden paths other than `.github`, private-key patterns, conventional credential data filenames, and configured exclusions are not sent as source context.
- Filename exclusions are not a secret detector; remove embedded credentials and configure project-specific exclusions before sending repository source to a provider.
- Skipped changed files, unreadable candidate files, and collection limits are disclosed.
- The initial reviewer emits at most ten candidate findings and does not run parallel review workers.
- No repository commands, dependency installation, compilation, or tests run during review.
- The local engine does not determine whether a PR head has advanced on GitHub.
- Incremental reviews, historical quality evaluation, semantic indexing, CodeRabbit policy import, and dollar budgets remain future work.

## Development

```bash
npm run check
trunk check --no-fix
```

Tests create temporary Git repositories and local HTTP servers.
They do not require API credentials or send review data to model providers.
Trunk requires an initial Git commit for its lint checks; the bootstrap verification copy passed, while the main-repository check remains pending that first commit.

Read the [specification](docs/specs/2026-10-08-local-review-engine.md), [implementation plan](docs/plans/2026-10-08-local-review-engine.md), and [verification notes](docs/notes/2026-10-08-bootstrap.md).
