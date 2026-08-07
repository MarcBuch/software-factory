import { afterEach, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFile, chmod, mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkflowStorage } from "../src/workflow-storage";

const root = join(import.meta.dir, "..");
const cli = join(root, "src", "index.ts");
const dirs: string[] = [];
const run = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = execFile(
      "bun",
      [cli, ...args],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) =>
        resolve({
          stdout,
          stderr,
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        }),
    );
    if (input) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
function runAsync(cwd: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn("bun", [cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout?.on("data", (x) => stdout.push(Buffer.from(x)));
  child.stderr?.on("data", (x) => stderr.push(Buffer.from(x)));
  const done = new Promise<{ code: number }>((resolve) =>
    child.on("close", (code) => resolve({ code: code ?? 1 })),
  );
  return {
    child,
    done,
    stdout: () => Buffer.concat(stdout).toString(),
    stderr: () => Buffer.concat(stderr).toString(),
  };
}
async function latestRunId(dir: string) {
  for (let i = 0; i < 100; i++) {
    let runs: string[] = [];
    try {
      runs = (await readdir(join(dir, ".factory", "runs"))).filter((x) => x.startsWith("run_"));
    } catch {
      /* startup */
    }
    if (runs.length) return runs.sort().at(-1)!;
    await Bun.sleep(25);
  }
  throw Error("run was not created");
}
async function repo(fake: string) {
  const dir = await mkdtemp(join(tmpdir(), "factory-workflow-cli-"));
  dirs.push(dir);
  await new Promise<void>((ok, fail) =>
    execFile("git", ["init", "-q"], { cwd: dir }, (e) => (e ? fail(e) : ok())),
  );
  await writeFile(join(dir, "tracked.txt"), "original\n");
  await new Promise<void>((ok, fail) =>
    execFile("git", ["add", "."], { cwd: dir }, (e) => (e ? fail(e) : ok())),
  );
  await new Promise<void>((ok, fail) =>
    execFile(
      "git",
      ["-c", "user.email=x@y", "-c", "user.name=x", "commit", "-qm", "init"],
      { cwd: dir },
      (e) => (e ? fail(e) : ok()),
    ),
  );
  return { dir, env: { FACTORY_OPENCODE_EXECUTABLE: fake } };
}
async function fakeScript(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "factory-fake-"));
  const file = join(dir, "fake.js");
  await writeFile(file, `#!/usr/bin/env bun\n${source}`);
  await chmod(file, 0o755);
  return file;
}
function resultSource(status = "success", summary = "ok") {
  return `const content=["---FACTORY_RESULT_JSON---",JSON.stringify({status:${JSON.stringify(status)},summary:${JSON.stringify(summary)},artifacts:[],notes:[]}),"---END_FACTORY_RESULT_JSON---"].join(String.fromCharCode(10)); process.stdout.write(JSON.stringify({role:"assistant",content})+String.fromCharCode(10));`;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("workflow CLI accepts stdout result and emits one JSON envelope", async () => {
  const fake = join(await mkdtemp(join(tmpdir(), "factory-fake-")), "fake.js");
  const script = `console.log(JSON.stringify({type:"tool_use",tool:"read",input:{path:"tracked.txt"}})); console.log(JSON.stringify({type:"step_finish",part:{type:"step-finish",cost:0.0123,tokens:{input:10,output:4,reasoning:2,cache:{read:3,write:1}}}})); const content=["---FACTORY_RESULT_JSON---",JSON.stringify({status:"success",summary:"ok",artifacts:[],notes:[]}),"---END_FACTORY_RESULT_JSON---"].join(String.fromCharCode(10)); process.stdout.write(JSON.stringify({role:"assistant",content,sessionID:"test-session"})+String.fromCharCode(10));`;
  await writeFile(fake, `#!/usr/bin/env bun\n${script}`);
  await chmod(fake, 0o755);
  const p = await repo(fake),
    result = await run(p.dir, ["workflow", "run", "--agent", "scout", "hello", "--json"], p.env);
  expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.accepted).toBe(true);
  const traceResult = await run(p.dir, ["workflow", "trace", envelope.run.id, "--json"], p.env);
  expect(traceResult.code, traceResult.stderr).toBe(0);
  const trace = JSON.parse(traceResult.stdout);
  expect(trace.run.id).toBe(envelope.run.id);
  expect(trace.rawPath).toBe(envelope.run.files.rawStream);
  expect(
    trace.events.some((event: any) => event.type === "tool_call" && event.tool === "read"),
  ).toBe(true);
  expect(trace.events).toContainEqual(
    expect.objectContaining({
      type: "model_step",
      usage: { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 20 },
      cost: { amount: 0.0123, currency: "USD" },
    }),
  );
});

test("workflow CLI invokes the planner roster entry", async () => {
  const log = join(await mkdtemp(join(tmpdir(), "factory-planner-")), "argv.log");
  const fake = await fakeScript(
    `await import("node:fs/promises").then(x=>x.writeFile(${JSON.stringify(log)},process.argv.slice(2).join(" "))); ${resultSource("success", "## Mission Plan: Notifications")}`,
  );
  const p = await repo(fake);
  const result = await run(p.dir, ["workflow", "run", "--agent", "planner", "plan it", "--json"], p.env);
  expect(result.code, result.stderr).toBe(0);
  expect(await readFile(log, "utf8")).toContain("--agent plan-mission");
  expect(JSON.parse(result.stdout).result.summary).toContain("Mission Plan");
});

test("workflow CLI deletes terminal run artifacts and rejects active runs", async () => {
  const p = await repo(await fakeScript(resultSource()));
  const completed = JSON.parse(
    (await run(p.dir, ["workflow", "run", "--agent", "scout", "hello", "--json"], p.env)).stdout,
  ).run;
  const deleted = await run(p.dir, ["workflow", "delete", completed.id, "--json"], p.env);
  expect(deleted.code).toBe(0);
  expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true, runId: completed.id });
  expect(await Bun.file(completed.files.directory).exists()).toBe(false);

  const storage = await openWorkflowStorage(p.dir);
  const active = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(active.id);
  storage.close();
  const rejected = await run(p.dir, ["workflow", "delete", active.id, "--json"], p.env);
  expect(rejected.code).toBe(1);
  expect(JSON.parse(rejected.stdout).error).toMatchObject({ code: "WORKFLOW_ERROR" });
});

test("workflow CLI uses stdin and rejects stderr-only sentinel", async () => {
  const fake = join(await mkdtemp(join(tmpdir(), "factory-fake-")), "fake.js");
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' '{"type":"text","part":{"text":"---FACTORY_RESULT_JSON---\\n{}\\n---END_FACTORY_RESULT_JSON---"}}' >&2`,
  );
  await chmod(fake, 0o755);
  const p = await repo(fake),
    result = await run(p.dir, ["workflow", "run", "--agent", "scout"], p.env, "from stdin");
  expect(result.code).not.toBe(0);
});

test("workflow CLI rejects unknown agent", async () => {
  const p = await repo("opencode");
  const result = await run(p.dir, ["workflow", "run", "--agent", "missing", "x"], p.env);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("Unknown agent");
});

test("correction uses exactly one continuation with the same session", async () => {
  const log = join(await mkdtemp(join(tmpdir(), "factory-log-")), "argv.log");
  const fake = await fakeScript(
    `await import("node:fs/promises").then(x=>x.appendFile(${JSON.stringify(log)},process.argv.slice(2).join(" ")+"\\0")); if (process.argv.includes("--session")) { ${resultSource()} } else { console.log(JSON.stringify({type:"session_start",sessionID:"ses_same"})); console.log("invalid"); }`,
  );
  const p = await repo(fake),
    r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x", "--json"], p.env);
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.accepted).toBe(true);
  const invocations = (await readFile(log, "utf8")).split("\0").filter(Boolean);
  expect(invocations).toHaveLength(2);
  expect(invocations[1]).toContain("--session ses_same");
  const raw = await readFile(out.run.files.rawStream, "utf8");
  expect(raw.match(/ses_same/g)?.length).toBeGreaterThan(0);
});

test("twice-invalid, agent failure, and backend nonzero are terminal failures", async () => {
  const invalidLog = join(await mkdtemp(join(tmpdir(), "factory-log-")), "argv.log");
  const invalid = await fakeScript(
    `await import("node:fs/promises").then(x=>x.appendFile(${JSON.stringify(invalidLog)},process.argv.slice(2).join(" ")+"\\0")); console.log(JSON.stringify({type:"session_start",sessionID:"ses_bad"})); console.log("invalid");`,
  );
  const failure = await fakeScript(resultSource("failure", "nope"));
  const nonzero = await fakeScript(`process.exit(7);`);
  for (const [fake, code, expected] of [
    [invalid, 1, "INVALID_OUTPUT"],
    [failure, 1, "AGENT_FAILURE"],
    [nonzero, 1, "BACKEND_FAILURE"],
  ] as const) {
    const p = await repo(fake),
      r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x", "--json"], p.env);
    expect(r.code).toBe(code);
    if (r.stdout.trim()) {
      const out = JSON.parse(r.stdout);
      expect(out.run.status).toBe("failed");
      const status = await run(p.dir, ["workflow", "status", out.run.id, "--json"], p.env);
      expect(JSON.parse(status.stdout).run.failure.code).toBe(expected);
    }
  }
  expect((await readFile(invalidLog, "utf8")).split("\0").filter(Boolean)).toHaveLength(2);
}, 20000);

test("tracked mutation is restored and status/trace expose persisted records", async () => {
  const fake = await fakeScript(
    `await Bun.write("tracked.txt", "changed\\n"); console.log(JSON.stringify({type:"tool_use",tool:"write",input:{path:"tracked.txt"}})); ${resultSource()}`,
  );
  const p = await repo(fake),
    r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x", "--json"], p.env);
  expect(r.code).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.run.status).toBe("failed");
  expect(await readFile(join(p.dir, "tracked.txt"), "utf8")).toBe("original\n");
  const status = await run(p.dir, ["workflow", "status", out.run.id, "--json"], p.env);
  expect(JSON.parse(status.stdout).run.status).toBe("failed");
  const trace = await run(p.dir, ["workflow", "trace", out.run.id, "--json"], p.env);
  const t = JSON.parse(trace.stdout);
  expect(t.rawPath).toContain(out.run.id);
  expect(t.events.some((e: any) => e.type === "tool_call")).toBe(true);
});

test("stderr sentinel cannot succeed and raw stderr remains observable", async () => {
  const fake = await fakeScript(
    `console.error(JSON.stringify({type:"error",message:"diagnostic"})); console.error(JSON.stringify({role:"assistant",content:"---FACTORY_RESULT_JSON---\\n{}\\n---END_FACTORY_RESULT_JSON---"}));`,
  );
  const p = await repo(fake),
    r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x", "--json"], p.env);
  expect(r.code).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.accepted).toBe(false);
  const status = await run(p.dir, ["workflow", "status", out.run.id, "--json"], p.env);
  const state = JSON.parse(status.stdout);
  expect(["INVALID_OUTPUT", "BACKEND_FAILURE"]).toContain(state.run.failure.code);
  expect(state.summary).toBeUndefined();
  const raw = await readFile(state.run.files.rawStream, "utf8");
  expect(raw).toContain("diagnostic");
  expect(raw).toContain("FACTORY_RESULT_JSON");
});

test("live expected backend can be stopped by a second CLI", async () => {
  const signalLog = join(await mkdtemp(join(tmpdir(), "factory-stop-")), "signal.log");
  const fake = await fakeScript(
    `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(signalLog + ".ready")},"ready"); process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(signalLog)},"SIGTERM");process.exit(143)}); setInterval(()=>{},1000);`,
  );
  const p = await repo(fake);
  const running = runAsync(p.dir, ["workflow", "run", "--agent", "scout", "wait", "--json"], p.env);
  const id = await latestRunId(p.dir);
  let state: any;
  for (let i = 0; i < 100; i++) {
    const status = await run(p.dir, ["workflow", "status", id, "--json"], p.env);
    state = JSON.parse(status.stdout);
    if (state.run.status === "running" && state.run.childPid) break;
    await Bun.sleep(30);
  }
  expect(state.run.status).toBe("running");
  for (let i = 0; i < 50; i++) {
    try {
      await readFile(signalLog + ".ready");
      break;
    } catch {}
    await Bun.sleep(20);
  }
  const stopped = await run(p.dir, ["workflow", "stop", id, "--json"], p.env);
  expect(stopped.code, stopped.stderr).toBe(1);
  expect(JSON.parse(stopped.stdout).accepted).toBe(false);
  const original = await running.done;
  let signal = "";
  for (let i = 0; i < 250 && !signal; i++) {
    try {
      signal = await readFile(signalLog, "utf8");
    } catch {}
    await Bun.sleep(20);
  }
  expect(signal).toBe("SIGTERM");
  expect(original.code).toBe(1);
  const final = JSON.parse((await run(p.dir, ["workflow", "status", id, "--json"], p.env)).stdout);
  expect(final.run.status).toBe("failed");
  expect(final.run.failure.failureCode).toBe("stopped");
  expect(() => process.kill(state.run.childPid, 0)).toThrow();
}, 30000);

test("stale persisted PID is rejected without killing unrelated sleep", async () => {
  const fake = await fakeScript("await Bun.sleep(10000);");
  const p = await repo(fake);
  const sleeper = spawn("sleep", ["10"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const storage = await openWorkflowStorage(p.dir);
  const runRecord = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(runRecord.id);
  storage.setAgentProcess(runRecord.id, {
    agentName: "scout",
    pid: sleeper.pid,
    identity: JSON.stringify({
      pid: sleeper.pid,
      start: "stale",
      command: "sleep 10",
      expected: "not-sleep",
    }),
  });
  storage.close();
  const r = await run(p.dir, ["workflow", "stop", runRecord.id, "--json"], p.env);
  expect(r.code).toBe(1);
  expect(() => process.kill(sleeper.pid!, 0)).not.toThrow();
  sleeper.kill("SIGTERM");
});

test("startup failure persists BACKEND_FAILURE", async () => {
  const p = await repo(join(await mkdtemp(join(tmpdir(), "missing-")), "not-executable"));
  const r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x", "--json"], p.env);
  expect(r.code).toBe(1);
  const out = JSON.parse(r.stdout);
  const status = JSON.parse(
    (await run(p.dir, ["workflow", "status", out.run.id, "--json"], p.env)).stdout,
  );
  expect(status.run.failure.code).toBe("BACKEND_FAILURE");
});

test("workflow CLI acceptance matrix has one envelope and persisted truth", async () => {
  const success = await fakeScript(resultSource());
  const agentFailure = await fakeScript(resultSource("failure", "declined"));
  const invalid = await fakeScript(
    'console.log(JSON.stringify({type:"session_start",sessionID:"bad"})); console.log("not a result");',
  );
  const nonzero = await fakeScript("process.exit(9);");
  const mutation = await fakeScript(
    `await Bun.write("tracked.txt", "changed\\n"); ${resultSource()}`,
  );
  const rows = [
    { name: "success", fake: success, code: 0, status: "succeeded" },
    {
      name: "agent failure",
      fake: agentFailure,
      code: 1,
      status: "failed",
      failure: "AGENT_FAILURE",
    },
    { name: "invalid output", fake: invalid, code: 1, status: "failed", failure: "INVALID_OUTPUT" },
    {
      name: "backend nonzero",
      fake: nonzero,
      code: 1,
      status: "failed",
      failure: "BACKEND_FAILURE",
    },
    {
      name: "boundary restored",
      fake: mutation,
      code: 1,
      status: "failed",
      failure: "BOUNDARY_VIOLATION",
    },
    {
      name: "restoration failure",
      fake: mutation,
      code: 1,
      status: "failed",
      failure: "RESTORATION_FAILURE",
      env: { FACTORY_TEST_RESTORE_FAILURE: "tracked:tracked.txt" },
    },
  ] as const;
  for (const row of rows) {
    const p = await repo(row.fake);
    const r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x", "--json"], {
      ...p.env,
      ...((row as any).env ?? {}),
    });
    expect(r.code, row.name).toBe(row.code);
    expect(r.stderr, row.name).toBe("");
    expect(r.stdout.trim().split("\n"), row.name).toHaveLength(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.accepted, row.name).toBe(row.code === 0);
    expect(envelope.run.status, row.name).toBe(row.status);
    expect(envelope.run.failure?.code, row.name).toBe((row as any).failure);
    const persisted = JSON.parse(
      (await run(p.dir, ["workflow", "status", envelope.run.id, "--json"], p.env)).stdout,
    );
    expect(persisted.run.status, row.name).toBe(row.status);
    expect(persisted.summary, row.name).toEqual(
      row.name === "invalid output" || row.name === "backend nonzero"
        ? undefined
        : expect.anything(),
    );
    if (row.name === "boundary restored")
      expect(await readFile(join(p.dir, "tracked.txt"), "utf8")).toBe("original\n");
  }
  const unknown = await repo(success);
  for (const [command, args] of [
    ["unknown agent", ["workflow", "run", "--agent", "missing", "x", "--json"]],
    ["empty input", ["workflow", "run", "--agent", "scout", "--json"]],
    ["missing status", ["workflow", "status", "run_missing", "--json"]],
    ["missing trace", ["workflow", "trace", "run_missing", "--json"]],
    ["missing delete", ["workflow", "delete", "run_missing", "--json"]],
    ["missing stop", ["workflow", "stop", "run_missing", "--json"]],
  ] as const) {
    const r = await run(
      unknown.dir,
      [...args],
      unknown.env,
      command === "empty input" ? " " : undefined,
    );
    expect(r.code, command).toBe(1);
    expect(r.stderr, command).toBe("");
    expect(r.stdout.trim().split("\n"), command).toHaveLength(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.accepted, command).toBe(false);
    expect(envelope.error.code, command).toBe("WORKFLOW_ERROR");
  }
}, 60000);

test("workflow normal mode emits success and failed terminal output", async () => {
  for (const [fake, expected] of [
    [await fakeScript(resultSource()), 0],
    [await fakeScript(resultSource("failure", "no")), 1],
  ] as const) {
    const p = await repo(fake);
    const r = await run(p.dir, ["workflow", "run", "--agent", "scout", "x"], p.env);
    expect(r.code).toBe(expected);
    expect(r.stdout.trim()).toContain("accepted");
  }
});

test("workflow setup and commander failures use the JSON workflow envelope", async () => {
  const outside = await mkdtemp(join(tmpdir(), "factory-workflow-outside-"));
  dirs.push(outside);
  for (const args of [
    ["workflow", "run", "--agent", "scout", "x", "--json"],
    ["workflow", "status", "missing", "--json"],
    ["workflow", "trace", "missing", "--json"],
    ["workflow", "delete", "missing", "--json"],
    ["workflow", "stop", "missing", "--json"],
    ["workflow", "run", "x", "--json"],
  ]) {
    const r = await run(outside, args);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.run).toBeNull();
    expect(envelope.accepted).toBe(false);
    expect(envelope.error.code).toBe("WORKFLOW_ERROR");
  }
  const normal = await run(outside, ["mission", "list", "--json"]);
  expect(normal.code).toBe(1);
  expect(normal.stdout).toBe("");
  expect(normal.stderr).toContain("error");
});
