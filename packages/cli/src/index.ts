#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";
import { z } from "zod";

import { OpenCodeAdapter } from "./backend";
import { completeAgent } from "./completion";
import { captureGitBoundary, compareGitBoundary, restoreGitBoundary } from "./git-boundary";
import { ensurePlansMetadataUnlocked } from "./plans";
import {
  loadPlans,
  PlanSchema,
  PlanInputSchema,
  PLAN_INPUT_EXAMPLE,
  savePlansUnlocked,
  validatePlansAgainstMissions,
  resolveDependencies,
  type Plan,
  type MissionReference,
} from "./plans";
import { lookupRoster, renderAgentPrompts } from "./roster";
import { withFactoryLock } from "./storage";
import { startUiServer } from "./ui";
import { openWorkflowStorage } from "./workflow-storage";
import type { RunRecord } from "./workflow-storage";

const exec = promisify(execFile);
const iso = z.string().datetime({ offset: true });
const text = z.string().trim().min(1);
const Task = z
  .object({
    id: z.string().regex(/^tsk_[A-Za-z0-9]+$/),
    title: text,
    type: z.enum(["implementation", "verification"]),
    risk: z.enum(["low", "medium", "high"]),
    verification: text,
    status: z.enum(["open", "in_progress", "closed"]),
    closureReason: text.optional(),
    planStepKey: text.optional(),
    dependsOn: z.array(z.string().regex(/^tsk_[A-Za-z0-9]+$/)).optional(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.updatedAt < v.createdAt)
      c.addIssue({ code: "custom", message: "updatedAt must be >= createdAt" });
    if (v.status === "closed" && !v.closureReason)
      c.addIssue({ code: "custom", message: "Closed tasks require a nonempty closure reason" });
    if (v.status !== "closed" && v.closureReason !== undefined)
      c.addIssue({ code: "custom", message: "Only closed tasks may have a closure reason" });
  });
const Milestone = z
  .object({
    id: z.string().regex(/^mil_[A-Za-z0-9]+$/),
    title: text,
    createdAt: iso,
    updatedAt: iso,
    tasks: z.array(Task),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.updatedAt < v.createdAt)
      c.addIssue({ code: "custom", message: "updatedAt must be >= createdAt" });
  });
const Mission = z
  .object({
    id: z.string().regex(/^mis_[A-Za-z0-9]+$/),
    title: text,
    verificationMode: z.enum(["fast", "standard", "exhaustive"]),
    createdAt: iso,
    updatedAt: iso,
    milestones: z.array(Milestone),
    sourcePlan: z
      .object({ planId: z.string(), revision: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.updatedAt < v.createdAt)
      c.addIssue({ code: "custom", message: "updatedAt must be >= createdAt" });
  });
const Metadata = z.object({ type: z.literal("metadata"), schemaVersion: z.literal(1) }).strict();
type MissionType = z.infer<typeof Mission>;
const now = () => new Date().toISOString();
const makeId = (p: string) => `${p}_${crypto.randomUUID().replaceAll("-", "")}`;
function clean(value: string) {
  const v = value.trim();
  if (!v) throw Error("Value must not be empty");
  return v;
}

async function projectRoot() {
  try {
    return (
      await exec("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
    ).stdout.trim();
  } catch {
    throw Error("factory must be run inside a Git worktree");
  }
}
async function processIdentity(pid: number, command: readonly string[]) {
  const { stdout } = await exec("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)]);
  const line = stdout.trim();
  const match = line.match(/^(.{24})\s+(.*)$/s);
  if (!match) throw Error(`Unable to verify backend process ${pid}`);
  return JSON.stringify({
    pid,
    start: match[1].trim(),
    command: match[2].trim(),
    expected: command.join(" "),
  });
}
async function verifyProcessIdentity(run: { childPid?: number; processIdentity?: string }) {
  if (!run.childPid || !run.processIdentity) throw Error("Cannot safely stop unverifiable process");
  const saved = JSON.parse(run.processIdentity) as {
    pid: number;
    start: string;
    command: string;
    expected: string;
  };
  if (saved.pid !== run.childPid) throw Error("Stale backend process identity");
  const { stdout } = await exec("ps", [
    "-o",
    "lstart=",
    "-o",
    "command=",
    "-p",
    String(run.childPid),
  ]);
  const match = stdout.trim().match(/^(.{24})\s+(.*)$/s);
  const current = match?.[2].trim().replaceAll("\\012", "\n");
  const expected = saved.expected.replaceAll("\\012", "\n");
  const executable = expected.split(" ")[0]!;
  if (
    !match ||
    match[1].trim() !== saved.start ||
    !current ||
    !current.includes(executable) ||
    !saved.command.includes(executable)
  )
    throw Error("Backend process identity mismatch");
}
async function paths() {
  const root = await projectRoot(),
    dir = join(root, ".factory");
  return { root, dir, file: join(dir, "missions.jsonl") };
}
const missionSkills = ["plan-mission", "run-mission"];
const skillSource = join(import.meta.dir, "..", "..", "..", ".agents", "skills");
async function installMissionSkills(root: string) {
  const destination = join(root, ".agents", "skills");
  for (const name of missionSkills)
    if (existsSync(join(destination, name)))
      throw Error(`Mission skill already exists: .agents/skills/${name}`);
  await mkdir(destination, { recursive: true });
  for (const name of missionSkills)
    await cp(join(skillSource, name), join(destination, name), { recursive: true });
}
function validateAll(missions: MissionType[]) {
  const ids = new Set<string>(),
    sources = new Set<string>();
  for (const m of missions) {
    for (const x of [m, ...m.milestones, ...m.milestones.flatMap((v) => v.tasks)]) {
      if (ids.has(x.id)) throw Error(`Duplicate ID: ${x.id}`);
      ids.add(x.id);
    }
    if (m.sourcePlan) {
      const key = `${m.sourcePlan.planId}:${m.sourcePlan.revision}`;
      if (sources.has(key)) throw Error(`Duplicate source plan: ${key}`);
      sources.add(key);
    }
    const tasks = new Map(m.milestones.flatMap((ms) => ms.tasks).map((t) => [t.id, t]));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw Error(`Cyclic task dependency: ${id}`);
      if (visited.has(id)) return;
      const task = tasks.get(id);
      if (!task) return;
      visiting.add(id);
      for (const dep of task.dependsOn ?? []) {
        if (!tasks.has(dep)) throw Error(`Unknown task dependency: ${dep}`);
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of tasks.keys()) visit(id);
  }
  return missions;
}
function locateTask(missions: MissionType[], id: string) {
  for (const mission of missions)
    for (const milestone of mission.milestones) {
      const task = milestone.tasks.find((x) => x.id === id);
      if (task) return { mission, milestone, task };
    }
  return undefined;
}
function lifecycleStatus(value: string): value is "open" | "in_progress" | "closed" {
  return value === "open" || value === "in_progress" || value === "closed";
}
async function load(file: string) {
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  if (!lines.length) throw Error("Invalid storage: missing metadata");
  Metadata.parse(JSON.parse(lines[0]));
  return validateAll(
    lines.slice(1).map((x) => {
      const m = JSON.parse(x);
      for (const ms of m.milestones ?? [])
        for (const task of ms.tasks ?? []) if (task.status === undefined) task.status = "open";
      return Mission.parse(m);
    }),
  );
}

const withLock = withFactoryLock;
async function save(missions: MissionType[]) {
  const p = await paths();
  validateAll(missions);
  const data =
    [
      JSON.stringify({ type: "metadata", schemaVersion: 1 }),
      ...missions.map((m) => JSON.stringify(m)),
    ].join("\n") + "\n";
  const tmp = `${p.file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, p.file);
  } finally {
    await rm(tmp, { force: true });
  }
}
function isJson(cmd: Command) {
  return cmd.optsWithGlobals().json === true;
}
function output(value: unknown, json: boolean) {
  console.log(
    json
      ? JSON.stringify(value)
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2),
  );
}
type WorkflowFailure = NonNullable<RunRecord["failure"]>;
type WorkflowEnvelope = { run: RunRecord | null; result?: unknown; accepted: boolean };
function workflowFailure(
  outcome: any,
  boundaryFailure?: string,
  restorationFailure?: string,
): WorkflowFailure | undefined {
  if (restorationFailure) return { code: "RESTORATION_FAILURE", message: restorationFailure };
  if (boundaryFailure) return { code: "BOUNDARY_VIOLATION", message: boundaryFailure };
  if (outcome?.kind === "agent_failure")
    return { code: "AGENT_FAILURE", message: outcome.result.summary };
  if (outcome?.kind === "invalid_output_exhausted")
    return { code: "INVALID_OUTPUT", message: outcome.reason };
  if (outcome?.kind === "backend_failure")
    return {
      code: "BACKEND_FAILURE",
      message: `Backend exited with ${outcome.exit.code ?? outcome.exit.signal ?? "unknown"}`,
    };
  return undefined;
}
async function persistedResult(record: RunRecord) {
  try {
    return JSON.parse(await Bun.file(record.files.result).text());
  } catch {
    return undefined;
  }
}
function workflowEnvelope(run: RunRecord | undefined, result?: unknown): WorkflowEnvelope {
  const accepted = run?.status === "succeeded";
  return {
    run: run ?? null,
    ...(result === undefined ? {} : { result }),
    accepted,
  };
}
function emitWorkflowTerminal(run: RunRecord | undefined, json: boolean, result?: unknown) {
  output(workflowEnvelope(run, result), json);
  if (run?.status !== "succeeded") process.exitCode = 1;
}
function emitWorkflowError(message: string, json: boolean) {
  if (json)
    output({ ...workflowEnvelope(undefined), error: { code: "WORKFLOW_ERROR", message } }, true);
  else console.error(message);
  process.exitCode = 1;
}
function jsonOption(c: Command) {
  return c.option("--json", "Output JSON");
}
const program = new Command()
  .name("factory")
  .description("Software Factory mission planner")
  .option("--json", "Output JSON errors and data");

/* Workflow execution is intentionally kept separate from the mission record.  The
 * .factory workflow database is runtime state, not mission state. */
const workflow = program
  .command("workflow")
  .description(
    "Run repository workflows; records and traces live under .factory. Requires exclusive worktree access for Git write-boundary checks.",
  );
const workflowRun = jsonOption(
  workflow
    .command("run")
    .description("Run an agent request (or read the request from stdin).")
    .requiredOption("--agent <name>")
    .argument("[request]"),
);
workflowRun.action(async (requestArg: string | undefined, opts, cmd) => {
  const root = await projectRoot();
  const request = requestArg?.trim() || (await Bun.stdin.text()).trim();
  if (!request) {
    emitWorkflowError("A request argument or stdin request is required", isJson(cmd));
    return;
  }
  let agent;
  try {
    agent = lookupRoster(opts.agent);
  } catch (error) {
    emitWorkflowError(error instanceof Error ? error.message : String(error), isJson(cmd));
    return;
  }
  const storage = await openWorkflowStorage(root);
  let record: RunRecord | undefined;
  let started = false;
  let terminalEmitted = false;
  try {
    // Capture before creating runtime files: .factory is explicitly excluded by the boundary.
    const boundary = await captureGitBoundary({ repositoryRoot: root });
    const preliminary = renderAgentPrompts(agent.name, request, {});
    record = await storage.createRun({
      systemPrompt: preliminary.systemPrompt,
      userPrompt: preliminary.userPrompt,
      metadata: { agent: agent.name, request },
    });
    const prompts = renderAgentPrompts(agent.name, request, {
      runId: record.id,
      storagePath: relative(root, record.files.directory),
    });
    // Replace the preliminary prompt with the run-specific one (the storage API writes atomically).
    await Bun.write(record.files.systemPrompt, prompts.systemPrompt);
    await Bun.write(record.files.userPrompt, prompts.userPrompt);
    storage.startRun(record.id);
    const activeRecord = record;
    started = true;
    if (!isJson(cmd)) console.error(`Running ${record.id} with ${agent.name}...`);
    const adapter = new OpenCodeAdapter({
      executable: process.env.FACTORY_OPENCODE_EXECUTABLE,
    });
    let processRun;
    try {
      processRun = adapter.start({
        repositoryRoot: root,
        runId: record.id,
        agent,
        prompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        model: agent.model,
        tools: agent.allowedTools,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = storage.finishRun(record.id, "failed", { code: "BACKEND_FAILURE", message });
      emitWorkflowTerminal(failed, isJson(cmd));
      terminalEmitted = true;
      return;
    }
    let identity: string | undefined;
    try {
      identity = await processIdentity(processRun.pid, processRun.command);
    } catch {
      /* process may have exited */
    }
    storage.setAgentProcess(record.id, {
      agentName: agent.name,
      pid: processRun.pid,
      ...(identity ? { identity } : {}),
    });
    storage.appendTrace({
      runId: record.id,
      at: new Date().toISOString(),
      type: "agent_started",
      agentName: agent.name,
    });
    const outcome = await completeAgent(
      { start: () => processRun } as any,
      {
        repositoryRoot: root,
        runId: record.id,
        agent,
        prompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        model: agent.model,
        tools: agent.allowedTools,
      },
      async (event, activeProcess) => {
        await storage.appendRaw(activeRecord.id, event);
        if (event.normalized) storage.appendTrace(event.normalized);
        let identity: string | undefined;
        try {
          identity = await processIdentity(activeProcess.pid, activeProcess.command);
        } catch {
          /* exited between event and ps */
        }
        storage.setAgentProcess(activeRecord.id, {
          agentName: agent.name,
          pid: activeProcess.pid,
          ...(identity ? { identity } : {}),
          sessionId: event.sessionId,
        });
      },
    );
    const agentResult =
      "result" in outcome
        ? outcome.result
        : {
            status: "failure" as const,
            summary:
              outcome.kind === "invalid_output_exhausted"
                ? `Invalid agent output: ${outcome.reason}`
                : "Backend failed before producing an agent result",
            artifacts: [],
            notes: [],
          };
    if ("result" in outcome) await storage.writeResult(record.id, outcome.result);
    storage.appendTrace({
      runId: record.id,
      at: new Date().toISOString(),
      type: "agent_finished",
      agentName: agent.name,
      result: agentResult,
    });
    const comparison = await compareGitBoundary(boundary, { repositoryRoot: root });
    let boundaryFailure: string | undefined;
    let restorationFailure: string | undefined;
    if (!comparison.equal) {
      boundaryFailure = `Git boundary violation: ${JSON.stringify(comparison)}`;
      try {
        await restoreGitBoundary(boundary, {
          repositoryRoot: root,
          runtimeDirectory: join(root, ".factory"),
          ...(process.env.FACTORY_TEST_RESTORE_FAILURE
            ? {
                restoreFailure: (step) => {
                  if (step === process.env.FACTORY_TEST_RESTORE_FAILURE)
                    throw Error(`Injected restoration failure: ${step}`);
                },
              }
            : {}),
        });
      } catch (error) {
        restorationFailure = error instanceof Error ? error.message : String(error);
      }
    }
    const failure = workflowFailure(outcome, boundaryFailure, restorationFailure);
    const accepted = !failure && outcome.kind === "success";
    const current = storage.getRun(record.id);
    if (current?.status !== "running") {
      emitWorkflowTerminal(
        current,
        isJson(cmd),
        current ? await persistedResult(current) : undefined,
      );
      terminalEmitted = true;
      return;
    }
    const finished = storage.finishRun(record.id, accepted ? "succeeded" : "failed", failure);
    storage.clearAgentProcess(record.id);
    emitWorkflowTerminal(
      finished,
      isJson(cmd),
      finished ? await persistedResult(finished) : undefined,
    );
    terminalEmitted = true;
  } catch (error) {
    if (started && record) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = storage.failIfRunning(record.id, {
        code:
          message.includes("spawn") || message.includes("ENOENT")
            ? "BACKEND_FAILURE"
            : "WORKFLOW_FAILURE",
        message,
      });
      try {
        storage.clearAgentProcess(record.id);
      } catch {
        /* best effort */
      }
      if (!terminalEmitted && failed) {
        emitWorkflowTerminal(failed, isJson(cmd), await persistedResult(failed));
        terminalEmitted = true;
        return;
      }
    }
    throw error;
  } finally {
    storage.close();
  }
});

const workflowStatus = jsonOption(
  workflow
    .command("status")
    .description("Show the persisted status and result for a run.")
    .argument("<run-id>"),
);
workflowStatus.action(async (id: string, _, cmd) => {
  const storage = await openWorkflowStorage(await projectRoot());
  try {
    const run = storage.getRun(id);
    if (!run) {
      emitWorkflowError(`Run not found: ${id}`, isJson(cmd));
      return;
    }
    let summary: unknown;
    try {
      summary = JSON.parse(await Bun.file(run.files.result).text());
    } catch {
      /* pending */
    }
    output({ run, summary }, isJson(cmd));
  } catch (error) {
    emitWorkflowError(error instanceof Error ? error.message : String(error), isJson(cmd));
  } finally {
    storage.close();
  }
});
const workflowTrace = jsonOption(
  workflow
    .command("trace")
    .description("Show normalized trace events and the raw stream path for a run.")
    .argument("<run-id>"),
);
workflowTrace.action(async (id: string, _, cmd) => {
  const storage = await openWorkflowStorage(await projectRoot());
  try {
    const run = storage.getRun(id);
    if (!run) {
      emitWorkflowError(`Run not found: ${id}`, isJson(cmd));
      return;
    }
    output(
      { run, runId: id, events: storage.trace(id), rawPath: run.files.rawStream },
      isJson(cmd),
    );
  } catch (error) {
    emitWorkflowError(error instanceof Error ? error.message : String(error), isJson(cmd));
  } finally {
    storage.close();
  }
});
const workflowDelete = jsonOption(
  workflow
    .command("delete")
    .description("Permanently delete a completed run and its artifacts.")
    .argument("<run-id>"),
);
workflowDelete.action(async (id: string, _, cmd) => {
  const storage = await openWorkflowStorage(await projectRoot());
  try {
    const deleted = await storage.deleteRun(id);
    output({ deleted: true, runId: deleted.id }, isJson(cmd));
  } catch (error) {
    emitWorkflowError(error instanceof Error ? error.message : String(error), isJson(cmd));
  } finally {
    storage.close();
  }
});
const workflowStop = jsonOption(
  workflow
    .command("stop")
    .description("Stop an active run after verifying its backend process identity.")
    .argument("<run-id>"),
);
workflowStop.action(async (id: string, _, cmd) => {
  const storage = await openWorkflowStorage(await projectRoot());
  try {
    const run = storage.getRun(id);
    if (!run) {
      emitWorkflowError(`Run not found: ${id}`, isJson(cmd));
      return;
    }
    if (run.status === "running" && run.childPid) {
      try {
        await verifyProcessIdentity(run);
        process.kill(run.childPid, "SIGTERM");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(run.childPid, 0);
        } catch {
          break;
        }
        await Bun.sleep(25);
        if (i === 19) throw Error("Backend did not exit after stop request");
      }
      let stopped;
      try {
        stopped = storage.finishRun(id, "failed", {
          code: "STOPPED",
          failureCode: "stopped",
          message: "Run stopped by user",
        });
        storage.clearAgentProcess(id);
      } catch (error) {
        const latest = storage.getRun(id);
        if (!latest || latest.status === "running") throw error;
        stopped = latest;
      }
      emitWorkflowTerminal(
        stopped,
        isJson(cmd),
        stopped ? await persistedResult(stopped) : undefined,
      );
    } else emitWorkflowTerminal(run, isJson(cmd), await persistedResult(run));
  } catch (error) {
    emitWorkflowError(error instanceof Error ? error.message : String(error), isJson(cmd));
  } finally {
    storage.close();
  }
});
const ui = program
  .command("ui")
  .description("Serve the local Workflow Session Trace UI")
  .option("--port <port>", "HTTP port", "4173");
ui.action(async (opts) => {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("Port must be an integer from 0 to 65535");
  const running = await startUiServer({ repositoryRoot: await projectRoot(), port });
  console.error(`Workflow Session Trace UI listening at ${running.url}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      running.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
});
const mission = program.command("mission");
const init = mission
  .command("init")
  .option("--track", "Keep .factory records trackable")
  .option("--skills", "Install the plan-mission and run-mission skills");
jsonOption(init);
init.action(async (opts, cmd) =>
  withLock(async () => {
    const p = await paths();
    await mkdir(p.dir, { recursive: true });
    if (!existsSync(p.file)) await save([]);
    const planFile = join(p.dir, "plans.jsonl");
    if (!existsSync(planFile)) await ensurePlansMetadataUnlocked(planFile);
    const existing = await load(p.file);
    await loadPlans(planFile, missionReferences(existing));
    const g = join(p.root, ".gitignore");
    let lines = existsSync(g) ? (await readFile(g, "utf8")).split(/\r?\n/) : [];
    const exact = (v: string) => v.trim() === ".factory/";
    lines = lines.filter((v) => !exact(v));
    if (!opts.track) lines.push(".factory/");
    while (lines.length && lines.at(-1) === "") lines.pop();
    await writeFile(g, lines.join("\n") + "\n");
    if (opts.skills) await installMissionSkills(p.root);
    output(
      { initialized: true, path: p.file, tracked: !!opts.track, skillsInstalled: !!opts.skills },
      isJson(cmd),
    );
  }),
);
const mc = jsonOption(mission.command("create"))
  .requiredOption("--title <title>")
  .option("--verification-mode <mode>", "verification mode", "standard");
mc.action(async (opts, cmd) =>
  withLock(async () => {
    const p = await paths(),
      all = await load(p.file),
      t = now(),
      m = Mission.parse({
        id: makeId("mis"),
        title: clean(opts.title),
        verificationMode: opts.verificationMode,
        createdAt: t,
        updatedAt: t,
        milestones: [],
      });
    all.push(m);
    await save(all);
    output(m, isJson(cmd));
  }),
);
const milestone = mission.command("milestone"),
  msc = jsonOption(milestone.command("create"))
    .requiredOption("--mission <id>")
    .requiredOption("--title <title>");
msc.action(async (opts, cmd) =>
  withLock(async () => {
    const p = await paths(),
      all = await load(p.file),
      m = all.find((x) => x.id === opts.mission);
    if (!m) throw Error(`Mission not found: ${opts.mission}`);
    const t = now(),
      ms = { id: makeId("mil"), title: clean(opts.title), createdAt: t, updatedAt: t, tasks: [] };
    m.milestones.push(ms);
    m.updatedAt = t;
    await save(all);
    output(ms, isJson(cmd));
  }),
);
const task = mission.command("task"),
  tc = jsonOption(task.command("create"))
    .requiredOption("--milestone <id>")
    .requiredOption("--title <title>")
    .option("--type <type>", "task type", "implementation")
    .option("--risk <risk>", "risk", "medium")
    .requiredOption("--verification <note>");
tc.action(async (opts, cmd) =>
  withLock(async () => {
    const p = await paths(),
      all = await load(p.file),
      m = all.find((x) => x.milestones.some((ms) => ms.id === opts.milestone)),
      ms = m?.milestones.find((x) => x.id === opts.milestone);
    if (!m || !ms) throw Error(`Milestone not found: ${opts.milestone}`);
    const t = now(),
      v = Task.parse({
        id: makeId("tsk"),
        title: clean(opts.title),
        type: opts.type,
        risk: opts.risk,
        verification: clean(opts.verification),
        status: "open",
        createdAt: t,
        updatedAt: t,
      });
    ms.tasks.push(v);
    ms.updatedAt = t;
    m.updatedAt = t;
    await save(all);
    output(v, isJson(cmd));
  }),
);
const list = jsonOption(mission.command("list"));
list.action(async (_, cmd) => {
  const p = await paths();
  output(await load(p.file), isJson(cmd));
});
const show = jsonOption(mission.command("show").argument("<mission-id>"));
show.action(async (idArg, _, cmd) => {
  const p = await paths(),
    m = (await load(p.file)).find((x) => x.id === idArg);
  if (!m) throw Error(`Mission not found: ${idArg}`);
  output(m, isJson(cmd));
});
const update = jsonOption(
  mission.command("update").argument("<task-id>").requiredOption("--status <status>"),
);
update.action(async (idArg, opts, cmd) => {
  if (!lifecycleStatus(opts.status))
    throw Error(`Invalid status: ${opts.status}. Expected open, in_progress, or closed`);
  if (opts.status === "closed") throw Error("Use mission close with --reason to close a task");
  return withLock(async () => {
    const p = await paths(),
      all = await load(p.file),
      found = locateTask(all, idArg);
    if (!found) throw Error(`Task not found: ${idArg}`);
    const t = now();
    found.task.status = opts.status;
    delete found.task.closureReason;
    found.task.updatedAt = t;
    found.milestone.updatedAt = t;
    found.mission.updatedAt = t;
    await save(all);
    output(found.task, isJson(cmd));
  });
});
const close = jsonOption(
  mission.command("close").argument("<task-id>").requiredOption("--reason <reason>"),
);
close.action(async (idArg, opts, cmd) =>
  withLock(async () => {
    const p = await paths(),
      all = await load(p.file),
      found = locateTask(all, idArg);
    if (!found) throw Error(`Task not found: ${idArg}`);
    const reason = clean(opts.reason),
      t = now();
    found.task.status = "closed";
    found.task.closureReason = reason;
    found.task.updatedAt = t;
    found.milestone.updatedAt = t;
    found.mission.updatedAt = t;
    await save(all);
    output(found.task, isJson(cmd));
  }),
);
const ready = jsonOption(mission.command("ready").option("--mission <mission-id>"));
ready.action(async (opts, cmd) => {
  const all = await load((await paths()).file);
  const selected = opts.mission ? all.filter((m) => m.id === opts.mission) : all;
  if (opts.mission && !selected.length) throw Error(`Mission not found: ${opts.mission}`);
  output(
    selected.flatMap((m) =>
      m.milestones.flatMap((ms) =>
        ms.tasks
          .filter((t) => t.status === "open")
          .map((task) => ({
            missionId: m.id,
            missionTitle: m.title,
            milestoneId: ms.id,
            milestoneTitle: ms.title,
            task,
          })),
      ),
    ),
    isJson(cmd),
  );
});

// Plans deliberately use the same lock and atomic JSONL writer as missions. Mission
// linkage is validation-only here; execution/link updates belong to a later command.
function missionReferences(all: MissionType[]): MissionReference[] {
  return all.map((m) => ({
    id: m.id,
    milestones: m.milestones.map((ms) => ({
      id: ms.id,
      tasks: ms.tasks.map((t) => ({ id: t.id })),
    })),
  }));
}
async function planContext() {
  const p = await paths();
  return { p };
}
async function inputJson(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    const candidate = await realpath(resolve(process.cwd(), file)),
      root = await realpath(await projectRoot()),
      rel = relative(root, candidate);
    if (rel.startsWith("..") || rel.startsWith(sep))
      throw Error("Input file must be inside the project root");
    value = JSON.parse(await readFile(candidate, "utf8"));
  } catch (e) {
    throw Error(
      e instanceof Error && e.message.includes("inside the project root")
        ? e.message
        : `Invalid JSON input: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Plan input must be a JSON object");
  return value as Record<string, unknown>;
}
function revisionToken(value: string) {
  if (!/^[1-9][0-9]*$/.test(value))
    throw Error(`Invalid revision: ${value}. Expected a positive integer`);
  return Number(value);
}
function selectedRevision(plans: Plan[], id: string, revision?: string) {
  const group = plans.filter((p) => p.id === id);
  if (!group.length) throw Error(`Plan not found: ${id}`);
  const latest = group.sort((a, b) => b.revision - a.revision)[0];
  if (revision === undefined) return latest;
  const n = revisionToken(revision);
  const selected = group.find((p) => p.revision === n);
  if (!selected) throw Error(`Plan revision not found: ${id}@${n}`);
  return selected;
}
function parsePlanInput(value: Record<string, unknown>) {
  try {
    return PlanInputSchema.parse(value);
  } catch (e) {
    if (e instanceof z.ZodError)
      throw Error(
        `${e.message}\n\nValid example: ${JSON.stringify(PLAN_INPUT_EXAMPLE)}\nRun \`factory plan create --schema\` for the full schema.`,
      );
    throw e;
  }
}
function planInput(
  value: Record<string, unknown>,
  id: string,
  revision: number,
  status: "draft" | "approved" | "superseded" | "archived",
  createdAt: string,
  updatedAt: string,
): Plan {
  const candidate = { ...parsePlanInput(value), id, revision, status, createdAt, updatedAt };
  if (status !== "approved" && status !== "superseded") delete (candidate as any).approvedAt;
  return PlanSchema.parse(candidate);
}
function validateInputPlan(value: Record<string, unknown>) {
  const t = now(),
    record = planInput(value, "pln_validation", 1, "draft", t, t);
  validatePlansAgainstMissions([record], []);
}
const plan = program.command("plan");
const materialize = jsonOption(plan.command("materialize"))
  .argument("<plan-id>")
  .option("--revision <revision>");
materialize.action(async (id, opts, cmd) =>
  withLock(async () => {
    const { p } = await planContext(),
      plans = await loadPlans(join(p.dir, "plans.jsonl"), []),
      planRecord = selectedRevision(plans, id, opts.revision);
    if (planRecord.status !== "approved") throw Error("Only an approved plan may be materialized");
    const all = await load(p.file);
    if (
      all.some(
        (m) =>
          m.sourcePlan &&
          m.sourcePlan.planId === id &&
          m.sourcePlan.revision === planRecord.revision,
      )
    )
      throw Error("Plan revision is already materialized");
    const t = now(),
      milestones = new Map<string, any>(),
      taskIds = new Map<string, string>();
    for (const step of planRecord.steps) {
      let ms = milestones.get(step.milestoneKey);
      if (!ms) {
        const def = planRecord.milestones.find((m: any) => m.key === step.milestoneKey);
        if (!def) throw Error(`Unknown milestone key: ${step.milestoneKey}`);
        ms = { id: makeId("mil"), title: def.title, createdAt: t, updatedAt: t, tasks: [] };
        milestones.set(step.milestoneKey, ms);
      }
      const tid = makeId("tsk");
      taskIds.set(step.key, tid);
      ms.tasks.push(
        Task.parse({
          id: tid,
          title: step.title,
          type: step.type,
          risk: step.risk,
          verification: step.verification,
          status: "open",
          planStepKey: step.key,
          createdAt: t,
          updatedAt: t,
        }),
      );
    }
    for (const step of planRecord.steps) {
      const task = [...milestones.values()]
        .flatMap((x: any) => x.tasks)
        .find((x: any) => x.planStepKey === step.key);
      if (task) task.dependsOn = resolveDependencies(step.dependsOn, taskIds);
    }
    const mission = Mission.parse({
      id: makeId("mis"),
      title: planRecord.missionTitle,
      verificationMode: planRecord.verificationMode,
      createdAt: t,
      updatedAt: t,
      milestones: [...milestones.values()],
      sourcePlan: { planId: id, revision: planRecord.revision },
    });
    all.push(mission);
    await save(all);
    output(mission, isJson(cmd));
  }),
);
const pc = jsonOption(
  plan
    .command("create")
    .description(
      "Create a plan from JSON. Top level: missionTitle, verificationMode, sections, milestones, steps. Example: " +
        JSON.stringify(PLAN_INPUT_EXAMPLE),
    ),
)
  .option("--input <json-file>", "JSON input file")
  .option("--schema", "Print the accepted user input schema");
pc.action(async (opts, cmd) => {
  if (opts.schema) {
    if (opts.input) throw Error("--schema is mutually exclusive with --input");
    output(z.toJSONSchema(PlanInputSchema), isJson(cmd));
    return;
  }
  if (!opts.input) throw Error("Required option '--input <json-file>' (or use --schema)");
  return withLock(async () => {
    const { p } = await planContext();
    const file = join(p.dir, "plans.jsonl"),
      all = await loadPlans(file, []),
      t = now(),
      record = planInput(await inputJson(opts.input), makeId("pln"), 1, "draft", t, t);
    validatePlansAgainstMissions([...all, record], []);
    await savePlansUnlocked([...all, record], file);
    output(record, isJson(cmd));
  });
});
const pl = jsonOption(plan.command("list"));
pl.action(async (_, cmd) => {
  const { p } = await planContext();
  output(await loadPlans(join(p.dir, "plans.jsonl"), []), isJson(cmd));
});
const ps = jsonOption(plan.command("show")).argument("<plan-id>").option("--revision <revision>");
ps.action(async (id, opts, cmd) => {
  const { p } = await planContext();
  output(
    selectedRevision(await loadPlans(join(p.dir, "plans.jsonl"), []), id, opts.revision),
    isJson(cmd),
  );
});
const pv = jsonOption(plan.command("validate"))
  .argument("[plan-id]")
  .option("--revision <revision>")
  .option("--input <json-file>");
pv.action(async (id, opts, cmd) => {
  if (opts.input && (id || opts.revision))
    throw Error("--input is mutually exclusive with plan id or --revision");
  if (opts.input) {
    validateInputPlan(await inputJson(opts.input));
    output({ valid: true, count: 1 }, isJson(cmd));
    return;
  }
  const { p } = await planContext();
  const all = await loadPlans(join(p.dir, "plans.jsonl"), []);
  const result = id ? [selectedRevision(all, id, opts.revision)] : all;
  validatePlansAgainstMissions(result, []);
  output({ valid: true, count: result.length }, isJson(cmd));
});
const pr = jsonOption(plan.command("revise"))
  .argument("<plan-id>")
  .requiredOption("--input <json-file>")
  .option("--revision <revision>");
pr.action(async (id, opts, cmd) =>
  withLock(async () => {
    const { p } = await planContext();
    const file = join(p.dir, "plans.jsonl"),
      all = await loadPlans(file, []),
      latest = selectedRevision(all, id),
      base = opts.revision === undefined ? latest : selectedRevision(all, id, opts.revision);
    if (base.revision !== latest.revision)
      throw Error(`Only the latest revision (${latest.revision}) may be selected`);
    const t = now(),
      record = PlanSchema.parse({
        ...planInput(await inputJson(opts.input), id, base.revision + 1, "draft", t, t),
        missionTitle: base.missionTitle,
        verificationMode: base.verificationMode,
      });
    const next = all.map((x) =>
      x.id === id && x.revision === base.revision
        ? { ...x, status: "superseded" as const, updatedAt: t, approvedAt: x.approvedAt ?? t }
        : x,
    );
    next.push(record);
    validatePlansAgainstMissions(next, []);
    await savePlansUnlocked(next, file);
    output(record, isJson(cmd));
  }),
);
const pa = jsonOption(plan.command("approve"))
  .argument("<plan-id>")
  .option("--revision <revision>");
pa.action(async (id, opts, cmd) =>
  withLock(async () => {
    const { p } = await planContext();
    const file = join(p.dir, "plans.jsonl"),
      all = await loadPlans(file, []),
      target = selectedRevision(all, id, opts.revision);
    if (target.status !== "draft") throw Error("Only a draft plan revision may be approved");
    const t = now(),
      next = all
        .map((x) =>
          x.id === id && x.revision === target.revision
            ? { ...x, status: "approved" as const, updatedAt: t, approvedAt: t }
            : x,
        )
        .map((x) =>
          x.id === id && x.revision !== target.revision && x.status === "approved"
            ? { ...x, status: "superseded" as const, updatedAt: t }
            : x,
        );
    validatePlansAgainstMissions(next, []);
    await savePlansUnlocked(next, file);
    output(
      next.find((x) => x.id === id && x.revision === target.revision),
      isJson(cmd),
    );
  }),
);
const par = jsonOption(plan.command("archive"))
  .argument("<plan-id>")
  .option("--revision <revision>");
par.action(async (id, opts, cmd) =>
  withLock(async () => {
    const { p } = await planContext();
    const file = join(p.dir, "plans.jsonl"),
      all = await loadPlans(file, []),
      target = selectedRevision(all, id, opts.revision);
    if (target.status === "approved") throw Error("Approved plans cannot be archived");
    const next = all
      .map((x) =>
        x === target
          ? { ...x, status: "archived" as const, updatedAt: now(), approvedAt: undefined }
          : x,
      )
      .map((x) => {
        if (x.approvedAt === undefined) {
          const y = { ...x };
          delete (y as any).approvedAt;
          return y;
        }
        return x;
      });
    validatePlansAgainstMissions(next, []);
    await savePlansUnlocked(next as Plan[], file);
    output(
      next.find((x) => x.id === id && x.revision === target.revision),
      isJson(cmd),
    );
  }),
);
program.exitOverride();
if (process.argv.includes("workflow") && process.argv.includes("--json"))
  program.configureOutput({ writeErr: () => {}, outputError: () => {} });
if (
  process.argv.includes("workflow") &&
  process.argv.includes("run") &&
  process.argv.includes("--json") &&
  !process.argv.includes("--agent")
) {
  console.log(
    JSON.stringify({
      run: null,
      accepted: false,
      error: { code: "WORKFLOW_ERROR", message: "required option '--agent <name>' not specified" },
    }),
  );
  process.exitCode = 1;
} else {
  try {
    await program.parseAsync();
  } catch (e) {
    const json = process.argv.includes("--json");
    const workflowCommand = process.argv.includes("workflow");
    if (json && workflowCommand)
      console.log(
        JSON.stringify({
          run: null,
          accepted: false,
          error: { code: "WORKFLOW_ERROR", message: e instanceof Error ? e.message : String(e) },
        }),
      );
    else if (json)
      console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    else console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
