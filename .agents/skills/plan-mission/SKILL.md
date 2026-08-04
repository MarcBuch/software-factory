---
name: plan-mission
description: Decompose a complex goal into milestones and tasks with risk-based verification planning.
---

# Plan Mission

Use this skill to decompose work, classify risk, select `fast`, `standard`, or `exhaustive` verification, and obtain explicit approval before execution. Announce: “I'm using the plan-mission skill to structure this goal and size verification to the risk.”

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

`m1`, `m1t1`, etc. are presentation references only. Ask, “Does this plan look right? Any changes before we proceed?” Then STOP. Do not invoke tools or persist anything in this turn. Preserve approval-first behavior: only on a subsequent turn after explicit approval invoke `factory`.

## Persisting an approved plan

Run the following ordered workflow, using each command's `--json` result and parsing its `.id` value (an agent may parse the tool output directly; `jq` is optional):

1. `factory mission create --title "<goal>" --verification-mode <mode> --json`; save `.id` as `missionId`.
2. For each milestone in plan order, run `factory milestone create --mission "$missionId" --title "<title>" --json`; save `.id` as `milestoneId`.
3. For each task in milestone order, run `factory task create --milestone "$milestoneId" --title "<title>" --type <implementation|verification> --risk <low|medium|high> --verification "<note>" --json`.
4. Use only generated `mis_*`, `mil_*`, and `tsk_*` IDs returned by JSON; never supply presentation IDs.

The CLI stores current state in `.factory/missions.jsonl`: line one is metadata/schema version, and every later line is one complete nested mission with all milestones and tasks. Child changes rewrite the parent mission line atomically; they are not event lines. `run-mission` compatibility remains separate: its current tooling and `.opencode/tools/mission.ts` are not migrated by this skill.

## Rules

- Always classify risk and state verification mode.
- Always present the plan and STOP for approval.
- Never call `mission_init` from this skill or begin implementation before approval.
- Keep verification proportional; explain any dedicated verification task.
