# Quality Tooling Refresh

## Scope

Refresh the existing Trunk formatter and add the operator-requested GitHub Actions supply-chain check.
Keep application behavior, public interfaces, and the existing project pre-commit gate unchanged.

## Requirements

- Use the current available release of the existing Prettier linter.
- Pin pinact to `4.1.1` and enable both `lint` and `upgrade` commands.
- Declare the Python runtime required by the Trunk pinact wrapper.
- Check direct and resolved npm dependencies against current registry releases without forcing transitive dependencies outside their parent's supported range.
- Preserve the lockfile and existing policy exclusions.
- Correct documentation claims made stale by the tooling change.
- Obtain repository-specific approval before pushing or creating a pull request.

## Acceptance

- The resolved Trunk configuration contains the requested pinact version and both commands.
- `trunk check --all --no-fix` executes the enabled linters and passes.
- `npm run check` passes type checking, local behavior tests, the compiled build, and the declared formatting check.
- `npm audit` reports no unresolved findings, or advisory-specific dispositions have supporting evidence.
- Documentation commands and internal links resolve against this checkout.

## Constraints

No live model calls, deployment, package publication, or unrelated configuration changes are included.
Hosted CI and review remain pending until pull request publication is approved.
