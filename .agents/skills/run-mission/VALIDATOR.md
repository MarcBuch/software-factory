# Scrutiny Validator Reference

After every worker-finished task, spawn a **Scrutiny Validator** subagent before closing the task.

## What The Validator Does

The validator is a reviewer only: it returns a verdict and findings. It never
runs lifecycle mutations or closes tasks. After receiving the verdict, the
**ORCHESTRATOR** alone runs the corresponding `factory mission close <tsk_...>
--reason "Validator: PASS..."` command.

1. **Review first**
   - Review the worker's reported changes and verification results.
   - Review only the task-scoped diff.
   - Compare the claimed commands and results against the size and risk of the change.

2. **Re-run commands only when warranted**
   Re-run the smallest useful verification only if one of these is true:
   - The worker omitted required verification for the selected mode.
   - The worker reported a failing or flaky command.
   - The diff and the verification evidence do not match.
   - The task is high-risk and the validator needs to confirm one critical command.

3. **Code review**
   Assess findings with a severity:
   - `critical`: correctness bug or security hole.
   - `major`: type unsafety, incorrect assertion, misleading invariant.
   - `minor`: hygiene, missing assertion, weak proof.
   - `nit`: duplication, naming, comment accuracy.

## Verdict Rules

| Verdict           | Condition                                                                     | Action                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`            | Review is clean and verification evidence is sufficient.                      | Return `PASS`; the ORCHESTRATOR runs `factory mission close <tsk_...> --reason "Validator: PASS"`.                                |
| `PASS WITH NOTES` | Only minor or nit findings.                                                   | Return `PASS WITH NOTES`; the ORCHESTRATOR runs `factory mission close <tsk_...> --reason "Validator: PASS WITH NOTES: <notes>"`. |
| `FAIL`            | Missing proof, unsuccessful required verification, or critical/major finding. | Keep task `in_progress`, spawn Fix worker subagent, then re-validate.                                                             |

## Scrutiny Validator Prompt Template

Use this template when spawning the validator. Fill in `<TASK_ID>`, `<TASK_TITLE>`, `<VERIFICATION_MODE>`, `<MODIFIED_FILES>`, and `<TASK_DIFF>`:

```
You are the Scrutiny Validator for task <TASK_ID>: "<TASK_TITLE>".

Verification mode: <VERIFICATION_MODE>

## Step 1: Review the evidence
- Read the worker's reported changes and verification results
- Review the modified files list:
  <MODIFIED_FILES>
- Review only the diff below:
  <TASK_DIFF>

## Step 2: Decide whether to rerun anything
Re-run only the smallest useful command set if the worker evidence is missing, failing, suspicious, or too weak for the task risk.
Record every command you run and its exit code.

## Step 3: Report
1. Verification evidence review
2. Any commands re-run, with pass/fail results
3. Code review findings with severity and file:line
4. Overall verdict: PASS | PASS WITH NOTES | FAIL
```

## Fix Subagent

When the validator returns `FAIL`:

1. Keep or mark the task `in_progress`.
2. Spawn a Fix worker subagent with the validator's full findings as input.
3. After the fix subagent completes, re-spawn the validator.
4. Repeat until `PASS` or `PASS WITH NOTES`, or stop and ask the user if progress is blocked.

Completion criterion: the validator returns `PASS` or `PASS WITH NOTES`; only then may the ORCHESTRATOR run the corresponding `factory mission close` command with the validator verdict in its reason.
