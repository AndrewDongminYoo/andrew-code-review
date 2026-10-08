# Local Review Engine Implementation Plan

**Goal:** Deliver a tested local review CLI with frozen Git inputs, bounded exploration, two provider protocols, and verified structured findings.

**Architecture:** A Git snapshot supplies immutable source files to a read-only review loop.
Provider adapters preserve their native protocol state.
A separate verification session checks candidate findings before the engine returns its result.

**Tech Stack:** Node.js 24, strict TypeScript, native Git and fetch, YAML, and the Node.js test runner.

**Spec:** [Local Review Engine](../specs/2026-10-08-local-review-engine.md).

## Global Constraints

- Work in `/Users/dongminyu/Development/01_personal/andrew-code-review`.
- Use personal account scope only.
- Do not read subscription credentials or call billable APIs during local verification.
- Do not run reviewed code or publish review results in this milestone.
- Keep policy on the current base commit and data on frozen revisions.
- Expose incomplete coverage and protocol failures.
- Implement natively in the current session with test-first behavior checks.
- Do not create a worktree or commit, push, or publish without the corresponding request.

## Review Focus

- Git discovery must not escape into an ancestor repository.
- Filenames, refs, and model tool arguments must not become commands or filesystem escapes.
- PR-side configuration changes must not influence trusted execution policy.
- Truncation, refusals, invalid evidence, and budget limits must not produce clean results.
- Verifier omissions and unknown candidate IDs must not silently discard findings.

## Task 1: Repository Snapshot and Policy

**Files:** `src/types.ts`, `src/config.ts`, `src/repository.ts`, `src/context.ts`, `test/helpers.mjs`, `test/repository.test.mjs`, `test/config.test.mjs`.

**Interfaces:** `openSnapshot(repo, base, head)` resolves revisions and provides bounded blob reads.
`loadConfig(snapshot)` loads base policy.
`collectContext(snapshot, config)` returns the changed-code context, textual references, coverage, and risk.

- [x] Write real Git fixture tests for frozen revisions, merge-base behavior, current-base policy, unusual filenames, deleted files, symlinks, related unchanged code, and limits.
- [x] Run the tests and record the expected missing-behavior failures.
- [x] Implement the smallest bounded snapshot and policy reader.
- [x] Run `npm test` and `npm run typecheck`.

## Task 2: Provider Sessions and Evidence Verification

**Files:** `src/providers.ts`, `src/agent.ts`, `src/findings.ts`, `src/suggestions.ts`, `src/review.ts`, `test/providers.test.mjs`, `test/review.test.mjs`, `test/suggestions.test.mjs`.

**Interfaces:** `createSession` exposes a provider-independent next-turn operation with native session history.
`runAgent` executes only declared snapshot tools within a shared budget.
`review` returns a SHA-bound result with explicit completion status.

- [x] Write local HTTP tests for both API protocols, native history, tool results, and failed or truncated responses.
- [x] Write review tests for exact evidence, verifier rejection and uncertainty, missing dispositions, and exhausted budgets.
- [x] Write suggestion tests for in-memory application, exact head text, line anchors, overlap, Markdown fences, and separate verifier approval.
- [x] Run the tests before adding the implementation.
- [x] Implement bounded provider calls, source validation, and separate verification.
- [x] Run `npm test` and `npm run typecheck`.

## Task 3: CLI and Quality Gate

**Files:** `src/cli.ts`, `test/cli.test.mjs`, `README.md`, `.andrew-review.example.yml`, `.trunk/trunk.yaml`, supporting quality configuration, and `docs/notes/2026-10-08-bootstrap.md`.

**Interfaces:** `inspect` emits a snapshot report without network calls.
`review` emits a structured review result and the exit status specified in the spec.

- [x] Write subprocess tests for help, argument validation, inspection, missing credentials, and output status.
- [x] Run the tests before implementing the CLI.
- [x] Document working commands and the exact current limitations.
- [x] Initialize a scoped Trunk gate and prove a deliberate violation is detected in a disposable verification repository.
- [x] Run `npm run check` through the configured pre-commit action and inspect a committed fixture with the built CLI.
- [x] Run `trunk check --all --no-fix --filter=prettier` against the verification copy.
- [ ] Run `trunk check --no-fix` in the main repository after an authorized first commit creates `refs/heads/main`.
- [x] Review the complete implementation, repair verified findings, and record remaining limitations.

## Continuation

The operator already approved the direction and requested implementation.
Continue directly into the local milestone without another planning approval cycle.
GitHub publication and live paid review evaluation remain separate actions.
