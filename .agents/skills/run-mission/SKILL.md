---
name: run-mission
description: Execute an approved Factory mission selected by its generated ID.
---

# Run Mission

I'm using the run-mission skill to manage this as a structured mission.

`run-mission` consumes, but never creates or replaces, a selected mission. The
orchestrator must receive an explicit generated `mis_*` mission ID and select
it for every operation. Factory is the sole runtime authority:
`.factory/missions.jsonl` stores metadata and nested executable missions.

Plan-backed missions have `sourcePlan: { planId, revision }`. For these,
`run-mission` also reads the exact approved plan revision from
`.factory/plans.jsonl` to obtain intent, the overall change plan, optional
external plan artifacts, risks, and acceptance criteria. Manual missions without `sourcePlan` are supported normally;
use their embedded task risk and verification fields and do not warn merely
because no plan exists. Reject a mission only when it has a broken source-plan
reference or that referenced revision is not approved.

## Protocol

1. Read the selected mission with `factory mission show <mis_...> --json`.
2. If it has `sourcePlan`, read `factory plan show <pln_...> --revision <n> --json`, confirm it is approved, and use its intent, change plan, optional artifacts, and acceptance criteria during execution and validation.
3. Confirm the mission verification mode and the clean-worktree/diff baseline.
4. Only the orchestrator changes lifecycle state with `factory mission update`
   or `factory mission close`; workers and validators do neither.
5. Select open tasks using `factory mission ready --mission <mis_...> --json`.
6. Mark a task `in_progress`, delegate work, and require the worker to report
   its changes, verification commands, and unresolved issues in its response.
7. Derive and validate the task-scoped diff from the baseline recorded before
   delegation.
8. Have a validator return `PASS` or
   `PASS WITH NOTES`; only then close the task with a meaningful reason.
9. Retry the same task ID after failure; never invent IDs or initialize a new
   mission. Review milestone progress and run the selected verification mode.

Statuses are `open`, `in_progress`, and `closed`. Progress is derived from
child task states; closure requires a reason and evidence. Mission selection,
IDs, titles, and milestone membership must match exactly.

Read [`REFERENCE.md`](REFERENCE.md) and [`VERIFICATION.md`](VERIFICATION.md)
for ID contracts, diff review, retry rules, and verification cadence.
