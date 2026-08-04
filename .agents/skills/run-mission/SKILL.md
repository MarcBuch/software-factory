---
name: run-mission
description: Run a long-horizon goal after an approved plan-mission plan as a structured mission. Use when work spans multiple milestones or subagents and needs explicit progress tracking.
---

# Run Mission

## Overview

A mission is a long-running goal broken into **milestones**, each containing **tasks**. The orchestrator owns all state transitions. Worker subagents do task work and report evidence. Scrutiny Validators review completed task work without blindly rerunning the whole verification stack.

**Announce at start:** "I'm using the run-mission skill to manage this as a structured mission."

The core invariant: a task stays `in_progress` until the worker has reported, the task-scoped diff has been derived, and the Scrutiny Validator has returned `PASS` or `PASS WITH NOTES`.

## Reference Pointers

Read these only when their branch is reached:
- [`VERIFICATION.md`](VERIFICATION.md): verification modes, test budget, and task/milestone/mission verification cadence.
- [`HANDOFF.md`](HANDOFF.md): worker `mission_handoff` schema and field rules.
- [`VALIDATOR.md`](VALIDATOR.md): Scrutiny Validator behavior, verdicts, and prompt template.
- [`REFERENCE.md`](REFERENCE.md): IDs, statuses, clean-worktree and diff criteria, and failure handling.

## Orchestrator Responsibilities

The orchestrator:
1. Loads `plan-mission` first and gets an approved plan.
2. Always checks for an existing mission before calling `mission_init`.
3. Uses the verification mode from the approved plan: `fast`, `standard`, or `exhaustive`.
4. Defines the full mission structure upfront via `mission_init`.
5. Marks tasks `in_progress` before delegating them.
6. Verifies the mission starts from a clean worktree before any code-changing task.
7. Delegates each task to a worker subagent, passing full context and prior handoffs.
8. Receives the worker result, reads the handoff, and derives the task-scoped diff.
9. Spawns a Scrutiny Validator before marking the task `completed`.
10. Reviews progress after each milestone before starting the next.
11. Runs milestone and mission-end verification at the cadence defined by the selected mode.
12. Decides whether to retry, skip, or abort on failure.

Worker subagents **never** call `mission_update_task`. They call `mission_handoff` as their last action, then return results to the orchestrator.

Scrutiny Validator subagents are reviewers. They do **not** call `mission_handoff` unless explicitly asked to modify files, in which case they are no longer acting as validators.

---

## Workflow

### Prerequisite: Plan the mission first

Before calling `mission_init`, load and complete the **`plan-mission`** skill:
1. Load the skill: `skill("plan-mission")`.
2. Follow its protocol to decompose the goal and choose a verification mode.
3. Present the plan to the user and wait for explicit approval.
4. Only after approval, call `mission_init` with a structure that matches the approved plan exactly.

**Completion criterion:** the user has explicitly approved a plan that includes every milestone, task ID, task title, and verification mode.

**Do not call `mission_init` until `plan-mission` produces an approved plan.**

### Prerequisite: Check for an existing mission

`mission_init` overwrites the current mission file.

Before calling it:
1. Always read the current mission state with `mission_read`.
2. If the existing mission is still `pending` or `in_progress`, stop and ask the user whether to resume it or explicitly replace it.
3. Only call `mission_init` when there is no active mission, or the user has clearly approved replacement.

**Completion criterion:** either no active mission exists, or the user has explicitly approved replacing the active mission.

Do not silently replace an in-flight mission.

### Prerequisite: Set the verification mode

Use the verification mode from the approved mission plan. If the plan omits a mode, default to `fast`; do not upgrade or downgrade the approved mode without explicit user approval.

For mode definitions, read [`VERIFICATION.md`](VERIFICATION.md#verification-modes).

**Completion criterion:** the selected mode is recorded in the orchestrator context and passed to every worker and validator prompt.

### Step 1: Initialize the Mission

Call `mission_init` with the full milestone and task tree before spawning any subagents.

```
mission_init(
  title: "Auth hardening",
  milestones: [
    {
      id: "m1",
      title: "Token handling",
      tasks: [
        { id: "m1t1", title: "Implement token expiry handling" },
        { id: "m1t2", title: "Verify token expiry edge cases" }
      ]
    },
    {
      id: "m2",
      title: "CSRF flow",
      tasks: [
        { id: "m2t1", title: "Implement CSRF route checks" }
      ]
    }
  ]
)
```

Rules:
- Define all milestones and tasks upfront.
- Match the approved task IDs and titles exactly.
- Use short, stable IDs such as `m1`, `m1t1`, `m2t3`.
- Order milestones and tasks in execution order.
- Do not add new task IDs mid-mission; if a worker returns a partial result, continue under the same task ID.

**Completion criterion:** `mission_init` has been called once with the approved mission tree and verification mode retained in context.

### Step 2: Execute Milestones in Order

Before the first code-changing task in the mission, confirm the worktree is clean. If the worktree is not clean, stop and ask the user whether to clean it up, commit it, or switch to another workspace before proceeding.

**Completion criterion:** the orchestrator has confirmed a clean worktree before delegating the first code-changing task.

Work through milestones sequentially. Within a milestone, tasks may be parallelized if they are independent, but default to sequential unless parallelism is clearly safe.

For each task:

#### 2a. Mark the task in progress

```
mission_update_task(taskId: "m1t1", status: "in_progress")
```

**Completion criterion:** the task status is `in_progress` before any worker subagent receives the task.

#### 2b. Record the task's Git diff base

Before delegating a code-changing task, record the task's Git diff base so the validator can review only that task's diff.

Diff-base rule:
- Use the current Git state at the moment the task is marked `in_progress` as the task's diff base.
- Keep the task `in_progress` until validation is complete so later tasks do not overlap its diff window.
- If the task is read-only, record that no diff base is needed.

**Completion criterion:** the task's diff base is recorded in task context before delegation. If the task is read-only, record that no diff base is needed.

For precise clean-worktree and diff criteria, read [`REFERENCE.md`](REFERENCE.md#clean-worktree-and-task-diffs).

#### 2c. Delegate to a worker subagent

Before delegating, read current mission state and prior handoffs for the current milestone:

```
mission_read()
mission_read_handoffs()
```

Include in the worker prompt:
- The task ID and title.
- The verification mode.
- The full mission context from `mission_read`.
- Prior handoffs from `mission_read_handoffs`.
- Any relevant files, constraints, or prior results.
- The instruction to follow repo-required procedures from `AGENTS.md`.
- The instruction to run the task-level verification required by the verification mode.
- The instruction to call `mission_handoff` as the last action before reporting back.

Example worker prompt:
```
Your task is m1t1: "Implement token expiry handling".

Verification mode: standard

Mission context:
<paste mission_read output here>

Prior handoffs for this milestone:
<paste mission_read_handoffs output here, or "none yet" if first task>

Instructions:
- Implement the task
- Do not update mission state
- Follow any repo-required procedures from AGENTS.md for the code you touched
- Run the task-level verification required by verification mode `standard`
- Prefer updating existing tests or adding only the smallest number of high-value tests needed to prove the change
- Call mission_handoff as your last action before reporting back
- After calling mission_handoff, report your result to me
```

For worker reporting rules, read [`HANDOFF.md`](HANDOFF.md).

**Completion criterion:** the worker prompt includes every required context item and explicitly forbids mission state updates.

#### 2d. Record the worker result and derive the task diff

After the worker subagent calls `mission_handoff` and returns, read the handoff:

```
mission_read_handoffs(taskId: "m1t1")
```

Then derive `<TASK_DIFF>` from the recorded Git diff base:
1. Start with the concrete file paths listed in the handoff's `implemented` entries.
2. Compare only those paths between the recorded diff base and the current workspace state.
3. Include new files, deleted files, and renames if present.
4. Account for every implemented path in the validator input; if a path cannot be compared, state why.
5. If the handoff shows no file changes, pass an empty diff and let the validator review the handoff and verification evidence only.

**Completion criterion:** every implemented path is represented in `<MODIFIED_FILES>` and either appears in `<TASK_DIFF>` or has an explicit reason why no diff exists.

Keep the task `in_progress` while validation is pending. Use `failed` only if the worker subagent could not complete the task.

For diff criteria, read [`REFERENCE.md`](REFERENCE.md#clean-worktree-and-task-diffs).

#### 2e. Run the Scrutiny Validator

After every worker-completed task, spawn a Scrutiny Validator before proceeding.

Use the validator prompt and verdict rules in [`VALIDATOR.md`](VALIDATOR.md).

```
PASS              -> mark completed and proceed to next task
PASS WITH NOTES   -> mark completed with validator notes, then proceed
FAIL              -> keep or mark in_progress, spawn Fix worker subagent, re-run validator
```

When recording a validator result, append the verdict to the task notes.

**Completion criterion:** the task status is `completed` only after validator `PASS` or `PASS WITH NOTES`; validator `FAIL` leaves the task `in_progress` until a fix validates.

Example accepted completion update:

```
mission_update_task(
  taskId: "m1t1",
  status: "completed",
  notes: "Implemented token expiry handling with one focused regression test. Validator: PASS."
)
```

### Step 3: Review After Each Milestone

After all tasks in a milestone are done:

#### 3a. Run milestone verification for affected workspaces

Determine which workspaces were modified during this milestone by reviewing the concrete paths in task handoffs and task diffs.

Then verify only the affected workspaces according to the selected mode. For the mode-specific cadence, read [`VERIFICATION.md`](VERIFICATION.md#milestone-verification).

Do not run root-wide tests unless multiple workspaces were modified and there is no narrower equivalent.

If milestone verification fails, investigate before proceeding.

**Completion criterion:** every workspace touched by a handoff path has an appropriate milestone check result, or a recorded reason why no check applies.

#### 3b. Call mission_summary

```
mission_summary()
```

Review the output. If any tasks failed:
- Decide whether to retry, skip, or abort.
- Do not proceed to the next milestone with unresolved failures unless explicitly acceptable.

**Completion criterion:** all tasks in the milestone are `completed` or explicitly `skipped`, and unresolved failures have a recorded user-approved decision.

### Step 4: Complete the Mission

When all milestones are completed, run mission-end verification for the affected workspaces across the mission, then call `mission_summary` and report the outcome to the user.

For mission-end verification, read [`VERIFICATION.md`](VERIFICATION.md#mission-end-verification).

**Completion criterion:** mission-end verification has a recorded result for every affected workspace, `mission_summary` shows no unresolved task failures, and the user receives the final outcome.

---

## Quick Reference

```
-- Orchestrator ------------------------------------------------
Plan first         -> load plan-mission -> get approval + verification mode
Check existing     -> always mission_read() before mission_init
Start mission      -> mission_init(title, milestones)
Before delegate    -> mission_update_task(id, "in_progress")
Confirm clean tree -> before first code-changing task
Record diff base   -> current Git state for the task
Read handoffs      -> mission_read() + mission_read_handoffs()
After worker done  -> mission_read_handoffs(taskId: id)
Derive task diff   -> every implemented path accounted for
Validate task      -> spawn Scrutiny Validator before completed status
Record outcome     -> mission_update_task(id, "completed"|"failed"|"skipped", notes)
Milestone review   -> mode-aware verification for affected workspaces
Mission complete   -> mission-end verification, then mission_summary()

-- Worker subagent ---------------------------------------------
Run lean proof     -> smallest verification that proves the change
Keep test count low -> prefer existing coverage or 1-3 targeted tests
Last action        -> mission_handoff(...)
```

## Red Flags

Never:
- Call `mission_update_task` from a worker subagent.
- Skip `mission_handoff` at the end of a worker task.
- Overwrite an active mission without explicit user approval.
- Override the verification mode from the approved plan without explicit user approval.
- Mark a task `completed` before validator `PASS` or `PASS WITH NOTES`.
- Add task IDs after `mission_init`.
- Turn every task into a large new test matrix by default.
- Rerun the full verification stack in the validator when review evidence is already sufficient.
- Run root-wide test commands when a narrower affected-workspace command exists.

Always:
- Get an approved plan and verification mode first.
- Confirm a clean worktree before delegating the first code-changing task.
- Record the task's Git diff base before delegating code-changing work.
- Account for every implemented path in the task diff or explain why no diff exists.
- Include `mission_read` and `mission_read_handoffs` context in worker prompts.
- Tell worker subagents to follow `AGENTS.md`.
- Tell worker subagents to use the selected task-level verification mode.
- Keep verification proportional to risk.
- Append validator verdicts to task notes.
