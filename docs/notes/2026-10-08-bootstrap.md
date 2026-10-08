# Bootstrap Evidence

## Identity

- Repository root: `/Users/dongminyu/Development/01_personal/andrew-code-review`.
- Account scope: personal, `AndrewDongminYoo`.
- Branch: `main`.
- Workspace: newly initialized main workspace, with no task-created worktree.
- GitHub lookup did not resolve a repository with this owner and name at initialization.

## Precedent

Oracle accepted the scoped project ID but returned no project-specific precedent.
The following account-neutral guidance confirmed the implementation direction.
Retrieval source commit: `c1681868ac634e4b2414874716bb75a7864113c4`.
Freshness against the current wiki source was not verified.

- `wiki/concepts/hold-the-line-checking.md`: concentrate on changed and directly affected code instead of reporting an unrelated repository backlog.
- `wiki/concepts/find-code-smells-command.md`: verify candidate findings against current code and leave mechanical lint checks to deterministic tools.
- `wiki/synthesis/what-confidence-floor-should-ai-review-comments-clear.md`: do not use one numeric model-confidence threshold across providers; evaluate precision and false-positive categories.
- `wiki/queries/research-confidence-floor-calibration-for-ai-review-skip-rule.md`: expose incomplete analysis and unknown measurements.

No direct precedent was found for this project's review budgets, provider abstraction, or Marketplace deployment.

## Dependency Decisions

- `yaml` parses user-authored YAML policy with duplicate-key and alias controls; Node.js does not supply a YAML parser.
- TypeScript and Node.js type declarations provide strict compile-time checks.
- Prettier supplies a reproducible scoped formatting check.
- Git, HTTP, CLI argument parsing, tests, and hashing use existing platform tools or Node.js built-ins.

## Verification

Verification completed on 2026-10-08.

- `npm ci --ignore-scripts` reproduced the locked installation and reported zero known vulnerabilities.
- `trunk actions run project-check-pre-commit` ran `npm run check`: strict type checks, 58 behavior tests, compiled CLI build, and scoped formatting all passed.
- Git fixture tests read committed blobs and exercise mutable attributes, merge-base policy separation, deleted and renamed sources, credential exclusions, source evidence, and coverage omissions.
- Local HTTP fixtures inspect serialized provider requests and actual tool round trips; they do not establish live API acceptance or model review quality.
- Suggestion tests inspect the rendered code fence, exact original text, changed-line anchor, and source produced by applying the replacement in memory.
- A separate built-CLI smoke check first rejected a no-change negative control, then found the expected committed change and matching head SHA.
- Two independent read-only review passes found seven issues across snapshot boundaries and finding protocols.
  Ten regression cases failed before the repairs and passed afterward; two additional cases verify credential exclusions in model tools.
  Both reviewers returned PASS after the repairs.

## Trunk Gate

Trunk 1.25.0 recognizes the project pre-commit action and pre-push check.
The repository-local `core.hooksPath` points to generated Trunk hooks, and both hook links exist.
The pre-commit action was executed successfully without creating a repository commit.

`trunk init` and main-repository lint checks require an existing commit.
The main branch is intentionally unborn because no commit was requested.
A disposable Git repository containing the same source and configuration was used to verify the formatter gate.
A deliberately malformed `prettier-probe.js` produced one formatting issue and exit 1.
After removing that probe, `trunk check --all --no-fix --filter=prettier` checked 29 files and passed.
The native main-repository Trunk check remains pending the first authorized commit.

## Runtime Diagnostic

`codex doctor --summary --ascii --no-color` returned 23 successful checks, 3 notes, 1 warning, and 0 failures.
The warning concerned update configuration; the command is advisory and no global configuration was changed to clear it.

## Remaining Boundaries

- No live billable model requests, historical-PR quality evaluation, or GitHub rendering checks were performed.
- No main-repository staging, commits, remotes, pushes, review publication, or Marketplace release were performed.
- Source relationships are textual; runtime execution and semantic analysis remain deferred.
- Credential filename exclusions are a conservative heuristic and cannot detect arbitrary embedded secrets.
- The model registry and protocol adapters need live API evaluation before a release claim.
