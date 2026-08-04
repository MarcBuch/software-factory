# Worker Handoff Reference

Every worker subagent that performs a task or fixes a task must call `mission_handoff` as its last action before returning results to the orchestrator.

## Handoff Schema

```
mission_handoff(
  taskId: "m1t1",
  taskTitle: "Implement token expiry handling",
  milestoneId: "m1",
  implemented: [
    "apps/api/src/modules/auth/token.ts - tightened expiry handling",
    "apps/api/test/token-expiry.test.ts - updated coverage and added 1 focused regression"
  ],
  leftUndone: [],
  commands: [
    { cmd: "bun test apps/api/test/token-expiry.test.ts", exit: 0 },
    { cmd: "bun run check", exit: 0 }
  ],
  issues: [],
  proceduresFollowed: {
    readArchitectureMd: true,
    ranBaselineTests: true,
    noDirectDependencyEdits: true
  }
)
```

## Field Rules

**`implemented`**
- One entry per file or logical unit changed.
- Start each file-changing entry with a concrete repo-relative file path.
- Include a short description of what changed.
- Never leave empty unless the task genuinely produced no output.

**`leftUndone`**
- Be honest.
- Include the reason why something was not done.
- Empty array only if genuinely nothing was left undone.

**`commands`**
- Record every command run, in execution order.
- Use the full command as run.
- Record the actual exit code.

**`issues`**
- Record discoveries, gotchas, or structural findings.
- Empty array only if there are genuinely no issues to report.

**`proceduresFollowed`**

These map directly to the rules in `AGENTS.md`:

| Field | Rule |
|---|---|
| `readArchitectureMd` | Read `apps/api/ARCHITECTURE.md` before editing API code. |
| `ranBaselineTests` | Run whatever baseline test command `AGENTS.md` requires for the code you changed. |
| `noDirectDependencyEdits` | Use `bun install` / `bun remove` instead of editing dependency files directly. |

If a procedure was not applicable, set the boolean to `true` and explain in `note`. Only set `false` if the procedure was applicable but was not followed.

## Completion Criterion

The handoff is complete when every changed file path is listed under `implemented`, every command has an exit code, and every unmet requirement is listed under `leftUndone` or `issues`.
