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
  const result = await run(directory, "init");
  expect(result.exitCode).toBe(0);
  return directory;
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
    const milestone = JSON.parse((await run(directory, "milestone", "create", "--mission", mission.id, "--title", "S", "--json")).stdout);
    const task = JSON.parse((await run(directory, "task", "create", "--milestone", milestone.id, "--title", "T", "--verification", "v", "--json")).stdout);

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
    const listed = await run(directory, "list", "--json");
    const shown = await run(directory, "show", created.id, "--json");
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
    expect(JSON.parse(listed.stdout)[0].id).toBe(created.id);
    expect(JSON.parse(shown.stdout).title).toBe("Shown");
  });

  test("preserves unrelated .gitignore content while changing tracking", async () => {
    const directory = await repo();
    const gitignore = join(directory, ".gitignore");
    await writeFile(gitignore, "node_modules/\n.factory/\ncustom-output\n");
    expect((await run(directory, "init")).exitCode).toBe(0);
    expect(await Bun.file(gitignore).text()).toBe("node_modules/\ncustom-output\n\n.factory/\n");
    expect((await run(directory, "init", "--track", "--json")).exitCode).toBe(0);
    expect(await Bun.file(gitignore).text()).toBe("node_modules/\ncustom-output\n");
    expect((await run(directory, "init", "--json")).exitCode).toBe(0);
    expect(await Bun.file(gitignore).text()).toBe("node_modules/\ncustom-output\n\n.factory/\n");
  });

  test("recovers stale locks and reports bad relationships and corrupt stores as JSON", async () => {
    const directory = await repo();
    const badRelationship = await run(directory, "milestone", "create", "--mission", "mis_bad", "--title", "x", "--json");
    expect(badRelationship.exitCode).not.toBe(0);
    expect(JSON.parse(badRelationship.stderr)).toHaveProperty("error");
    const lock = join(directory, ".factory", "missions.lock");
    await writeFile(lock, JSON.stringify({ pid: 99999999, token: "foreign" }));
    await utimes(lock, new Date(0), new Date(0));
    const recovered = await run(directory, "mission", "create", "--title", "Recovered", "--json");
    expect(recovered.exitCode).toBe(0);
    expect(await Bun.file(lock).exists()).toBe(false);
    await writeFile(join(directory, ".factory", "missions.jsonl"), "bad\n");
    const corrupt = await run(directory, "list", "--json");
    expect(corrupt.exitCode).not.toBe(0);
    expect(JSON.parse(corrupt.stderr)).toHaveProperty("error");
  });

  test("fails outside a Git worktree", async () => {
    const result = await run(tmpdir(), "init", "--json");
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
});
