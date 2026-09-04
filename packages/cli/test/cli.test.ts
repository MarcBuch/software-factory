import { afterEach, describe, expect, test } from "bun:test";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlanInputSchema } from "@software-factory/contracts";

import {
  deletePlanCascade,
  resolveDependencies,
  PlanSchema,
  validatePlansAgainstMissions,
} from "../src/plans";
import { parseUiBackend } from "../src/ui";

const cli = join(import.meta.dir, "..", "src", "index.ts"),
  repos = new Set<string>();

test("changePlanSteps requires non-empty entries", () => {
  const base = {
    missionTitle: "Mission",
    intent: "Intent",
    changePlan: "Plan",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["Done"],
    verificationStrategy: "Check",
    verificationMode: "fast" as const,
  };
  expect(() => PlanInputSchema.parse({ ...base, changePlanSteps: [] })).toThrow();
  expect(() => PlanInputSchema.parse({ ...base, changePlanSteps: [" "] })).toThrow();
  expect(
    PlanInputSchema.parse({ ...base, changePlanSteps: ["First", "Second"] }).changePlanSteps,
  ).toEqual(["First", "Second"]);
});

test("the retired v2-sdk backend is rejected instead of aliased", () => {
  expect(() => parseUiBackend("v2-sdk")).toThrow(
    'The "v2-sdk" UI backend is no longer supported; use "v2-client" instead.',
  );
  expect(parseUiBackend("v2-client")).toBe("v2-client");
});

test("plan cascade deletion removes all revisions and linked missions only", () => {
  const plan = PlanSchema.parse({
    id: "pln_cascade",
    missionTitle: "M",
    intent: "I",
    changePlan: "C",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["done"],
    verificationStrategy: "verify",
    verificationMode: "fast",
    revision: 1,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const result = deletePlanCascade(
    [
      plan,
      {
        ...plan,
        revision: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    [
      { sourcePlan: { planId: plan.id, revision: 1 } },
      { sourcePlan: { planId: plan.id, revision: 2 } },
      { sourcePlan: { planId: "pln_other", revision: 1 } },
      { external: true },
    ],
    plan.id,
  );
  expect(result.plans).toEqual([]);
  expect(result.missions).toEqual([
    { sourcePlan: { planId: "pln_other", revision: 1 } },
    { external: true },
  ]);
  expect(() => deletePlanCascade([plan], [], "pln_missing")).toThrow("Plan not found");
});
function run(
  cwd: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) =>
    execFile(
      "bun",
      [cli, ...args],
      { cwd, encoding: "utf8" },
      (e: ExecFileException | null, stdout: string, stderr: string) =>
        resolve({ stdout, stderr, exitCode: e ? (typeof e.code === "number" ? e.code : 1) : 0 }),
    ),
  );
}
async function repo() {
  const d = await mkdtemp(join(tmpdir(), "factory-"));
  repos.add(d);
  await new Promise<void>((r, j) =>
    execFile("git", ["init", "-q"], { cwd: d }, (e) => (e ? j(e) : r())),
  );
  await new Promise<void>((r, j) =>
    execFile("git", ["config", "commit.gpgsign", "false"], { cwd: d }, (e) => (e ? j(e) : r())),
  );
  expect((await run(d, "mission", "init")).exitCode).toBe(0);
  return d;
}
const sections = {
  context: "c",
  intent: "i",
  approach: "a",
  executionDesign: "e",
  implementationDetails: "d",
  alternatives: [],
  risks: [],
  acceptance: ["done"],
};

test("workflow help documents storage and worktree assumptions", async () => {
  const help = await run(tmpdir(), "workflow", "--help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain(".factory");
  expect(help.stdout).toContain("exclusive worktree access");
  expect(help.stdout).toContain("run");
  expect(help.stdout).toContain("status");
  expect(help.stdout).toContain("trace");
  expect(help.stdout).toContain("stop");
});

test("CLI rejects v2-sdk before resolving the project or starting the UI", async () => {
  const d = await mkdtemp(join(tmpdir(), "factory-cli-backend-"));
  repos.add(d);
  const result = await run(d, "ui", "--backend", "v2-sdk");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('use "v2-client" instead');
  expect(result.stderr).not.toContain("listening at");
  await expect(readdir(join(d, ".factory"))).rejects.toThrow();
});

async function planInput(d: string) {
  const f = join(d, "plan.json");
  await writeFile(
    f,
    JSON.stringify({
      missionTitle: "Standalone",
      verificationMode: "exhaustive",
      intent: "i",
      changePlan: "a",
      risks: [],
      alternatives: [],
      acceptanceCriteria: ["done"],
      verificationStrategy: "e",
    }),
  );
  return f;
}
async function externalJson(value: unknown, name: string) {
  const f = join(await mkdtemp(join(tmpdir(), "factory-input-")), name);
  await writeFile(f, JSON.stringify(value));
  return f;
}
async function missionInput(d: string) {
  const f = join(d, "mission-input.json");
  await writeFile(
    f,
    JSON.stringify({
      title: "Standalone",
      milestones: [
        {
          key: "build",
          title: "Build",
          tasks: [
            {
              key: "one",
              title: "One",
              type: "implementation",
              risk: "high",
              verification: "verify one",
              dependsOn: [],
            },
            {
              key: "two",
              title: "Two",
              type: "verification",
              risk: "low",
              verification: "verify two",
              dependsOn: ["one"],
            },
          ],
        },
      ],
    }),
  );
  return f;
}
async function materialize(d: string, id: string) {
  return run(d, "plan", "materialize", id, "--input", await missionInput(d), "--json");
}
describe("standalone plans", () => {
  test("plan delete atomically cascades persisted revisions and missions", async () => {
    const d = await repo(),
      input = await planInput(d),
      target = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout),
      unrelated = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    await run(d, "plan", "approve", target.id, "--json");
    const linked = JSON.parse((await materialize(d, target.id)).stdout),
      planFile = join(d, ".factory/plans.jsonl"),
      missionFile = join(d, ".factory/missions.jsonl"),
      plans = (await readFile(planFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    plans[1].status = "superseded";
    plans[1].approvedAt = plans[1].updatedAt;
    plans.push({ ...plans[1], revision: 2, status: "draft", approvedAt: undefined });
    delete plans.at(-1).approvedAt;
    const secondMission = {
      ...linked,
      id: `mis_${"2".repeat(32)}`,
      milestones: [],
      sourcePlan: { planId: target.id, revision: 2 },
    };
    await writeFile(planFile, plans.map((value) => JSON.stringify(value)).join("\n") + "\n");
    await writeFile(
      missionFile,
      [
        JSON.stringify({ type: "metadata", schemaVersion: 1 }),
        JSON.stringify(linked),
        JSON.stringify(secondMission),
      ].join("\n") + "\n",
    );
    await run(d, "mission", "create", "--title", "Unrelated", "--json");
    await run(d, "plan", "approve", unrelated.id, "--json");
    const deleted = await run(d, "plan", "delete", target.id, "--json");
    expect(deleted.exitCode).toBe(0);
    expect(JSON.parse(deleted.stdout)).toEqual({
      deleted: true,
      planId: target.id,
      revisionsDeleted: 2,
      missionsDeleted: 2,
    });
    expect((await readFile(planFile, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
    expect((await run(d, "plan", "list", "--json")).stdout).not.toContain(target.id);
    expect((await run(d, "plan", "list", "--json")).stdout).toContain(unrelated.id);
    expect((await run(d, "mission", "list", "--json")).stdout).not.toContain(target.id);
    expect((await run(d, "mission", "list", "--json")).stdout).toContain("mis_");
  });

  test("concurrent plan deletes serialize and preserve external artifacts", async () => {
    const d = await repo();
    const input = await planInput(d);
    const artifact = join(d, "plan-notes.md");
    await writeFile(artifact, "keep this repository file\n");
    const planInputValue = JSON.parse(await readFile(input, "utf8"));
    planInputValue.externalArtifacts = [{ path: "plan-notes.md", label: "Notes" }];
    await writeFile(input, JSON.stringify(planInputValue));
    const target = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    const unrelated = JSON.parse(
      (await run(d, "plan", "create", "--input", await planInput(d), "--json")).stdout,
    );
    await run(d, "plan", "approve", target.id, "--json");
    expect((await materialize(d, target.id)).exitCode).toBe(0);

    const lock = join(d, ".factory/factory.lock");
    const contentionDir = await mkdtemp(join(tmpdir(), "factory-lock-ready-"));
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "test-lock" }));
    const startDelete = () => {
      let child!: ReturnType<typeof execFile>;
      const result = new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          child = execFile(
            "bun",
            [cli, "plan", "delete", target.id, "--json"],
            {
              cwd: d,
              encoding: "utf8",
              env: { ...process.env, FACTORY_TEST_LOCK_CONTENTION_READY_DIR: contentionDir },
            },
            (error, stdout, stderr) =>
              resolve({
                stdout,
                stderr,
                exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              }),
          );
        },
      );
      return { child, result };
    };
    const first = startDelete();
    const second = startDelete();
    let released = false;
    let results: Awaited<typeof first.result>[] = [];
    try {
      while ((await readdir(contentionDir)).length < 2)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await readdir(contentionDir)).length).toBe(2);
      expect(await Bun.file(lock).exists()).toBe(true);
      await rm(lock);
      released = true;
      results = await Promise.all([first.result, second.result]);
    } finally {
      await rm(lock, { force: true });
      if (!released) {
        first.child.kill();
        second.child.kill();
      }
      await Promise.allSettled([first.result, second.result]);
      await rm(contentionDir, { recursive: true, force: true });
    }
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1);
    expect((await run(d, "plan", "list", "--json")).stdout).not.toContain(target.id);
    expect((await run(d, "plan", "list", "--json")).stdout).toContain(unrelated.id);
    expect((await run(d, "mission", "list", "--json")).stdout).not.toContain(target.id);
    expect(await readFile(artifact, "utf8")).toBe("keep this repository file\n");
  });

  test("missing and failed plan deletes preserve both stores", async () => {
    const d = await repo(),
      input = await planInput(d),
      plan = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout),
      planFile = join(d, ".factory/plans.jsonl"),
      missionFile = join(d, ".factory/missions.jsonl"),
      beforePlans = await readFile(planFile),
      beforeMissions = await readFile(missionFile);
    expect((await run(d, "plan", "delete", "pln_missing", "--json")).exitCode).not.toBe(0);
    expect(await readFile(planFile)).toEqual(beforePlans);
    expect(await readFile(missionFile)).toEqual(beforeMissions);
    const failed = await new Promise<{ exitCode: number }>((resolve) =>
      execFile(
        "bun",
        [cli, "plan", "delete", plan.id, "--json"],
        {
          cwd: d,
          env: { ...process.env, FACTORY_TEST_FAIL_PLAN_CASCADE: "after-plans" },
        },
        (error) => resolve({ exitCode: error ? 1 : 0 }),
      ),
    );
    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(planFile)).toEqual(beforePlans);
    expect(await readFile(missionFile)).toEqual(beforeMissions);
  });

  test("invalid remaining mission relationships abort deletion atomically", async () => {
    const d = await repo(),
      input = await planInput(d),
      plan = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout),
      planFile = join(d, ".factory/plans.jsonl"),
      missionFile = join(d, ".factory/missions.jsonl");
    expect((await run(d, "mission", "create", "--title", "Unrelated", "--json")).exitCode).toBe(0);
    const missionLines = (await readFile(missionFile, "utf8")).trim().split("\n");
    await writeFile(missionFile, `${missionLines.join("\n")}\n${missionLines[1]}\n`);
    const beforePlans = await readFile(planFile),
      beforeMissions = await readFile(missionFile),
      deleted = await run(d, "plan", "delete", plan.id, "--json");
    expect(deleted.exitCode).not.toBe(0);
    expect(await readFile(planFile)).toEqual(beforePlans);
    expect(await readFile(missionFile)).toEqual(beforeMissions);
  });

  test("non-delete plan reads recover a stale cascade journal first", async () => {
    const d = await repo(),
      input = await planInput(d),
      plan = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout),
      planFile = join(d, ".factory/plans.jsonl"),
      missionFile = join(d, ".factory/missions.jsonl"),
      journal = join(d, ".factory/plan-cascade.transaction.json"),
      canonicalRoot = await realpath(d),
      originalPlans = await readFile(planFile, "utf8"),
      originalMissions = await readFile(missionFile, "utf8"),
      recoveredPlans = `${JSON.stringify({ type: "plans-metadata", schemaVersion: 1 })}\n`;
    await writeFile(
      journal,
      JSON.stringify({
        phase: "committed",
        planFile: join(canonicalRoot, ".factory/plans.jsonl"),
        missionFile: join(canonicalRoot, ".factory/missions.jsonl"),
        originalPlans: { present: true, data: originalPlans },
        originalMissions: { present: true, data: originalMissions },
        planData: { present: true, data: recoveredPlans },
        missionData: { present: true, data: originalMissions },
      }),
    );
    await writeFile(planFile, recoveredPlans);
    const listed = await run(d, "plan", "list", "--json");
    expect(listed).toMatchObject({ exitCode: 0 });
    expect(listed.stdout).toBe("[]\n");
    expect(await Bun.file(journal).exists()).toBe(false);
    expect((await run(d, "plan", "show", plan.id, "--json")).exitCode).not.toBe(0);
  });

  test("nested worktree readers recover stale cascade state", async () => {
    const d = await repo(),
      nested = join(d, "nested", "worktree"),
      input = await planInput(d),
      plan = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout),
      planFile = join(d, ".factory/plans.jsonl"),
      missionFile = join(d, ".factory/missions.jsonl"),
      journal = join(d, ".factory/plan-cascade.transaction.json"),
      canonicalRoot = await realpath(d),
      originalPlans = await readFile(planFile, "utf8"),
      originalMissions = await readFile(missionFile, "utf8"),
      recoveredPlans = `${JSON.stringify({ type: "plans-metadata", schemaVersion: 1 })}\n`;
    await mkdir(nested, { recursive: true });
    await writeFile(
      journal,
      JSON.stringify({
        phase: "committed",
        planFile: join(canonicalRoot, ".factory/plans.jsonl"),
        missionFile: join(canonicalRoot, ".factory/missions.jsonl"),
        originalPlans: { present: true, data: originalPlans },
        originalMissions: { present: true, data: originalMissions },
        planData: { present: true, data: recoveredPlans },
        missionData: { present: true, data: originalMissions },
      }),
    );
    await writeFile(planFile, recoveredPlans);
    const result = await run(nested, "plan", "list", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
    expect(await Bun.file(journal).exists()).toBe(false);
    expect((await run(d, "plan", "show", plan.id, "--json")).exitCode).not.toBe(0);
  });

  test("create writes plans only and materialize faithfully resolves IDs", async () => {
    const d = await repo(),
      input = await planInput(d),
      mf = join(d, ".factory/missions.jsonl"),
      pf = join(d, ".factory/plans.jsonl"),
      mb = await readFile(mf),
      c = await run(d, "plan", "create", "--input", input, "--json");
    expect(c.exitCode).toBe(0);
    expect(await readFile(mf)).toEqual(mb);
    const p = JSON.parse(c.stdout);
    expect(p).not.toHaveProperty("missionId");
    expect((await run(d, "plan", "approve", p.id, "--json")).exitCode).toBe(0);
    const pb = await readFile(pf),
      m = await materialize(d, p.id);
    expect(m.exitCode).toBe(0);
    expect(await readFile(pf)).toEqual(pb);
    const mission = JSON.parse(m.stdout);
    expect(mission.title).toBe("Standalone");
    expect(mission.verificationMode).toBe("exhaustive");
    expect(mission.milestones[0].tasks).toMatchObject([
      { title: "One", type: "implementation", risk: "high", planStepKey: "one" },
      {
        title: "Two",
        type: "verification",
        risk: "low",
        verification: "verify two",
        planStepKey: "two",
      },
    ]);
    expect(mission.milestones[0].tasks[1].dependsOn).toEqual([mission.milestones[0].tasks[0].id]);
    expect(mission.sourcePlan).toEqual({ planId: p.id, revision: 1 });
  });
  test("create accepts inline JSON and always creates a draft", async () => {
    const d = await repo();
    const inline = JSON.stringify({
      missionTitle: "Inline",
      verificationMode: "fast",
      intent: "i",
      changePlan: "a",
      risks: [],
      alternatives: [],
      acceptanceCriteria: ["done"],
      verificationStrategy: "e",
    });
    const created = await run(d, "plan", "create", "--input-json", inline, "--json");
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ missionTitle: "Inline", status: "draft" });
    expect(JSON.parse((await run(d, "mission", "list", "--json")).stdout)).toEqual([]);

    const invalid = await run(d, "plan", "create", "--input-json", "not-json", "--json");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("Invalid JSON input");
  });
  test("all plan input commands accept files outside the temporary repository", async () => {
    const d = await repo(),
      inside = JSON.parse(await readFile(await planInput(d), "utf8")),
      external = await externalJson(inside, "plan.json");
    const created = await run(d, "plan", "create", "--input", external, "--json");
    expect(created.exitCode).toBe(0);
    const plan = JSON.parse(created.stdout);
    expect((await run(d, "plan", "validate", "--input", external, "--json")).exitCode).toBe(0);
    expect((await run(d, "plan", "revise", plan.id, "--input", external, "--json")).exitCode).toBe(
      0,
    );
    await run(d, "plan", "approve", plan.id, "--json");
    const mission = await externalJson(
      JSON.parse(await readFile(await missionInput(d), "utf8")),
      "mission.json",
    );
    expect(
      (await run(d, "plan", "materialize", plan.id, "--input", mission, "--json")).exitCode,
    ).toBe(0);
  });
  test("rejects unresolved dependency without mission writes", async () => {
    const d = await repo(),
      input = await planInput(d),
      f = join(d, ".factory/missions.jsonl"),
      before = await readFile(f);
    const bad = JSON.parse(await readFile(input, "utf8"));
    const mission = await missionInput(d);
    const badMission = JSON.parse(await readFile(mission, "utf8"));
    badMission.milestones[0].tasks[1].dependsOn = ["missing"];
    await writeFile(mission, JSON.stringify(badMission));
    const p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    expect(
      (await run(d, "plan", "materialize", p.id, "--input", mission, "--json")).exitCode,
    ).not.toBe(0);
    expect(await readFile(f)).toEqual(before);
  });
  test("duplicate materialization is rejected and concurrent calls yield one mission", async () => {
    const d = await repo(),
      input = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const rs = await Promise.all([materialize(d, p.id), materialize(d, p.id)]);
    expect(rs.filter((x) => x.exitCode === 0)).toHaveLength(1);
    expect(JSON.parse((await run(d, "mission", "list", "--json")).stdout)).toHaveLength(1);
    expect((await materialize(d, p.id)).exitCode).not.toBe(0);
  });
  test("historical plans validate independently and legacy missions parse", async () => {
    const d = await repo(),
      input = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    expect((await run(d, "plan", "show", p.id, "--revision", "1", "--json")).exitCode).toBe(0);
    expect((await run(d, "plan", "validate", p.id, "--revision", "1", "--json")).exitCode).toBe(0);
    const archived = JSON.parse(
      (await run(d, "plan", "archive", p.id, "--revision", "1", "--json")).stdout,
    );
    const revisionTwo = {
      ...archived,
      revision: 2,
      status: "draft",
      updatedAt: new Date().toISOString(),
    };
    delete revisionTwo.approvedAt;
    const planFile = join(d, ".factory/plans.jsonl");
    await writeFile(
      planFile,
      `${(await readFile(planFile, "utf8")).trim()}\n${JSON.stringify(revisionTwo)}\n`,
    );
    expect((await run(d, "plan", "validate", p.id, "--revision", "2", "--json")).exitCode).toBe(0);
    const f = join(d, ".factory/missions.jsonl"),
      lines = (await readFile(f, "utf8")).split("\n");
    expect((await run(d, "mission", "list", "--json")).exitCode).toBe(0);
    expect(lines.join("\n")).not.toContain("transaction");
  });
  test("archive recovers a stale draft revision", async () => {
    const d = await repo(),
      input = await planInput(d),
      created = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout),
      file = join(d, ".factory/plans.jsonl"),
      lines = (await readFile(file, "utf8")).trim().split("\n"),
      first = JSON.parse(lines[1]),
      later = "2099-01-01T00:00:01.000Z",
      second = {
        ...first,
        revision: 2,
        createdAt: later,
        updatedAt: later,
      };
    await writeFile(file, `${lines[0]}\n${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    const archived = await run(d, "plan", "archive", created.id, "--revision", "1", "--json");
    expect(archived.exitCode).toBe(0);
    expect(JSON.parse(archived.stdout)).toMatchObject({ revision: 1, status: "archived" });
    const validated = await run(d, "plan", "validate", "--json");
    expect(validated.stderr).toBe("");
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout)).toEqual({ valid: true, count: 2 });
  });
  test("source plan uniqueness and no transaction artifacts", async () => {
    const d = await repo(),
      input = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    expect((await materialize(d, p.id)).exitCode).toBe(0);
    expect((await materialize(d, p.id)).exitCode).not.toBe(0);
    expect(await Bun.file(join(d, ".factory/transaction.json")).exists()).toBe(false);
  });
  test("nested mission records preserve metadata", async () => {
    const d = await repo(),
      m = JSON.parse((await run(d, "mission", "create", "--title", "M", "--json")).stdout),
      s = JSON.parse(
        (
          await run(
            d,
            "mission",
            "milestone",
            "create",
            "--mission",
            m.id,
            "--title",
            "S",
            "--json",
          )
        ).stdout,
      ),
      t = JSON.parse(
        (
          await run(
            d,
            "mission",
            "task",
            "create",
            "--milestone",
            s.id,
            "--title",
            "T",
            "--verification",
            "v",
            "--json",
          )
        ).stdout,
      ),
      lines = (await readFile(join(d, ".factory/missions.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ type: "metadata", schemaVersion: 1 });
    expect(lines[1].milestones[0].tasks).toEqual([t]);
  });
  test("mission list/show and gitignore tracking work", async () => {
    const d = await repo(),
      m = JSON.parse((await run(d, "mission", "create", "--title", "Shown", "--json")).stdout);
    expect((await run(d, "mission", "list", "--json")).exitCode).toBe(0);
    expect(JSON.parse((await run(d, "mission", "show", m.id, "--json")).stdout).title).toBe(
      "Shown",
    );
    const g = join(d, ".gitignore");
    await writeFile(g, "node_modules/\n.factory/\ncustom\n");
    await run(d, "mission", "init");
    expect(await Bun.file(g).text()).toContain("custom");
    await run(d, "mission", "init", "--track");
    expect(await Bun.file(g).text()).not.toContain(".factory/");
  });
  test("skills install replaces bundled skills without touching unrelated skills", async () => {
    const d = await repo();
    const skills = join(d, ".agents", "skills"),
      source = join(import.meta.dir, "..", "..", "..", ".agents", "skills");
    const agents = join(d, ".opencode", "agents"),
      agentSource = join(import.meta.dir, "..", "..", "..", ".opencode", "agents");
    expect((await run(d, "mission", "init", "--skills", "--json")).exitCode).toBe(0);
    await writeFile(join(skills, "plan-mission", "SKILL.md"), "stale");
    await writeFile(join(skills, "plan-mission", "extra.md"), "stale");
    await writeFile(join(skills, "run-mission", "SKILL.md"), "stale");
    await mkdir(join(skills, "unrelated"), { recursive: true });
    await writeFile(join(skills, "unrelated", "keep.md"), "keep");
    await writeFile(join(agents, "plan-mission.md"), "stale");
    await writeFile(join(agents, "scout.md"), "stale");
    await writeFile(join(agents, "unrelated.md"), "keep");
    const again = await run(d, "mission", "init", "--skills", "--json");
    expect(again.exitCode).toBe(0);
    expect(await readFile(join(skills, "plan-mission", "SKILL.md"), "utf8")).toBe(
      await readFile(join(source, "plan-mission", "SKILL.md"), "utf8"),
    );
    expect(await Bun.file(join(skills, "plan-mission", "extra.md")).exists()).toBe(false);
    expect(await readFile(join(skills, "run-mission", "SKILL.md"), "utf8")).toBe(
      await readFile(join(source, "run-mission", "SKILL.md"), "utf8"),
    );
    expect(await readFile(join(skills, "visualize-change", "SKILL.md"), "utf8")).toBe(
      await readFile(join(source, "visualize-change", "SKILL.md"), "utf8"),
    );
    expect(await readFile(join(skills, "unrelated", "keep.md"), "utf8")).toBe("keep");
    expect(await readFile(join(agents, "plan-mission.md"), "utf8")).toBe(
      await readFile(join(agentSource, "plan-mission.md"), "utf8"),
    );
    expect(await readFile(join(agents, "scout.md"), "utf8")).toBe(
      await readFile(join(agentSource, "scout.md"), "utf8"),
    );
    expect(await readFile(join(agents, "unrelated.md"), "utf8")).toBe("keep");
  });
  test("stale lock is claimed safely and corrupt storage is reported", async () => {
    const d = await repo(),
      lock = join(d, ".factory/factory.lock");
    await writeFile(lock, JSON.stringify({ pid: 99999999, token: "foreign" }));
    await import("node:fs/promises").then((fs) => fs.utimes(lock, new Date(0), new Date(0)));
    expect((await run(d, "mission", "create", "--title", "Recovered", "--json")).exitCode).toBe(0);
    expect(await Bun.file(lock).exists()).toBe(false);
    await writeFile(join(d, ".factory/missions.jsonl"), "bad\n");
    const bad = await run(d, "mission", "list", "--json");
    expect(bad.exitCode).not.toBe(0);
  });
  test("concurrent mission creates retain all records", async () => {
    const d = await repo(),
      rs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          run(d, "mission", "create", "--title", `M${i}`, "--json"),
        ),
      );
    expect(rs.every((x) => x.exitCode === 0)).toBe(true);
    expect(JSON.parse((await run(d, "mission", "list", "--json")).stdout)).toHaveLength(8);
  });
  test("task lifecycle, validation, and ready filtering work", async () => {
    const d = await repo(),
      m = JSON.parse((await run(d, "mission", "create", "--title", "M", "--json")).stdout),
      s = JSON.parse(
        (
          await run(
            d,
            "mission",
            "milestone",
            "create",
            "--mission",
            m.id,
            "--title",
            "S",
            "--json",
          )
        ).stdout,
      ),
      t = JSON.parse(
        (
          await run(
            d,
            "mission",
            "task",
            "create",
            "--milestone",
            s.id,
            "--title",
            "T",
            "--verification",
            "v",
            "--json",
          )
        ).stdout,
      );
    expect(
      (await run(d, "mission", "update", t.id, "--status", "in_progress", "--json")).exitCode,
    ).toBe(0);
    expect((await run(d, "mission", "close", t.id, "--reason", "done", "--json")).exitCode).toBe(0);
    expect((await run(d, "mission", "update", t.id, "--status", "open", "--json")).exitCode).toBe(
      0,
    );
    expect(JSON.parse((await run(d, "mission", "ready", "--json")).stdout)).toHaveLength(1);
    expect(
      (await run(d, "mission", "update", t.id, "--status", "bogus", "--json")).exitCode,
    ).not.toBe(0);
  });
  test("missing task and invalid close reasons are rejected", async () => {
    const d = await repo();
    expect(
      (await run(d, "mission", "update", "tsk_missing", "--status", "open", "--json")).exitCode,
    ).not.toBe(0);
    expect(
      (await run(d, "mission", "close", "tsk_missing", "--reason", "x", "--json")).exitCode,
    ).not.toBe(0);
  });
  test("legacy task status is normalized on read/write", async () => {
    const d = await repo(),
      m = JSON.parse((await run(d, "mission", "create", "--title", "M", "--json")).stdout),
      s = JSON.parse(
        (
          await run(
            d,
            "mission",
            "milestone",
            "create",
            "--mission",
            m.id,
            "--title",
            "S",
            "--json",
          )
        ).stdout,
      ),
      t = JSON.parse(
        (
          await run(
            d,
            "mission",
            "task",
            "create",
            "--milestone",
            s.id,
            "--title",
            "T",
            "--verification",
            "v",
            "--json",
          )
        ).stdout,
      ),
      f = join(d, ".factory/missions.jsonl"),
      r = JSON.parse((await readFile(f, "utf8")).split("\n")[1]);
    delete r.milestones[0].tasks[0].status;
    await writeFile(
      f,
      [JSON.stringify({ type: "metadata", schemaVersion: 1 }), JSON.stringify(r)].join("\n") + "\n",
    );
    expect((await run(d, "mission", "ready", "--json")).exitCode).toBe(0);
    expect((await run(d, "mission", "update", t.id, "--status", "open", "--json")).exitCode).toBe(
      0,
    );
  });
  test("plan list and invalid plan input are safe", async () => {
    const d = await repo(),
      f = join(d, "bad.json");
    await writeFile(f, "{");
    const before = await readFile(join(d, ".factory/plans.jsonl"));
    expect((await run(d, "plan", "create", "--input", f, "--json")).exitCode).not.toBe(0);
    expect(await readFile(join(d, ".factory/plans.jsonl"))).toEqual(before);
    expect((await run(d, "plan", "list", "--json")).exitCode).toBe(0);
  });
  test("plan input help, schema, and preflight validation are discoverable and safe", async () => {
    const d = await repo(),
      f = await planInput(d),
      store = join(d, ".factory/plans.jsonl"),
      before = await readFile(store),
      help = await run(d, "plan", "create", "--help");
    for (const field of [
      "missionTitle",
      "verificationMode",
      "intent",
      "changePlan",
      "acceptanceCriteria",
    ])
      expect(help.stdout).toContain(field);
    const schema = JSON.parse((await run(d, "plan", "create", "--schema", "--json")).stdout);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "missionTitle",
        "verificationMode",
        "intent",
        "changePlan",
        "risks",
        "alternatives",
        "acceptanceCriteria",
        "verificationStrategy",
      ]),
    );
    expect(schema.required).toContain("intent");
    expect((await run(d, "plan", "validate", "--input", f, "--json")).exitCode).toBe(0);
    expect(await readFile(store)).toEqual(before);
    await writeFile(f, JSON.stringify({ missionTitle: "Missing fields" }));
    const missing = await run(d, "plan", "validate", "--input", f, "--json");
    expect(missing.exitCode).not.toBe(0);
    expect(JSON.parse(missing.stderr).error).toContain("Valid example");
    expect((await run(d, "plan", "validate", "anything", "--input", f, "--json")).stderr).toContain(
      "mutually exclusive",
    );
  });
  test("rejects cycles without mission writes", async () => {
    const d = await repo(),
      f = await planInput(d),
      v = JSON.parse(await readFile(f, "utf8"));
    const mission = await missionInput(d);
    const cycle = JSON.parse(await readFile(mission, "utf8"));
    cycle.milestones[0].tasks[0].dependsOn = ["two"];
    cycle.milestones[0].tasks[1].dependsOn = ["one"];
    await writeFile(mission, JSON.stringify(cycle));
    const mf = join(d, ".factory/missions.jsonl"),
      b = await readFile(mf);
    const p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    expect(
      (await run(d, "plan", "materialize", p.id, "--input", mission, "--json")).exitCode,
    ).not.toBe(0);
    expect(await readFile(mf)).toEqual(b);
  });
  test("outside worktree is rejected", async () => {
    const r = await run(tmpdir(), "mission", "init", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Git worktree");
  });
  test("legacy root commands are rejected", async () => {
    const d = await repo();
    for (const args of [
      ["init"],
      ["list"],
      ["show", "mis_missing"],
      ["milestone", "create"],
      ["task", "create"],
    ])
      expect((await run(d, ...args, "--json")).exitCode).not.toBe(0);
  });
  test("ready mission scope reports missing mission", async () => {
    const d = await repo();
    const r = await run(d, "mission", "ready", "--mission", "mis_missing", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Mission not found");
  });
  test("closed update requires close command", async () => {
    const d = await repo();
    const m = JSON.parse((await run(d, "mission", "create", "--title", "M", "--json")).stdout),
      s = JSON.parse(
        (
          await run(
            d,
            "mission",
            "milestone",
            "create",
            "--mission",
            m.id,
            "--title",
            "S",
            "--json",
          )
        ).stdout,
      ),
      t = JSON.parse(
        (
          await run(
            d,
            "mission",
            "task",
            "create",
            "--milestone",
            s.id,
            "--title",
            "T",
            "--verification",
            "v",
            "--json",
          )
        ).stdout,
      );
    const r = await run(d, "mission", "update", t.id, "--status", "closed", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("mission close");
  });
  test("blank close reason is rejected", async () => {
    const d = await repo();
    const m = JSON.parse((await run(d, "mission", "create", "--title", "M", "--json")).stdout),
      s = JSON.parse(
        (
          await run(
            d,
            "mission",
            "milestone",
            "create",
            "--mission",
            m.id,
            "--title",
            "S",
            "--json",
          )
        ).stdout,
      ),
      t = JSON.parse(
        (
          await run(
            d,
            "mission",
            "task",
            "create",
            "--milestone",
            s.id,
            "--title",
            "T",
            "--verification",
            "v",
            "--json",
          )
        ).stdout,
      );
    const r = await run(d, "mission", "close", t.id, "--reason", "   ", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Value must not be empty");
  });
  test("lifecycle timestamps advance", async () => {
    const d = await repo();
    const m = JSON.parse((await run(d, "mission", "create", "--title", "M", "--json")).stdout),
      s = JSON.parse(
        (
          await run(
            d,
            "mission",
            "milestone",
            "create",
            "--mission",
            m.id,
            "--title",
            "S",
            "--json",
          )
        ).stdout,
      ),
      t = JSON.parse(
        (
          await run(
            d,
            "mission",
            "task",
            "create",
            "--milestone",
            s.id,
            "--title",
            "T",
            "--verification",
            "v",
            "--json",
          )
        ).stdout,
      ),
      before = JSON.parse((await run(d, "mission", "show", m.id, "--json")).stdout);
    await run(d, "mission", "update", t.id, "--status", "in_progress", "--json");
    const after = JSON.parse((await run(d, "mission", "show", m.id, "--json")).stdout);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.milestones[0].updatedAt).not.toBe(before.milestones[0].updatedAt);
  });
  test("malformed plans preserve bytes", async () => {
    const d = await repo(),
      f = join(d, ".factory/plans.jsonl"),
      before = await readFile(f);
    await writeFile(f, "bad\n");
    const r = await run(d, "plan", "list", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(await readFile(f)).toEqual(Buffer.from("bad\n"));
    expect(before.length).toBeGreaterThan(0);
  });
  test("truncated plan records preserve bytes", async () => {
    const d = await repo(),
      f = join(d, ".factory/plans.jsonl"),
      bad = JSON.stringify({ type: "plans-metadata", schemaVersion: 1 }) + "\n{";
    await writeFile(f, bad);
    const r = await run(d, "plan", "validate", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(await readFile(f, "utf8")).toBe(bad);
  });
  test("invalid revision syntax is rejected", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    for (const n of ["1.0", " 1", "1 ", "1e1", "0"])
      expect((await run(d, "plan", "show", p.id, "--revision", n, "--json")).exitCode).not.toBe(0);
  });
  test("missing historical revision is rejected", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    const r = await run(d, "plan", "show", p.id, "--revision", "2", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("revision");
  });
  test("archive lifecycle works for draft", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    const r = await run(d, "plan", "archive", p.id, "--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("archived");
  });
  test("approved plans cannot archive", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const r = await run(d, "plan", "archive", p.id, "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Approved plans");
  });
  test("revise creates next draft revision", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout),
      r = await run(d, "plan", "revise", p.id, "--input", f, "--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ id: p.id, revision: 2, status: "draft" });
  });
  test("revision selection rejects stale mutation", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "revise", p.id, "--input", f, "--json");
    const r = await run(d, "plan", "revise", p.id, "--revision", "1", "--input", f, "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("latest");
  });
  test("plan list returns all standalone plans", async () => {
    const d = await repo(),
      f = await planInput(d);
    await run(d, "plan", "create", "--input", f, "--json");
    await run(d, "plan", "create", "--input", f, "--json");
    expect(JSON.parse((await run(d, "plan", "list", "--json")).stdout)).toHaveLength(2);
  });
  test("materialize nonapproved leaves missions bytes", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout),
      mf = join(d, ".factory/missions.jsonl"),
      before = await readFile(mf),
      r = await materialize(d, p.id);
    expect(r.exitCode).not.toBe(0);
    expect(await readFile(mf)).toEqual(before);
  });
  test("materialize preserves optional execution fields", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const m = JSON.parse((await materialize(d, p.id)).stdout);
    expect(m.milestones[0].tasks[1].planStepKey).toBe("two");
    expect(m.milestones[0].tasks[1].verification).toBe("verify two");
  });
  test("source plan pair is unique in persisted store", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const one = JSON.parse((await materialize(d, p.id)).stdout),
      mf = join(d, ".factory/missions.jsonl"),
      raw = await readFile(mf, "utf8"),
      dup = {
        ...one,
        id: "mis_duplicate",
        milestones: one.milestones.map((m: any) => ({
          ...m,
          id: `mil_${crypto.randomUUID().replaceAll("-", "")}`,
          tasks: m.tasks.map((t: any) => ({
            ...t,
            id: `tsk_${crypto.randomUUID().replaceAll("-", "")}`,
          })),
        })),
      };
    await writeFile(mf, raw + JSON.stringify(dup) + "\n");
    const r = await run(d, "mission", "list", "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Duplicate source plan");
  });
  test("dependency resolver rejects missing key", () => {
    expect(() => resolveDependencies(["missing"], new Map())).toThrow(
      "Dependency task not found: missing",
    );
  });
  test("revision store invariants reject gaps and duplicate approvals", () => {
    const base: any = {
      id: "pln_inv",
      missionTitle: "M",
      verificationMode: "standard",
      intent: "i",
      changePlan: "a",
      risks: [],
      alternatives: [],
      acceptanceCriteria: ["done"],
      verificationStrategy: "e",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const one = PlanSchema.parse({
      ...base,
      revision: 1,
      status: "approved",
      approvedAt: base.createdAt,
    });
    const gap = PlanSchema.parse({ ...base, revision: 3, status: "draft" });
    expect(() => validatePlansAgainstMissions([one, gap], [])).toThrow("contiguous");
    const two = PlanSchema.parse({
      ...base,
      revision: 2,
      status: "approved",
      approvedAt: base.createdAt,
    });
    expect(() => validatePlansAgainstMissions([one, two], [])).toThrow("one revision");
  });
  test("standalone commands ignore corrupt missions", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout),
      mf = join(d, ".factory/missions.jsonl");
    await writeFile(mf, "corrupt\n");
    expect((await run(d, "plan", "list", "--json")).exitCode).toBe(0);
    expect((await run(d, "plan", "show", p.id, "--json")).exitCode).toBe(0);
    expect((await run(d, "plan", "validate", p.id, "--json")).exitCode).toBe(0);
  });
  test("standalone mutations ignore corrupt missions", async () => {
    for (const action of ["revise", "approve", "archive"]) {
      const d = await repo(),
        f = await planInput(d),
        p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
      await writeFile(join(d, ".factory/missions.jsonl"), "corrupt\n");
      const args =
        action === "revise"
          ? ["plan", action, p.id, "--input", f, "--json"]
          : ["plan", action, p.id, "--json"];
      const r = await run(d, ...args);
      expect(r.exitCode).toBe(0);
    }
  });
  test("artifact paths are optional and constrained to repository documents", async () => {
    const d = await repo();
    const valid = await planInput(d);
    const base = JSON.parse(await readFile(valid, "utf8"));
    await writeFile(join(d, "guide.md"), "guide");
    for (const artifact of [
      undefined,
      { path: "guide.md" },
      { path: "guide.txt" },
      { path: "../guide.md" },
      { path: "/tmp/guide.md" },
      { path: "missing.md" },
    ]) {
      const input = {
        ...base,
        ...(artifact === undefined ? {} : { externalArtifacts: [artifact] }),
      };
      await writeFile(valid, JSON.stringify(input));
      const result = await run(d, "plan", "create", "--input", valid, "--json");
      expect(result.exitCode === 0, JSON.stringify(artifact)).toBe(
        artifact === undefined || artifact.path === "guide.md",
      );
    }
  });
  test("external plan input still validates artifacts against the repository", async () => {
    const d = await repo(),
      base = JSON.parse(await readFile(await planInput(d), "utf8"));
    await writeFile(join(d, "guide.md"), "guide");
    const valid = await externalJson(
      { ...base, externalArtifacts: [{ path: "guide.md" }] },
      "valid.json",
    );
    expect((await run(d, "plan", "create", "--input", valid, "--json")).exitCode).toBe(0);
    const invalid = await externalJson(
      { ...base, externalArtifacts: [{ path: "../outside.md" }] },
      "invalid.json",
    );
    const rejected = await run(d, "plan", "validate", "--input", invalid, "--json");
    expect(rejected.exitCode).not.toBe(0);
  });
  test("plan guidance names structured fields and materialize rejects unsupported task types", async () => {
    const d = await repo(),
      base = JSON.parse(await readFile(await planInput(d), "utf8"));
    base.risks = ["risk"];
    base.alternatives = ["alternative"];
    const invalidPlan = await externalJson(base, "bad-shapes.json");
    const planError = await run(d, "plan", "validate", "--input", invalidPlan, "--json");
    expect(planError.stderr).toContain("description");
    expect(planError.stderr).toContain("mitigation");
    expect(planError.stderr).toContain("rejectedBecause");
    const p = JSON.parse(
      (await run(d, "plan", "create", "--input", await planInput(d), "--json")).stdout,
    );
    await run(d, "plan", "approve", p.id, "--json");
    const mission = JSON.parse(await readFile(await missionInput(d), "utf8"));
    for (const type of ["test", "unknown"]) {
      mission.milestones[0].tasks[0].type = type;
      const f = await externalJson(mission, `${type}.json`);
      expect((await run(d, "plan", "materialize", p.id, "--input", f, "--json")).exitCode).not.toBe(
        0,
      );
    }
  });
  test("artifact symlink escapes are rejected when supported", async () => {
    const d = await repo();
    const input = JSON.parse(await readFile(await planInput(d), "utf8"));
    try {
      await Bun.write(join(tmpdir(), "factory-secret.md"), "secret");
      await (
        await import("node:fs/promises")
      ).symlink(join(tmpdir(), "factory-secret.md"), join(d, "escape.md"));
    } catch {
      return;
    }
    input.externalArtifacts = [{ path: "escape.md" }];
    const f = join(d, "artifact.json");
    await writeFile(f, JSON.stringify(input));
    expect((await run(d, "plan", "create", "--input", f, "--json")).exitCode).not.toBe(0);
  });
});
