# Quality Tooling Refresh Plan

## Approved Direction

Apply the operator's repository maintenance request under the [quality tooling specification](../specs/2026-10-28-quality-refresh.md).
Use the current main checkout and a maintenance branch without creating a worktree.

## Implementation

1. Verify repository ownership, fork/archive status, existing changes, and applicable instructions.
   Record the current dependency releases and baseline `npm run check` result.
2. Demonstrate that the current Trunk configuration lacks the requested pinact contract.
   Update `.trunk/trunk.yaml` to align Prettier with the project version and enable pinact with its required runtime.
3. Run the full no-fix scan and inspect any proposed workflow updates before applying narrowly scoped fixes.
   Verify changed Action references against the corresponding upstream tags.
4. Reconcile the affected README claim and audit commands, paths, version claims, and internal links in the existing knowledge files.
   Preserve explicitly historical bootstrap evidence.
5. Run the project gate and full Trunk gate on the final candidate.
   Review the complete scoped diff and save visible evidence before requesting pull request approval.

## Verification

- Configuration reader: reject a missing pinact entry, wrong version, or missing command before accepting the final configuration.
- `trunk check --all --no-fix`: inspect all eligible files with the enabled linters.
- `npm run check`: inspect types, behavior fixtures, compilation, and declared formatting targets.
- `npm audit`: inspect the resolved npm dependency graph for known advisories.
- Internal-link check: resolve local Markdown targets and fragments against actual files and headings.

## Publication Boundary

Push and pull request creation require the operator's repository-specific approval.
After approval, continue the existing PR loop through current-head CI, hosted review, gated merge, authorized cleanup, and memory recording.
