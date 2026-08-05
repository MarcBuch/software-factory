# Verification Reference

This is disclosed reference for `run-mission`. Read it when selecting task, milestone, or mission-end verification.

## Verification Modes

Use the mode from the approved `plan-mission` plan.

| Mode         | Use                                                        | Cadence                                                                                                    |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `fast`       | Default. Prefer the narrowest proof that the change works. | Narrow proof per task, light milestone verification, mission-end verification once.                        |
| `standard`   | Medium-risk work or routine workspace validation.          | Narrow proof plus relevant routine checks, moderate milestone verification, mission-end verification once. |
| `exhaustive` | High-risk work or explicit user request.                   | Heavier task and milestone verification for affected workspaces.                                           |

Default to `fast` only if the approved plan omits a mode. Do not change the approved mode without explicit user approval.

## Test Budget Rule

Unless the user asked for exhaustive coverage, prefer modifying existing tests or adding **1-3 targeted high-value tests** for an implementation task. Exceed that only when:

- A reproduced bug needs a matrix of cases.
- The unit is high-risk and the extra cases materially protect a boundary.
- The user explicitly asked for broader coverage.

## Task-Level Verification

Verification should prove the change without bloating runtime.

### Workspace-Specific Rule For This Repo

- For work in `apps/*` and `packages/*`, do not treat the workspace-local `bun run check` script as a full routine check. In this repo those scripts are typecheck-only.
- When `standard` or `exhaustive` verification calls for routine checks after changes in `apps/*` or `packages/*`, prefer the root `bun run check` command unless a narrower non-TypeScript workspace-wide command is explicitly more appropriate.
- A single typecheck command is still acceptable in `fast` mode for a purely type-level change.

### `fast` Mode

Worker runs:

- The narrowest relevant command that proves the changed behavior.
- Repo-required procedures from `AGENTS.md` when applicable.

Examples:

- One focused test file.
- One narrow integration command.
- One typecheck command for a purely type-level change.

### `standard` Mode

Worker runs:

- The narrowest relevant proof of the change.
- Routine workspace checks such as `bun run check` or `bun run lint` if they exist and are relevant.
- Repo-required procedures from `AGENTS.md` when applicable.

For this repo, if the task touches `apps/*` or `packages/*`, do not stop at that workspace's local `check` script when satisfying the routine-check step. Use the root `bun run check` command unless the task is a `fast`-mode purely type-level change.

### `exhaustive` Mode

Worker runs:

- Focused tests for the changed behavior.
- Smoke tests if the workspace has them.
- Routine workspace checks such as `check` and `lint`.
- Repo-required procedures from `AGENTS.md` when applicable.

For this repo, if the task touches `apps/*` or `packages/*`, satisfy the routine-check step with the root `bun run check` command rather than the workspace-local typecheck-only `check` script.

Use `exhaustive` only for high-risk or explicitly requested work.

## Milestone Verification

Determine affected workspaces from worker-reported paths and task diffs.

| Mode         | Milestone check                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast`       | Run the lightest workspace-level check that can catch obvious breakage, such as `check`, `lint`, or one narrow smoke command if that workspace has one. |
| `standard`   | Run routine workspace checks such as `check`, `lint`, and a narrow smoke command if that workspace has one.                                             |
| `exhaustive` | Run the full test suite for each affected workspace.                                                                                                    |

Do not run root-wide tests unless multiple workspaces were modified and there is no narrower equivalent.

For this repo, milestone verification for `apps/*` or `packages/*` should use the root `bun run check` command as the default routine check because those workspace-local `check` scripts are only typechecks.

Completion criterion: every affected workspace has an appropriate milestone check result, or a recorded reason why no check applies.

## Mission-End Verification

At mission end, run verification once for the affected workspaces across the full mission.

Completion criterion: every affected workspace has a recorded mission-end verification result, or a recorded reason why no command applies.
