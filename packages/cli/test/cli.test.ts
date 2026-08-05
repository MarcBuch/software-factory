import { afterEach, describe, expect, test } from "bun:test";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDependencies, PlanSchema, validatePlansAgainstMissions } from "../src/plans";

const cli = join(import.meta.dir, "..", "src", "index.ts"),
  repos = new Set<string>();
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
async function planInput(d: string) {
  const f = join(d, "plan.json");
  await writeFile(
    f,
    JSON.stringify({
      missionTitle: "Standalone",
      verificationMode: "exhaustive",
      sections,
      milestones: [{ key: "build", title: "Build" }],
      steps: [
        {
          key: "one",
          milestoneKey: "build",
          title: "One",
          type: "implementation",
          risk: "high",
          verification: "verify one",
          dependsOn: [],
        },
        {
          key: "two",
          milestoneKey: "build",
          title: "Two",
          type: "verification",
          risk: "low",
          verification: "verify two",
          executionNotes: "notes",
          dependsOn: ["one"],
        },
      ],
    }),
  );
  return f;
}
describe("standalone plans", () => {
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
      m = await run(d, "plan", "materialize", p.id, "--json");
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
  test("rejects unresolved dependency without mission writes", async () => {
    const d = await repo(),
      input = await planInput(d),
      f = join(d, ".factory/missions.jsonl"),
      before = await readFile(f);
    const bad = JSON.parse(await readFile(input, "utf8"));
    bad.steps[1].dependsOn = ["missing"];
    await writeFile(input, JSON.stringify(bad));
    expect((await run(d, "plan", "create", "--input", input, "--json")).exitCode).not.toBe(0);
    expect(await readFile(f)).toEqual(before);
  });
  test("duplicate materialization is rejected and concurrent calls yield one mission", async () => {
    const d = await repo(),
      input = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const rs = await Promise.all([
      run(d, "plan", "materialize", p.id, "--json"),
      run(d, "plan", "materialize", p.id, "--json"),
    ]);
    expect(rs.filter((x) => x.exitCode === 0)).toHaveLength(1);
    expect(JSON.parse((await run(d, "mission", "list", "--json")).stdout)).toHaveLength(1);
    expect((await run(d, "plan", "materialize", p.id, "--json")).exitCode).not.toBe(0);
  });
  test("historical plans validate independently and legacy missions parse", async () => {
    const d = await repo(),
      input = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    expect((await run(d, "plan", "show", p.id, "--revision", "1", "--json")).exitCode).toBe(0);
    expect((await run(d, "plan", "validate", p.id, "--revision", "1", "--json")).exitCode).toBe(0);
    const f = join(d, ".factory/missions.jsonl"),
      lines = (await readFile(f, "utf8")).split("\n");
    expect((await run(d, "mission", "list", "--json")).exitCode).toBe(0);
    expect(lines.join("\n")).not.toContain("transaction");
  });
  test("source plan uniqueness and no transaction artifacts", async () => {
    const d = await repo(),
      input = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", input, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    expect((await run(d, "plan", "materialize", p.id, "--json")).exitCode).toBe(0);
    expect((await run(d, "plan", "materialize", p.id, "--json")).exitCode).not.toBe(0);
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
  test("skills install refuses overwrite", async () => {
    const d = await repo();
    expect((await run(d, "mission", "init", "--skills", "--json")).exitCode).toBe(0);
    const again = await run(d, "mission", "init", "--skills", "--json");
    expect(again.exitCode).not.toBe(0);
    expect(JSON.parse(again.stderr).error).toContain("already exists");
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
    for (const field of ["missionTitle", "verificationMode", "sections", "milestones", "steps"])
      expect(help.stdout).toContain(field);
    const schema = JSON.parse((await run(d, "plan", "create", "--schema", "--json")).stdout);
    expect(schema.required).toEqual([
      "missionTitle",
      "verificationMode",
      "sections",
      "milestones",
      "steps",
    ]);
    expect(schema.properties.sections.required).toContain("context");
    expect((await run(d, "plan", "validate", "--input", f, "--json")).exitCode).toBe(0);
    expect(await readFile(store)).toEqual(before);
    await writeFile(f, JSON.stringify({ missionTitle: "Missing fields" }));
    const missing = await run(d, "plan", "validate", "--input", f, "--json");
    expect(missing.exitCode).not.toBe(0);
    expect(JSON.parse(missing.stderr).error).toContain("Valid example");
    const duplicate = {
      missionTitle: "Duplicate",
      verificationMode: "standard",
      sections,
      milestones: [
        { key: "build", title: "Build" },
        { key: "build", title: "Again" },
      ],
      steps: [],
    };
    await writeFile(f, JSON.stringify(duplicate));
    expect((await run(d, "plan", "validate", "--input", f, "--json")).exitCode).not.toBe(0);
    expect((await run(d, "plan", "validate", "anything", "--input", f, "--json")).stderr).toContain(
      "mutually exclusive",
    );
  });
  test("rejects cycles without mission writes", async () => {
    const d = await repo(),
      f = await planInput(d),
      v = JSON.parse(await readFile(f, "utf8"));
    v.steps[0].dependsOn = ["two"];
    v.steps[1].dependsOn = ["one"];
    await writeFile(f, JSON.stringify(v));
    const mf = join(d, ".factory/missions.jsonl"),
      b = await readFile(mf);
    expect((await run(d, "plan", "create", "--input", f, "--json")).exitCode).not.toBe(0);
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
      r = await run(d, "plan", "materialize", p.id, "--json");
    expect(r.exitCode).not.toBe(0);
    expect(await readFile(mf)).toEqual(before);
  });
  test("materialize preserves optional execution fields", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const m = JSON.parse((await run(d, "plan", "materialize", p.id, "--json")).stdout);
    expect(m.milestones[0].tasks[1].planStepKey).toBe("two");
    expect(m.milestones[0].tasks[1].verification).toBe("verify two");
  });
  test("source plan pair is unique in persisted store", async () => {
    const d = await repo(),
      f = await planInput(d),
      p = JSON.parse((await run(d, "plan", "create", "--input", f, "--json")).stdout);
    await run(d, "plan", "approve", p.id, "--json");
    const one = JSON.parse((await run(d, "plan", "materialize", p.id, "--json")).stdout),
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
  test("duplicate milestone keys are rejected", async () => {
    const d = await repo(),
      f = await planInput(d),
      v = JSON.parse(await readFile(f, "utf8"));
    v.milestones.push({ key: "build", title: "Again" });
    await writeFile(f, JSON.stringify(v));
    const r = await run(d, "plan", "create", "--input", f, "--json");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Duplicate milestone key");
  });
  test("revision store invariants reject gaps and duplicate approvals", () => {
    const base: any = {
      id: "pln_inv",
      missionTitle: "M",
      verificationMode: "standard",
      milestones: [],
      sections,
      steps: [],
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
});
