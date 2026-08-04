import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, type ExecFileException } from "node:child_process";

const cli = join(import.meta.dir, "..", "src", "index.ts");
type CommandResult = { stdout: string; stderr: string; exitCode: number };
const temporaryRepositories = new Set<string>();

function run(cwd: string, ...args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile("bun", [cli, ...args], { cwd, encoding: "utf8" },
      (error: ExecFileException | null, stdout: string, stderr: string) => resolve({
        stdout,
        stderr,
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      }));
  });
}

async function repo() {
  const directory = await mkdtemp(join(tmpdir(), "factory-test-"));
  temporaryRepositories.add(directory);
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["init", "-q"], { cwd: directory }, (error) => error ? reject(error) : resolve());
  });
  const result = await run(directory, "mission", "init");
  expect(result.exitCode).toBe(0);
  return directory;
}

async function taskIn(directory: string, title = "T") {
  const mission = JSON.parse((await run(directory, "mission", "create", "--title", "M", "--json")).stdout);
  const milestone = JSON.parse((await run(directory, "mission", "milestone", "create", "--mission", mission.id, "--title", "S", "--json")).stdout);
  const task = JSON.parse((await run(directory, "mission", "task", "create", "--milestone", milestone.id, "--title", title, "--verification", "v", "--json")).stdout);
  return { mission, milestone, task };
}

async function stored(directory: string) {
  return (await readFile(join(directory, ".factory", "missions.jsonl"), "utf8")).trim().split("\n").slice(1).map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all([...temporaryRepositories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryRepositories.clear();
});

describe("factory CLI", () => {
  test("creates nested JSONL records and preserves metadata", async () => {
    const directory = await repo();
    const missionResult = await run(directory, "mission", "create", "--title", "M", "--json");
    const mission = JSON.parse(missionResult.stdout);
    const milestone = JSON.parse((await run(directory, "mission", "milestone", "create", "--mission", mission.id, "--title", "S", "--json")).stdout);
    const task = JSON.parse((await run(directory, "mission", "task", "create", "--milestone", milestone.id, "--title", "T", "--verification", "v", "--json")).stdout);

    const lines = (await readFile(join(directory, ".factory", "missions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ type: "metadata", schemaVersion: 1 });
    expect(lines[1].id).toBe(mission.id);
    expect(lines[1].milestones).toHaveLength(1);
    expect(lines[1].milestones[0].id).toBe(milestone.id);
    expect(lines[1].milestones[0].tasks).toEqual([task]);
    expect(lines.slice(1).every((line) => ![milestone.id, task.id].includes(line.id))).toBe(true);
  });

  test("supports list and show JSON", async () => {
    const directory = await repo();
    const created = JSON.parse((await run(directory, "mission", "create", "--title", "Shown", "--json")).stdout);
    const listed = await run(directory, "mission", "list", "--json");
    const shown = await run(directory, "mission", "show", created.id, "--json");
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
    expect(JSON.parse(listed.stdout)[0].id).toBe(created.id);
    expect(JSON.parse(shown.stdout).title).toBe("Shown");
  });

  test("preserves unrelated .gitignore content while changing tracking", async () => {
    const directory = await repo();
    const gitignore = join(directory, ".gitignore");
    await writeFile(gitignore, "node_modules/\n.factory/\ncustom-output\n");
    expect((await run(directory, "mission", "init")).exitCode).toBe(0);
    expect(await Bun.file(gitignore).text()).toBe("node_modules/\ncustom-output\n\n.factory/\n");
    expect((await run(directory, "mission", "init", "--track", "--json")).exitCode).toBe(0);
    expect(await Bun.file(gitignore).text()).toBe("node_modules/\ncustom-output\n");
    expect((await run(directory, "mission", "init", "--json")).exitCode).toBe(0);
    expect(await Bun.file(gitignore).text()).toBe("node_modules/\ncustom-output\n\n.factory/\n");
  });

  test("installs mission skills without overwriting existing skills", async () => {
    const directory = await repo();
    const installed = await run(directory, "mission", "init", "--skills", "--json");
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.stdout)).toMatchObject({ skillsInstalled: true });
    expect(await Bun.file(join(directory, ".agents", "skills", "plan-mission", "SKILL.md")).exists()).toBe(true);
    expect(await Bun.file(join(directory, ".agents", "skills", "run-mission", "SKILL.md")).exists()).toBe(true);
    const duplicate = await run(directory, "mission", "init", "--skills", "--json");
    expect(duplicate.exitCode).not.toBe(0);
    expect(JSON.parse(duplicate.stderr).error).toContain("Mission skill already exists");
  });

  test("recovers stale locks and reports bad relationships and corrupt stores as JSON", async () => {
    const directory = await repo();
    const badRelationship = await run(directory, "mission", "milestone", "create", "--mission", "mis_bad", "--title", "x", "--json");
    expect(badRelationship.exitCode).not.toBe(0);
    expect(JSON.parse(badRelationship.stderr)).toHaveProperty("error");
    const lock = join(directory, ".factory", "missions.lock");
    await writeFile(lock, JSON.stringify({ pid: 99999999, token: "foreign" }));
    await utimes(lock, new Date(0), new Date(0));
    const recovered = await run(directory, "mission", "create", "--title", "Recovered", "--json");
    expect(recovered.exitCode).toBe(0);
    expect(await Bun.file(lock).exists()).toBe(false);
    await writeFile(join(directory, ".factory", "missions.jsonl"), "bad\n");
    const corrupt = await run(directory, "mission", "list", "--json");
    expect(corrupt.exitCode).not.toBe(0);
    expect(JSON.parse(corrupt.stderr)).toHaveProperty("error");
  });

  test("fails outside a Git worktree", async () => {
    const result = await run(tmpdir(), "mission", "init", "--json");
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toContain("Git worktree");
  });

  test("creates missions concurrently without losing records", async () => {
    const directory = await repo();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      run(directory, "mission", "create", "--title", `Concurrent ${index}`, "--json")));
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    const lines = (await readFile(join(directory, ".factory", "missions.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(9);
    expect(JSON.parse(lines[0])).toEqual({ type: "metadata", schemaVersion: 1 });
    const missions = lines.slice(1).map((line) => JSON.parse(line));
    expect(new Set(missions.map((mission) => mission.title)).size).toBe(8);
    expect(missions.every((mission) => Array.isArray(mission.milestones))).toBe(true);
  });

  test("rejects legacy root command paths", async () => {
    const directory = await repo();
    for (const args of [["init"], ["list"], ["show", "mis_missing"], ["milestone", "create"], ["task", "create"]]) {
      const result = await run(directory, ...args, "--json");
      expect(result.exitCode).not.toBe(0);
    }
  });

  test("updates, closes, and reopens tasks with lifecycle metadata", async () => {
    const directory = await repo();
    const { task } = await taskIn(directory);
    const before = (await stored(directory))[0];
    const inProgress = await run(directory, "mission", "update", task.id, "--status", "in_progress", "--json");
    expect(inProgress.exitCode).toBe(0);
    expect(JSON.parse(inProgress.stdout)).toMatchObject({ id: task.id, status: "in_progress" });
    const middle = (await stored(directory))[0];
    expect(middle.milestones[0].tasks[0].status).toBe("in_progress");
    expect(middle.updatedAt).not.toBe(before.updatedAt);
    expect(middle.milestones[0].updatedAt).not.toBe(before.milestones[0].updatedAt);
    expect(middle.milestones[0].tasks[0].updatedAt).not.toBe(before.milestones[0].tasks[0].updatedAt);

    const closed = await run(directory, "mission", "close", task.id, "--reason", "completed", "--json");
    expect(closed.exitCode).toBe(0);
    expect(JSON.parse(closed.stdout)).toMatchObject({ id: task.id, status: "closed", closureReason: "completed" });
    const reopened = await run(directory, "mission", "update", task.id, "--status", "open", "--json");
    expect(reopened.exitCode).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({ id: task.id, status: "open" });
    expect(JSON.parse(reopened.stdout).closureReason).toBeUndefined();
    expect((await stored(directory))[0].milestones[0].tasks[0]).toMatchObject({ status: "open" });
    expect((await stored(directory))[0].milestones[0].tasks[0].closureReason).toBeUndefined();
  });

  test("rejects invalid and closed update statuses without modifying storage", async () => {
    const directory = await repo();
    const { task } = await taskIn(directory);
    const before = await Bun.file(join(directory, ".factory", "missions.jsonl")).text();
    const invalid = await run(directory, "mission", "update", task.id, "--status", "bogus", "--json");
    expect(invalid.exitCode).not.toBe(0);
    expect(JSON.parse(invalid.stderr).error).toContain("Invalid status");
    expect(await Bun.file(join(directory, ".factory", "missions.jsonl")).text()).toBe(before);
    const closed = await run(directory, "mission", "update", task.id, "--status", "closed", "--json");
    expect(closed.exitCode).not.toBe(0);
    expect(JSON.parse(closed.stderr).error).toContain("mission close");
    expect(await Bun.file(join(directory, ".factory", "missions.jsonl")).text()).toBe(before);
  });

  test("reports update and close task errors, and validates close reasons", async () => {
    const directory = await repo();
    const missingUpdate = await run(directory, "mission", "update", "tsk_missing", "--status", "open", "--json");
    expect(missingUpdate.exitCode).not.toBe(0);
    expect(JSON.parse(missingUpdate.stderr).error).toContain("Task not found");
    const missingReason = await run(directory, "mission", "close", "tsk_missing", "--json");
    expect(missingReason.exitCode).not.toBe(0);
    expect(missingReason.stderr).toContain("required option");
    const { task } = await taskIn(directory);
    const blank = await run(directory, "mission", "close", task.id, "--reason", "   ", "--json");
    expect(blank.exitCode).not.toBe(0);
    expect(JSON.parse(blank.stderr).error).toContain("Value must not be empty");
    const missingClose = await run(directory, "mission", "close", "tsk_missing", "--reason", "nope", "--json");
    expect(missingClose.exitCode).not.toBe(0);
    expect(JSON.parse(missingClose.stderr).error).toContain("Task not found");
  });

  test("lists ready tasks globally and by mission with complete context", async () => {
    const directory = await repo();
    const first = await taskIn(directory, "Open");
    const second = await taskIn(directory, "Closed");
    expect((await run(directory, "mission", "close", second.task.id, "--reason", "done")).exitCode).toBe(0);
    const global = await run(directory, "mission", "ready", "--json");
    expect(global.exitCode).toBe(0);
    const data = JSON.parse(global.stdout);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ missionId: first.mission.id, missionTitle: "M", milestoneId: first.milestone.id, milestoneTitle: "S", task: { id: first.task.id, title: "Open", status: "open" } });
    const scoped = await run(directory, "mission", "ready", "--mission", second.mission.id, "--json");
    expect(scoped.exitCode).toBe(0);
    expect(JSON.parse(scoped.stdout)).toEqual([]);
    const missing = await run(directory, "mission", "ready", "--mission", "mis_missing", "--json");
    expect(missing.exitCode).not.toBe(0);
    expect(JSON.parse(missing.stderr).error).toContain("Mission not found");
  });

  test("migrates a legacy task status on the next write", async () => {
    const directory = await repo();
    const { task } = await taskIn(directory, "Legacy");
    const file = join(directory, ".factory", "missions.jsonl");
    const records = await stored(directory);
    delete records[0].milestones[0].tasks[0].status;
    await writeFile(file, [JSON.stringify({ type: "metadata", schemaVersion: 1 }), ...records.map((record) => JSON.stringify(record))].join("\n") + "\n");
    const ready = await run(directory, "mission", "ready", "--json");
    expect(ready.exitCode).toBe(0);
    expect(JSON.parse(ready.stdout)[0].task).toMatchObject({ id: task.id, status: "open" });
    expect((await run(directory, "mission", "update", task.id, "--status", "open", "--json")).exitCode).toBe(0);
    expect((await stored(directory))[0].milestones[0].tasks[0].status).toBe("open");
  });
});
