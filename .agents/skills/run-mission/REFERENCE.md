# Factory Run Reference

## Generated IDs

Use only IDs returned by `factory ... --json`: `pln_*` plans, `mis_*` missions,
`mil_*` milestones, and `tsk_*` tasks. Presentation keys such as `m1t1` exist
only in a plan before materialization; they are not runtime identifiers.
`run-mission` requires an explicit `missionId` everywhere.

## Plan-Backed And Manual Missions

A materialized mission has `sourcePlan: { planId, revision }`. Read that exact
plan revision and require it to remain `approved`; use its intent, change plan,
optional artifacts, risks, and acceptance criteria as execution and validation context. The task lifecycle,
task IDs, and dependency IDs in the materialized mission remain the runtime
authority.

Manual missions omit `sourcePlan`. They are fully supported: run them with
their embedded task metadata and verification mode. Missing `sourcePlan` is not
an error; a present but missing, mismatched, or non-approved reference is.

## Lifecycle

| Status        | Meaning                                 |
| ------------- | --------------------------------------- |
| `open`        | Available to run                        |
| `in_progress` | Delegated or under validation           |
| `closed`      | Accepted with a nonempty closure reason |

Milestone and mission progress is derived from child tasks. The orchestrator
alone performs mutations. An unsuccessful or rejected task is retried under its same
ID; no new mission or task is initialized during execution.

## Evidence and diffs

Start from a clean worktree. Record the Git diff base before delegation and
keep the task in progress through validation. Compare the worker-reported paths
with the task diff, including additions and deletions, and account for every
path. Validate the worker report, diff, focused tests, and then broader checks
according to the approved `fast`, `standard`, or `exhaustive` mode.
