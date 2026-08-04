# Mission Reference

This is disclosed reference for `run-mission`. Read it when handling IDs, statuses, clean-worktree checks, task diffs, or failures.

## IDs

| Level | Format | Example |
|---|---|---|
| Milestone | `m<N>` | `m1`, `m2`, `m3` |
| Task | `m<N>t<N>` | `m1t1`, `m1t2`, `m2t3` |

Keep IDs short and stable. Do not reuse IDs within a mission. Do not create new IDs after `mission_init`; continue partial or fix work under the same task ID.

## Statuses

| Status | Meaning |
|---|---|
| `pending` | Not started. |
| `in_progress` | Delegated, awaiting worker result, awaiting validation, or being fixed. |
| `completed` | Worker result is accepted and required validation has passed. |
| `failed` | Worker subagent could not complete the task. |
| `skipped` | Intentionally bypassed. |

Milestone and mission status are derived automatically.

## Clean-Worktree And Task Diffs

The mission's code-changing work starts from a clean worktree. Each task records a Git diff base so the validator can review task-scoped changes.

Clean-worktree criteria:
- Before the first code-changing task, the worktree is clean.
- If the worktree is not clean, the orchestrator stops and asks the user how to proceed.

Diff-base criteria:
- The task's Git diff base is recorded before delegation.
- The task stays `in_progress` until validation finishes so later tasks do not overlap its diff window.
- If no diff base is needed because the task is read-only, that decision is recorded.

Task diff criteria:
- Start from concrete repo-relative paths in the handoff's `implemented` entries.
- Compare those paths between the recorded diff base and the current workspace state.
- Include new files, deleted files, and renames.
- Restrict the diff to implemented paths unless validator context requires an explicitly named support file.
- Every implemented path appears in `<MODIFIED_FILES>`.
- Every implemented path either appears in `<TASK_DIFF>` or has an explicit reason why no diff exists, such as read-only output or a generated file intentionally excluded from review.

If an `implemented` entry describes a logical unit without a file path, derive concrete paths from the current workspace before validation. If concrete paths cannot be derived, treat the handoff as incomplete and ask the worker to clarify before validation.

## Failure Handling

| Situation | Action |
|---|---|
| Task failed, retryable | Mark `failed` with notes, then re-delegate when ready. |
| Task failed, non-blocking | Mark `skipped` with reason, continue. |
| Task failed, blocks milestone | Stop, report to user, wait for guidance. |
| Worker subagent returns partial result | Keep the same task `in_progress`, delegate follow-up work against the same task ID, and do not create new task IDs mid-mission. |
| Scrutiny Validator returns `FAIL` | Keep or mark `in_progress`, spawn Fix worker subagent, re-validate. |

Do not proceed to the next milestone with unresolved failures unless explicitly acceptable.
