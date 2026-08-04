# Factory Run Reference

## Generated IDs

Use only IDs returned by `factory ... --json`: `mis_*` missions, `mil_*`
milestones, and `tsk_*` tasks. Presentation IDs such as `m1t1` are not valid
runtime identifiers. `run-mission` requires an explicit `missionId` everywhere.

## Lifecycle

| Status | Meaning |
|---|---|
| `open` | Available to run |
| `in_progress` | Delegated or under validation |
| `closed` | Accepted with a nonempty closure reason |

Milestone and mission progress is derived from child tasks. The orchestrator
alone performs mutations. An unsuccessful or rejected task is retried under its same
ID; no new mission or task is initialized during execution.

## Evidence and diffs

Start from a clean worktree. Record the Git diff base before delegation and
keep the task in progress through validation. Compare the worker-reported paths
with the task diff, including additions and deletions, and account for every
path. Validate the worker report, diff, focused tests, and then broader checks
according to the approved `fast`, `standard`, or `exhaustive` mode.
