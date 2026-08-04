---
name: commit
description: Create conventional git commits for the current work.
disable-model-invocation: true
---

# Commit

Create git commits after the user has explicitly asked for a commit. Run the workflow without an extra confirmation step unless the commit boundaries are ambiguous.

## Rules

- Commit only when the user has explicitly asked you to commit.
- Inspect `git status`, `git diff`, and `git log --oneline -10` before committing.
- Stage only intended files with explicit `git add <path ...>` commands. Never use `git add .` or `git add -A`.
- Do not stage or commit unrelated dirty files.
- Use conventional commit messages with a scope.
- Every commit must include a non-empty body that explains why the change was made.
- Write commit messages in the user's voice.
- Do not add tool or vendor attribution.
- Do not add co-author lines.

## Workflow

### Step 1: Inspect

- Review the conversation history to understand what changed and why.
- Run `git status`.
- Run `git diff`.
- Run `git log --oneline -10`.
- Identify whether the worktree contains unrelated changes you must leave untouched.

Done when you can name every file you plan to commit and every dirty file you plan to leave out.

### Step 2: Partition

- Group the intended changes into one or more atomic commits.
- Keep related files together.
- Exclude unrelated files from every commit.
- If a file contains mixed unrelated edits that cannot be safely committed together, stop and ask the user how to split it.
- If there are multiple reasonable commit groupings and the correct boundary is unclear from the conversation, stop and ask the user.

Done when every changed file is assigned to exactly one planned commit or explicitly excluded with a reason.

### Step 3: Draft

- Draft a conventional commit subject for each planned commit.
- Use a scope that matches the area being changed.
- Write a short body that explains the motivation, user need, bug, constraint, or tradeoff behind the change.

Done when each planned commit has a subject and a non-empty body that explains why, not just what.

### Step 4: Execute

- Stage only the files for the first planned commit with explicit `git add` paths.
- Create the commit.
- Repeat for remaining planned commits.

Done when all planned commits have been created and no excluded files were staged.

### Step 5: Verify

- Run `git status`.
- Run `git log --oneline -n <count>` for the number of commits you created.
- Report the created commits and any remaining uncommitted files.

Done when you have verified the new commits exist and surfaced any leftover worktree changes.

## Commit Format

```text
<type>(<scope>): <subject>

<body>
```

## Message Rules

- Prefer 1-3 short sentences in the body.
- Explain why the previous behavior, structure, or state was insufficient.
- For additions, explain the use case or capability being introduced.
- For removals, explain why the old behavior or code was no longer wanted.

## Types

- `feat`: new feature
- `fix`: bug fix
- `docs`: documentation change
- `chore`: maintenance or project housekeeping
- `refactor`: structural code change without feature or bug behavior change
- `test`: test change

## Scopes

- API changes: `(api/[topic])`
- Web changes: `(web/[topic])`
- Shared contracts: `(contracts/[topic])`

Examples:

- `(api/authentication)`
- `(web/dashboard)`
- `(web/components/button)`

## Example

`feat(web/excel-upload): add excel upload validation`

```text
Prevent invalid spreadsheet formats from reaching the import flow.
This gives users earlier feedback in the UI and reduces avoidable backend validation failures.
```
