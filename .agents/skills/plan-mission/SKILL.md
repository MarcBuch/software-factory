---
name: plan-mission
description: Decompose a complex goal into milestones and tasks with risk-based verification planning.
---

# Plan Mission

Use this skill to decompose work into a standalone plan, classify risk, select `fast`, `standard`, or `exhaustive` verification, and obtain explicit approval before creating executable mission state. Announce: “I'm using the plan-mission skill to structure this goal and size verification to the risk.”

## Planning

Describe intent, the overall change plan, risks, alternatives, acceptance criteria, and verification strategy. Executable milestones and tasks belong in the separate mission input used during materialization.

Present:

```markdown
## Mission Plan: <Goal Title>

Verification mode: fast | standard | exhaustive

### Milestone m1: <Title>

| ID   | Title   | Type           | Verification |
| ---- | ------- | -------------- | ------------ |
| m1t1 | <Title> | implementation | <proof>      |
```

`m1`, `m1t1`, etc. are stable presentation keys. They identify plan milestones and tasks before Factory assigns runtime IDs, and task dependencies use these keys. Ask, “Does this plan look right? Any changes before we proceed?” Then STOP. Do not invoke tools or persist anything in this turn. Preserve approval-first behavior: only on a subsequent turn after explicit approval invoke `factory`.

## Persisting an approved plan

After approval, write plan JSON containing `missionTitle`, `intent`, `changePlan`, `risks` (objects with `description` and `mitigation`), `alternatives` (objects with `name` and `rejectedBecause`), `acceptanceCriteria`, `verificationStrategy`, `verificationMode`, and optional `externalArtifacts`. Input files may be outside the Git project, but artifact paths remain repository-relative. Approval is the gate: do not generate architecture artifacts, create a plan, or materialize a mission before explicit approval.

Use `visualize-change` for architecture visualization. It owns the exact document structure, evidence rules, visual language, and direct HTML authoring. In the Factory planner workflow it writes `.factory/architecture/<run-id>.html`; return `plan` plus one matching declaration in `artifacts`. Factory only validates, attaches, and persists it.

Run the following ordered workflow, using each command's `--json` result and parsing its `.id` value (an agent may parse the tool output directly; `jq` is optional):

1. `factory plan create --input <plan.json> --json`; save `.id` as `planId`.
2. `factory plan approve "$planId" --json`; confirm the returned revision is approved.
3. Write mission input with `milestones[].{key,title,tasks[]}` and task fields `key,title,type,risk,verification,dependsOn`, then run `factory plan materialize "$planId" --input <mission-input.json> --json`; save `.id` as `missionId`. Task `type` is exactly `implementation` or `verification`; writing or running tests is verification work, not a separate `test` type.

Plan creation and approval write only `.factory/plans.jsonl`. Materialization requires the approved revision, resolves presentation keys to generated `mis_*`, `mil_*`, and `tsk_*` IDs, and writes one complete mission to `.factory/missions.jsonl`. The materialized mission stores `{ planId, revision }` as `sourcePlan`; it is the executable snapshot, while the plan remains the rationale and design record. If materialization fails after approval, retry `factory plan materialize "$planId" --input <mission-input.json>`; do not recreate the plan. Factory rejects duplicate materialization of the same plan revision.

## Rules

- Always classify risk and state verification mode.
- Always present the plan and STOP for approval.
- The Factory `planner` workflow is the exception: after exploration, load `visualize-change`, write the exact run artifact, and return the complete plan plus its artifact declaration. Factory validates the existing bytes and persists exactly one non-executable draft.
- Never call `mission_init` from this skill or begin implementation before approval.
- Keep verification proportional; explain any dedicated verification task.
- Do not create missions, milestones, or tasks directly in this workflow.
