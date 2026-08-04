---
name: plan-mission
description: Decompose a complex goal into milestones and tasks with risk-based verification planning.
---

# Plan Mission

## Overview

This skill produces a structured mission plan that the user approves before execution begins. The default plan is implementation-first with lean verification. Dedicated verification tasks are added only when risk, cross-cutting scope, or an explicit user request justifies them.

**Announce at start:** "I'm using the plan-mission skill to structure this goal and size verification to the risk."

A mission plan ensures that:
1. The goal is decomposed into manageable, sequential units
2. Verification is proportional to the change instead of defaulting to exhaustive test expansion
3. The user can review and adjust the plan before any work begins
4. Execution via `run-mission` follows a plan the user has already approved

---

## When to use

- **Before starting a `run-mission` execution**
- **Standalone, to plan without immediate execution**

---

## Phase 0a: Decompose the goal

### Step 1: Identify implementation units

Break the goal into discrete, atomic units of work. Each unit typically corresponds to:
- A new route, screen, component, or endpoint
- A new module or service-layer function
- A business rule or validation rule
- A state mutation or persistence change
- A cross-cutting concern such as middleware or auth handling

For each unit, describe:
- **What it does:** one sentence
- **What it accepts:** inputs and constraints
- **What state it mutates:** DB tables, caches, session state, files, contracts
- **What invariants it upholds:** things that must remain true

### Step 2: Classify each unit by risk

For every unit, ask: **What is the verification risk level?**

**Low risk:**
- Refactors with no intended behavior change
- Presentation-only changes
- Small wiring changes with strong existing coverage
- Narrow validation changes with obvious local effects

**Medium risk:**
- Non-trivial behavior changes
- State mutations
- Data transformation logic
- Changes that could break a nearby workflow

**High risk:**
- Auth, permissions, security boundaries
- Money movement or billing
- Cross-workspace contract changes
- Concurrency-sensitive or migration-sensitive work
- Anything the user explicitly calls critical

Write down the risk level. It drives how much verification the mission should plan.

### Step 3: Choose the mission verification mode

Every plan must specify one verification mode for `run-mission`:
- **`fast`**: default. Prefer the narrowest proof that the change works.
- **`standard`**: add a bit more routine verification when the change is medium-risk.
- **`exhaustive`**: use only for high-risk or explicitly requested work.

Default to `fast` unless the user asked for heavy validation or the work is clearly high-risk.

---

## Phase 0b: Verification planning

For each implementation unit, choose the **smallest verification that can prove the change**.

Preferred options, in order:
1. Update an existing focused test
2. Add 1-3 new targeted regression tests
3. Run one narrow command that exercises the changed behavior
4. Add a dedicated verification task only if the verification is large, cross-cutting, expensive, or needs a separate specialist pass

### Dedicated verification task rule

A separate verification task is warranted only when at least one is true:
- The unit is high-risk and needs a distinct security or integration pass
- The verification touches a different workspace or system than the implementation
- The verification is large enough that bundling it into the implementation task would blur completion
- The user explicitly asked for adversarial, exhaustive, or hardening-focused testing

Default to **zero dedicated verification tasks** for low- and medium-risk units.

### Scenario analysis depth

Do not force every unit through a full adversarial matrix.

- **Low risk:** verify the happy path and the one most plausible regression
- **Medium risk:** reason through only the failure categories that are plausibly affected
- **High risk or explicit hardening work:** reason through all relevant adversarial scenarios, and create a dedicated verification task if that work is substantial

### Test budget rule

Unless the user asked for exhaustive coverage, prefer modifying existing tests or adding **at most 1-3 high-value targeted tests per implementation unit**. Exceed that only when:
- A reproduced bug needs a matrix of cases
- The unit is high-risk and the extra cases materially protect a boundary
- The user explicitly asks for broader coverage

---

## Phase 0c: Structure the plan

### Rules for structuring milestones and tasks

1. **Implementation tasks are the default.** Most units should be represented by one implementation task with a short verification note.
2. **Dedicated verification tasks are the exception.** Add one only when the dedicated verification task rule above is met.
3. **Keep verification close to the work.** If a dedicated verification task exists, place it immediately after the implementation task it validates.
4. **Do not automatically add multiple adversarial test tasks per unit.** One dedicated verification task is the default ceiling unless the user explicitly wants exhaustive coverage.
5. **Do not automatically add `Run full test suite and verify` as a mission task.** `run-mission` owns milestone and mission-end verification cadence. Add a visible verification task only if the user wants it as an explicit checkpoint.
6. **Use short, stable IDs**: `m<N>` for milestones and `m<N>t<N>` for tasks.

### Task naming

- Implementation tasks: descriptive verb phrase, such as `Implement token expiry handling`
- Dedicated verification tasks: specific verification scope, such as `Verify token expiry edge cases`

---

## Phase 0d: Present and await approval

### Output format

Produce the plan in this markdown structure and **STOP**. Do not proceed until the user explicitly approves.

```markdown
## Mission Plan: <Goal Title>

Verification mode: fast | standard | exhaustive

### Milestone m1: <Title>

| ID | Title | Type | Verification |
|----|-------|------|--------------|
| m1t1 | <Implementation task> | implementation | <Update existing test / add 1 targeted test / narrow manual check> |
| m1t2 | <Dedicated verification task, if warranted> | verification | <Why it exists> |

### Milestone m2: <Title>

| ID | Title | Type | Verification |
|----|-------|------|--------------|
| m2t1 | <Implementation task> | implementation | <Narrowest proof of change> |

Notes:
- <Any high-risk area that justifies heavier verification>
- <Any unit intentionally kept lean, and why>
```

### Approval protocol

1. Present the full plan with milestones, tasks, and verification notes
2. Ask: `Does this plan look right? Any changes before we proceed to mission_init?`
3. Wait for explicit user approval
4. If changes are requested, revise and re-present
5. After approval, tell the user `run-mission` will initialize the mission with this structure and verification mode

---

## Rules

### Never

- Force every logic/behavior unit into separate adversarial test tasks
- Default to `exhaustive` verification without a risk reason or explicit request
- Add multiple verification tasks for one unit unless the user wants exhaustive coverage
- Present a plan without waiting for user approval
- Call `mission_init` from this skill
- Begin implementation from this skill

### Always

- Classify each unit by risk before choosing verification depth
- Pick the leanest verification mode that matches the risk
- State the verification mode explicitly in the plan
- Give every implementation task a short verification note
- Explain why any dedicated verification task exists
- Match the approved task IDs and titles exactly when `run-mission` calls `mission_init`

---

## Example: Auth hardening

**Goal:** Improve token expiry handling and CSRF checks.

**Chosen verification mode:** `standard`

```markdown
## Mission Plan: Auth hardening

Verification mode: standard

### Milestone m1: Token handling

| ID | Title | Type | Verification |
|----|-------|------|--------------|
| m1t1 | Implement token expiry handling | implementation | Update token expiry tests and add 1 targeted expired-token regression |
| m1t2 | Verify token expiry edge cases | verification | High-risk auth boundary; run a focused edge-case pass after implementation |

### Milestone m2: CSRF flow

| ID | Title | Type | Verification |
|----|-------|------|--------------|
| m2t1 | Implement CSRF route checks | implementation | Add 1 focused request-validation test and run the narrowest relevant integration command |

Notes:
- Token expiry gets a dedicated verification task because auth handling is high-risk.
- CSRF work stays lean because the changed surface is narrow and can be proven inside the implementation task.
```

---

## Quick Reference

```
── Planning ──────────────────────────────────────────────────
Phase 0a          → decompose goal into units → classify risk
Phase 0b          → choose smallest verification that proves each unit
Phase 0c          → structure milestones and tasks → dedicated verification only when justified
Phase 0d          → present plan → wait for user approval → stop

── Verification depth ───────────────────────────────────────
fast              → default; narrow proof only
standard          → medium-risk routine work
exhaustive        → high-risk or explicitly requested

── Task structure ───────────────────────────────────────────
Default           → implementation tasks with verification notes
Dedicated verification → only when risk, scope, or cost justifies it
Avoid             → one implementation unit exploding into multiple adversarial tasks by default
```
