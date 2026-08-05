---
name: plan-mission
description: Decompose a complex goal into milestones and tasks with risk-based verification planning.
---

# Plan Mission

Use this skill to decompose work into a standalone plan, classify risk, select `fast`, `standard`, or `exhaustive` verification, and obtain explicit approval before creating executable mission state. Announce: “I'm using the plan-mission skill to structure this goal and size verification to the risk.”

## Planning

Break the goal into implementation units. For each, record inputs, mutated state, invariants, risk, and the smallest meaningful verification. Prefer 1–3 focused tests or a narrow manual check. Dedicated verification tasks are exceptional: use them for high-risk, cross-system, large, or explicitly adversarial work. Do not automatically add a full-suite task.

Present:

```markdown
## Mission Plan: <Goal Title>
Verification mode: fast | standard | exhaustive
### Milestone m1: <Title>
| ID | Title | Type | Verification |
|----|-------|------|--------------|
| m1t1 | <Title> | implementation | <proof> |
```

`m1`, `m1t1`, etc. are stable presentation keys. They identify plan milestones and tasks before Factory assigns runtime IDs, and task dependencies use these keys. Ask, “Does this plan look right? Any changes before we proceed?” Then STOP. Do not invoke tools or persist anything in this turn. Preserve approval-first behavior: only on a subsequent turn after explicit approval invoke `factory`.

## Persisting an approved plan

After approval, write the complete plan JSON to a file inside the repository. It must include the mission title, verification mode, rich sections, ordered milestone keys/titles, and task keys with title, type, risk, verification, and presentation-key dependencies.

Run the following ordered workflow, using each command's `--json` result and parsing its `.id` value (an agent may parse the tool output directly; `jq` is optional):

1. `factory plan create --input <plan.json> --json`; save `.id` as `planId`.
2. `factory plan approve "$planId" --json`; confirm the returned revision is approved.
3. `factory plan materialize "$planId" --json`; save `.id` as `missionId`.

Plan creation and approval write only `.factory/plans.jsonl`. Materialization requires the approved revision, resolves presentation keys to generated `mis_*`, `mil_*`, and `tsk_*` IDs, and writes one complete mission to `.factory/missions.jsonl`. The materialized mission stores `{ planId, revision }` as `sourcePlan`; it is the executable snapshot, while the plan remains the rationale and design record. If materialization fails after approval, retry `factory plan materialize "$planId"`; do not recreate the plan. Factory rejects duplicate materialization of the same plan revision.

## Rules

- Always classify risk and state verification mode.
- Always present the plan and STOP for approval.
- Never call `mission_init` from this skill or begin implementation before approval.
- Keep verification proportional; explain any dedicated verification task.
- Do not create missions, milestones, or tasks directly in this workflow.
