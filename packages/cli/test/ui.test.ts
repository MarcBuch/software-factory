import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentsResponseSchema,
  TracePageSchema,
  WorkflowLaunchResponseSchema,
  WorkflowsResponseSchema,
} from "@software-factory/contracts";

import { ensureV2AgentAvailable, type V2Client } from "../src/backend";
import { createDraftPlan, PLAN_INPUT_EXAMPLE, savePlans } from "../src/plans";
import { BUILTIN_REGISTRY } from "../src/roster";
import { startUiServer } from "../src/ui";
import { type UiHost, type UiHostEvent } from "../src/ui-host-manager";
import { WorkflowAlreadyRunning, type WorkflowLaunch } from "../src/workflow-service";
import { openWorkflowStorage } from "../src/workflow-storage";

const directories: string[] = [];

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "factory-ui-"));
  directories.push(root);
  return realpath(root);
}

async function gitRepo() {
  const root = await repo();
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  Bun.spawnSync(["git", "config", "commit.gpgsign", "false"], { cwd: root });
  Bun.spawnSync(["git", "read-tree", "--empty"], { cwd: root });
  await mkdir(join(root, ".opencode"));
  return root;
}

function fakeSdkHost(directory: string) {
  const queue: UiHostEvent[] = [];
  const waiters: Array<(result: IteratorResult<UiHostEvent>) => void> = [];
  let ended = false;
  let next = 0;
  const interrupted: string[] = [];
  const stream = {
    next: () =>
      queue.length
        ? Promise.resolve({ value: queue.shift()!, done: false })
        : ended
          ? Promise.resolve({ value: undefined, done: true })
          : new Promise<IteratorResult<UiHostEvent>>((resolve) => waiters.push(resolve)),
    return: () => {
      ended = true;
      for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true } as const);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const emit = (event: UiHostEvent) => {
    const value = event as unknown as { data?: Record<string, unknown> };
    if (value.data) value.data.location = { directory };
    const resolve = waiters.shift();
    if (resolve) resolve({ value: event, done: false });
    else queue.push(event);
  };
  let connected = false;
  const host = {
    event: {
      subscribe: () => {
        if (!connected) {
          connected = true;
          emit({ type: "server.connected", data: {} } as never);
        }
        return stream;
      },
    },
    session: {
      async create(input: { id?: string }) {
        const id = input.id ?? `ses_fake_${++next}`;
        emit({ type: "session.created", data: { sessionID: id } } as never);
        return { id };
      },
      async prompt(input: { sessionID: string; text: string }) {
        emit({ type: "session.execution.started", data: { sessionID: input.sessionID } } as never);
        if (input.text.includes("backend-failure")) throw new Error("provider unavailable");
        if (input.text.includes("hold")) return new Promise<void>(() => undefined);
        emit({
          type: "session.text.delta",
          data: {
            sessionID: input.sessionID,
            delta:
              '---FACTORY_RESULT_JSON---\n{"status":"success","summary":"done","artifacts":[],"notes":[]}\n---END_FACTORY_RESULT_JSON---',
          },
        } as never);
      },
      async wait() {},
      async interrupt(input: { sessionID: string }) {
        interrupted.push(input.sessionID);
        return { interrupted: true };
      },
    },
    agent: {
      async list() {
        return {
          location: { directory },
          data: [
            { id: "scout", name: "scout" },
            { id: "plan-mission", name: "plan-mission" },
          ],
        };
      },
    },
    location: {
      async get() {
        return { directory, project: { id: "fake", directory, canonical: directory } };
      },
    },
    config: {
      async get() {
        return [{ type: "document", path: join(directory, ".opencode"), info: {} }];
      },
    },
    debug: { location: { async evict() {} } },
    message: {
      async list() {
        return { data: [], cursor: {} };
      },
    },
    close: () => stream.return(),
  } as unknown as UiHost;
  return { host, interrupted };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("UI server exposes the ordered agent catalog without prompts", async () => {
  const ui = await startUiServer({ repositoryRoot: await gitRepo(), port: 0 });
  try {
    const response = await fetch(new URL("/api/agents", ui.url));
    expect(response.status).toBe(200);
    const body = AgentsResponseSchema.parse(await response.json());
    expect(body.agents.map((agent) => agent.id)).toEqual(
      BUILTIN_REGISTRY.map((entry) => entry.agent.name),
    );
    for (const agent of body.agents) {
      expect(agent).toMatchObject({
        version: expect.any(Number),
        purpose: expect.any(String),
        model: expect.any(String),
        capabilities: expect.any(Array),
        writeBoundary: expect.any(Array),
      });
      expect(agent).not.toHaveProperty("systemPrompt");
      expect(agent).not.toHaveProperty("userPromptTemplate");
      expect(JSON.stringify(agent)).not.toMatch(/prompt/i);
    }
  } finally {
    await ui.close();
  }
});

test("workflow API launches by workflow and preserves the sessions API", async () => {
  const root = await gitRepo();
  const launches: Array<{ request: string; agentName: string }> = [];
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({
    systemPrompt: "s",
    userPrompt: "u",
    metadata: { request: "x", agentName: "planner" },
    stages: BUILTIN_REGISTRY[1]!.workflow.stages,
  });
  storage.startRun(run.id);
  const active = storage.getRun(run.id)!;
  storage.close();
  const ui = await startUiServer({
    repositoryRoot: root,
    port: 0,
    launch: async (_, input) => {
      launches.push(input);
      return { run: active, completion: Promise.resolve(active) };
    },
  });
  try {
    const catalog = WorkflowsResponseSchema.parse(
      await (await fetch(new URL("/api/workflows", ui.url))).json(),
    );
    expect(catalog.workflows[1]?.stages.map((stage) => stage.id)).toEqual(
      BUILTIN_REGISTRY[1]!.workflow.stages.map((stage) => stage.id),
    );
    const launched = await fetch(new URL("/api/workflow-runs", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "mission-planner", request: "x" }),
    });
    expect(launched.status).toBe(202);
    expect(WorkflowLaunchResponseSchema.parse(await launched.json()).run.stages).toHaveLength(4);
    expect(launches).toContainEqual({ request: "x", agentName: "planner" });
    const unknown = await fetch(new URL("/api/workflow-runs", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "missing", request: "x" }),
    });
    expect(unknown.status).toBe(400);
    const legacy = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "x", agentName: "planner" }),
    });
    expect(legacy.status).toBe(202);
  } finally {
    await ui.close();
  }
});

test("V2 UI shares one fake host without cross-talk and cleans active sessions", async () => {
  const root = await gitRepo();
  const fake = fakeSdkHost(root);
  const ui = await startUiServer({
    repositoryRoot: root,
    port: 0,
    hostFactory: async () => fake.host,
  });
  const launch = (request: string) =>
    fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, agentName: "scout" }),
    });
  try {
    const stream = await fetch(new URL("/api/events", ui.url));
    const reader = stream.body!.getReader();
    await reader.read();
    const completed = await launch("complete");
    expect(completed.status).toBe(202);
    const completedRun = (await completed.json()) as { run: { id: string } };

    const trace = await fetch(new URL(`/api/sessions/${completedRun.run.id}/trace`, ui.url));
    const traceBody = (await trace.json()) as { runId: string; events: Array<{ runId: string }> };
    expect(traceBody.runId).toBe(completedRun.run.id);
    expect(traceBody.events.every((event) => event.runId === completedRun.run.id)).toBe(true);
    const failed = await launch("backend-failure");
    expect(failed.status).toBe(202);
    const failedRun = (await failed.json()) as { run: { id: string } };
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const current = await (await fetch(new URL("/api/sessions", ui.url))).json();
      const done = current.runs.filter((run: { id: string }) =>
        [completedRun.run.id, failedRun.run.id].includes(run.id),
      );
      if (done.length === 2 && done.every((run: { status: string }) => run.status !== "running"))
        break;
      await Bun.sleep(0);
    }
    const held = await launch("hold");
    expect(held.status).toBe(202);
    const heldRun = (await held.json()) as { run: { id: string } };
    expect(heldRun.run.id).not.toBe(completedRun.run.id);
    const deleted = await fetch(new URL(`/api/sessions/${heldRun.run.id}`, ui.url), {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const sessions = await (await fetch(new URL("/api/sessions", ui.url))).json();
    expect(sessions.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: completedRun.run.id, status: "succeeded" }),
      ]),
    );
    const failure = sessions.runs.find((run: { id: string }) => run.id === failedRun.run.id);
    expect(failure).toMatchObject({ status: "failed", failure: { code: "BACKEND_FAILURE" } });
    await reader.cancel();
  } finally {
    await ui.close();
  }
  expect(fake.interrupted).toHaveLength(1);
});

test("V2 agent preflight evicts only the repository location and reloads it", async () => {
  const directory = await repo();
  const calls: string[] = [];
  let attempt = 0;
  const client = {
    agent: {
      list: async (input: { location: { directory: string } }) => {
        calls.push(`list:${input.location.directory}`);
        attempt += 1;
        return {
          location: { directory },
          data: attempt === 1 ? [] : [{ id: "scout", name: "scout" }],
        };
      },
    },
    location: {
      get: async () => ({ directory, project: { id: "fake", directory, canonical: directory } }),
    },
    config: {
      get: async () => [{ type: "document", path: join(directory, ".opencode"), info: {} }],
    },
    debug: {
      location: {
        evict: async (input: { location: { directory: string } }) => {
          calls.push(`evict:${input.location.directory}`);
        },
      },
    },
  } as unknown as V2Client;
  await mkdir(join(directory, ".opencode"));
  await ensureV2AgentAvailable(client, directory, "scout");
  expect(calls).toEqual([`list:${directory}`, `evict:${directory}`, `list:${directory}`]);
});

test("V2 workflow preflight failures are typed HTTP 502 responses without secret causes", async () => {
  const root = await gitRepo();
  const secret = "config-token-super-secret";
  const client = {
    location: {
      get: async () => {
        throw new Error(`${secret} raw transport failure`);
      },
    },
    agent: { list: async () => ({ location: { directory: root }, data: [] }) },
    debug: { location: { evict: async () => {} } },
  } as unknown as V2Client;
  const ui = await startUiServer({ repositoryRoot: root, port: 0, v2Client: client });
  try {
    const response = await fetch(new URL("/api/workflow-runs", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "mission-planner", request: "inspect" }),
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      error: "OpenCode location preflight failed",
      code: "V2_LOCATION_TRANSPORT",
      category: "transport",
      retryable: false,
      details: { directory: root, cause: { errorClass: "Error" } },
    });
    expect(JSON.stringify(body)).not.toContain(secret);
  } finally {
    await ui.close();
  }
});

test("V2 preflight rejects a location whose service path is not canonical-equivalent", async () => {
  const directory = await repo();
  await mkdir(join(directory, ".opencode"));
  const client = {
    location: {
      get: async () => ({ directory: "/tmp/other", project: { directory: "/tmp/other" } }),
    },
    agent: {
      list: async () => ({
        location: { directory: "/tmp/other" },
        data: [{ id: "scout", name: "scout" }],
      }),
    },
    config: {
      get: async () => [{ type: "document", path: join(directory, ".opencode"), info: {} }],
    },
    debug: { location: { evict: async () => {} } },
  } as unknown as V2Client;
  await expect(ensureV2AgentAvailable(client, directory, "scout")).rejects.toMatchObject({
    code: "V2_LOCATION_MISMATCH",
  });
});

test("V2 preflight does not require repository-local config", async () => {
  const directory = await repo();
  const client = {
    location: { get: async () => ({ directory, project: { directory } }) },
    agent: {
      list: async () => ({ location: { directory }, data: [{ id: "scout", name: "scout" }] }),
    },
    config: { get: async () => [] },
    debug: { location: { evict: async () => {} } },
  } as unknown as V2Client;
  await expect(ensureV2AgentAvailable(client, directory, "scout")).resolves.toBeUndefined();
});

test("V2 UI shutdown interrupts active sessions before closing the shared host", async () => {
  const root = await gitRepo();
  const fake = fakeSdkHost(root);
  const ui = await startUiServer({
    repositoryRoot: root,
    port: 0,
    hostFactory: async () => fake.host,
  });
  const response = await fetch(new URL("/api/sessions", ui.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: "hold", agentName: "scout" }),
  });
  expect(response.status).toBe(202);
  const run = (await response.json()) as { run: { id: string } };
  await ui.close();
  expect(fake.interrupted).toHaveLength(1);
  const storage = await openWorkflowStorage(root);
  expect(storage.getRun(run.run.id)?.status).toBe("cancelled");
  storage.close();
});

test("UI restart stops a persisted service but preserves evidence without completion ownership", async () => {
  const root = await repo();
  const fake = fakeSdkHost(root);
  (fake.host.session as any).active = async () => ({ persisted: { id: "persisted" } });
  const storage = await openWorkflowStorage(root);
  let run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(run.id);
  storage.setAgentProcess(run.id, {
    agentName: "scout",
    sessionId: "persisted",
    executionKind: "service",
  });
  run = storage.getRun(run.id)!;
  storage.close();

  const ui = await startUiServer({
    repositoryRoot: root,
    port: 0,
    hostFactory: async () => fake.host,
    shutdownGraceMs: 100,
  });
  try {
    const deleted = await fetch(new URL(`/api/runs/${run.id}`, ui.url), { method: "DELETE" });
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toEqual({
      error: `Workflow completion unavailable after service restart: ${run.id}`,
    });
    expect(fake.interrupted).toEqual(["persisted"]);
    expect(existsSync(run.files.directory)).toBe(true);
    const persisted = await openWorkflowStorage(root);
    expect(persisted.getRun(run.id)).toMatchObject({ status: "cancelled" });
    persisted.close();
  } finally {
    await ui.close();
  }
});

test("UI delete waits for the owned completion before removing run artifacts", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  let run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(run.id);
  storage.setAgentProcess(run.id, {
    agentName: "scout",
    sessionId: "session",
    executionKind: "embedded",
  });
  run = storage.getRun(run.id)!;
  storage.close();
  const completion = (async () => {
    await Bun.sleep(20);
    await writeFile(run.files.result, '{"status":"cancelled"}\n');
    return run;
  })();
  const ui = await startUiServer({
    repositoryRoot: root,
    port: 0,
    shutdownGraceMs: 100,
    launch: async () => ({ run, completion }),
  });
  try {
    const launched = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "hold", agentName: "scout" }),
    });
    expect(launched.status).toBe(202);
    const deleted = await fetch(new URL(`/api/runs/${run.id}`, ui.url), { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, runId: run.id });
    expect(existsSync(run.files.directory)).toBe(false);
  } finally {
    await ui.close();
  }
});

test("UI delete preserves artifacts when owned completion rejects or times out", async () => {
  const exercise = async (
    completion: WorkflowLaunch["completion"],
    expectedError: string | ((runId: string) => string),
    grace: number,
  ) => {
    const root = await repo();
    const storage = await openWorkflowStorage(root);
    let run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
    storage.startRun(run.id);
    storage.setAgentProcess(run.id, { agentName: "scout", executionKind: "embedded" });
    run = storage.getRun(run.id)!;
    storage.close();
    const ui = await startUiServer({
      repositoryRoot: root,
      port: 0,
      shutdownGraceMs: grace,
      launch: async () => ({ run, completion }),
    });
    try {
      const launched = await fetch(new URL("/api/sessions", ui.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: "hold", agentName: "scout" }),
      });
      expect(launched.status).toBe(202);
      const deleted = await fetch(new URL(`/api/runs/${run.id}`, ui.url), { method: "DELETE" });
      expect(deleted.status).toBe(409);
      expect(await deleted.json()).toEqual({
        error: typeof expectedError === "function" ? expectedError(run.id) : expectedError,
      });
      expect(existsSync(run.files.directory)).toBe(true);
    } finally {
      await ui.close();
    }
  };

  await exercise(
    (async () => {
      await Bun.sleep(100);
      throw new Error("cleanup failed");
    })(),
    "Workflow completion failed: cleanup failed",
    200,
  );
  await exercise(
    new Promise<Awaited<WorkflowLaunch["completion"]>>(() => undefined),
    (id) => `Workflow completion timed out: ${id}`,
    10,
  );
});

test("UI session delete API removes terminal sessions and rejects missing or active sessions", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const terminal = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(terminal.id);
  storage.finishRun(terminal.id, "succeeded");
  const active = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(active.id);
  storage.close();

  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const remove = await fetch(new URL(`/api/sessions/${terminal.id}`, ui.url), {
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ deleted: true, runId: terminal.id });

    const missing = await fetch(new URL(`/api/runs/${terminal.id}`, ui.url), { method: "DELETE" });
    expect(missing.status).toBe(404);

    const running = await fetch(new URL(`/api/sessions/${active.id}`, ui.url), {
      method: "DELETE",
    });
    expect(running.status).toBe(409);
  } finally {
    ui.close();
  }
});

test("UI plan delete API uses the atomic plan cascade and reports counts", async () => {
  const root = await repo();
  const planFile = join(root, ".factory", "plans.jsonl");
  const plan = await createDraftPlan(PLAN_INPUT_EXAMPLE, planFile, root);
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL(`/api/plans/${plan.id}`, ui.url), { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: true,
      planId: plan.id,
      revisionsDeleted: 1,
      missionsDeleted: 0,
    });

    const missing = await fetch(new URL(`/api/plans/${plan.id}`, ui.url), { method: "DELETE" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: `Plan not found: ${plan.id}` });
  } finally {
    ui.close();
  }
});

test("UI session launch API validates input and returns accepted runs", async () => {
  const root = await repo();
  const launches: Array<{ request: string; agentName: string }> = [];
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({
    systemPrompt: "s",
    userPrompt: "u",
    metadata: { request: "inspect", agentName: "scout" },
  });
  storage.startRun(run.id);
  const active = storage.getRun(run.id)!;
  const failedRun = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(failedRun.id);
  storage.finishRun(failedRun.id, "failed", { code: "BACKEND_FAILURE", message: "missing" });
  const failed = storage.getRun(failedRun.id)!;
  storage.close();
  const ui = await startUiServer({
    repositoryRoot: root,
    port: 0,
    launch: async (_, input) => {
      launches.push(input);
      if (input.request === "busy") throw new WorkflowAlreadyRunning();
      if (input.request === "failed") return { run: failed, completion: Promise.resolve(failed) };
      return { run: active, completion: Promise.resolve(active) };
    },
  });
  try {
    const invalid = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "", agentName: "scout", extra: true }),
    });
    expect(invalid.status).toBe(400);

    const accepted = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "inspect", agentName: "scout" }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true, run: { id: run.id } });
    expect(launches).toContainEqual({ request: "inspect", agentName: "scout" });

    const planner = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "plan notifications", agentName: "planner" }),
    });
    expect(planner.status).toBe(202);
    expect(launches).toContainEqual({ request: "plan notifications", agentName: "planner" });

    const busy = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "busy", agentName: "scout" }),
    });
    expect(busy.status).toBe(409);

    const failedResponse = await fetch(new URL("/api/sessions", ui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "failed", agentName: "scout" }),
    });
    expect(failedResponse.status).toBe(500);
    expect(await failedResponse.json()).toMatchObject({
      accepted: false,
      run: { id: failed.id, failure: { message: "missing" } },
    });

    const unsupported = await fetch(new URL("/api/runs", ui.url), { method: "POST" });
    expect(unsupported.status).toBe(404);
  } finally {
    ui.close();
  }
});

test("UI serves client routes but not missing assets or API routes", async () => {
  const root = await repo();
  const assets = await mkdtemp(join(tmpdir(), "factory-assets-"));
  directories.push(assets);
  await mkdir(join(assets, "assets"));
  await writeFile(join(assets, "index.html"), "<!doctype html><main>app</main>");
  await writeFile(join(assets, "assets/exact.js"), "console.log('exact')");
  const ui = await startUiServer({ repositoryRoot: root, assetsDirectory: assets, port: 0 });
  try {
    for (const path of ["/workspace", "/runs", "/runs/run_old"]) {
      const response = await fetch(new URL(path, ui.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("app");
    }
    expect((await fetch(new URL("/assets/exact.js", ui.url))).status).toBe(200);
    expect((await fetch(new URL("/missing.js", ui.url))).status).toBe(404);
    expect((await fetch(new URL("/missing.css", ui.url))).status).toBe(404);
    expect((await fetch(new URL("/api", ui.url))).status).toBe(404);
    expect((await fetch(new URL("/api/missing", ui.url))).status).toBe(404);
    expect((await fetch(new URL("/workspace", ui.url), { method: "POST" })).status).toBe(404);
  } finally {
    ui.close();
  }
});

test("trace API includes the validated public run metadata", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({
    systemPrompt: "s",
    userPrompt: "u",
    metadata: { request: "inspect", agentName: "scout", private: "hidden" },
  });
  storage.startRun(run.id);
  storage.finishRun(run.id, "succeeded");
  storage.close();
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL(`/api/runs/${run.id}/trace`, ui.url));
    expect(response.status).toBe(200);
    const page = TracePageSchema.parse(await response.json());
    expect(page).toMatchObject({
      publicRun: {
        id: run.id,
        status: "succeeded",
        metadata: { request: "inspect", agentName: "scout" },
      },
    });
    expect(page.publicRun?.finishedAt).not.toBeNull();
  } finally {
    ui.close();
  }
});

test("trace API includes agents independent of events and preserves pagination fields", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(run.id);
  storage.setAgentProcess(run.id, { agentName: "planner", executionKind: "embedded" });
  storage.appendTrace({
    runId: run.id,
    at: "2026-01-01T00:00:00.000Z",
    type: "agent_started",
    agentName: "planner",
  });
  storage.setAgentProcess(run.id, { agentName: "scout", executionKind: "embedded" });
  storage.clearAgentProcess(run.id, "planner");
  storage.close();
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL(`/api/runs/${run.id}/trace?limit=1`, ui.url));
    expect(response.status).toBe(200);
    const page = TracePageSchema.parse(await response.json());
    expect(page).toMatchObject({
      runId: run.id,
      hasMore: true,
      summary: { cost: 0 },
      publicRun: { id: run.id, status: "running" },
    });
    expect(page.events).toHaveLength(1);
    expect(page.agents?.map(({ name }) => name)).toEqual(["planner", "scout"]);
    expect(page.agents?.find(({ name }) => name === "scout")?.finishedAt).toBeNull();
    for (const agent of page.agents ?? []) {
      if (agent.finishedAt)
        expect(Date.parse(agent.finishedAt)).toBeGreaterThanOrEqual(Date.parse(agent.startedAt));
    }
    expect(page.nextCursor).toEqual(expect.any(Number));
  } finally {
    ui.close();
  }
});

test("trace and sessions aliases have identical additive pages and nullable running metadata", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(run.id, "2026-01-01T00:00:00.000Z");
  storage.appendTrace({
    runId: run.id,
    at: "2026-01-01T00:00:01.000Z",
    type: "model_step",
    agentName: "scout",
    usage: { input: 2, output: 3, total: 5 },
    cost: { amount: 0.25, currency: "USD" },
  });
  storage.close();
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const query = "?limit=1";
    const runsAlias = TracePageSchema.parse(
      await (await fetch(new URL(`/api/runs/${run.id}/trace${query}`, ui.url))).json(),
    );
    const sessionsAlias = TracePageSchema.parse(
      await (await fetch(new URL(`/api/sessions/${run.id}/trace${query}`, ui.url))).json(),
    );
    expect(sessionsAlias).toEqual(runsAlias);
    expect(runsAlias).toMatchObject({
      runId: run.id,
      hasMore: true,
      summary: { usage: { input: 2, output: 3, total: 5 }, cost: 0.25 },
      publicRun: { id: run.id, status: "running" },
    });
    expect(runsAlias.publicRun).not.toHaveProperty("finishedAt");
    expect(runsAlias.events[0]).toHaveProperty("id");
    expect(runsAlias.nextCursor).toEqual(expect.any(Number));

    const tail = TracePageSchema.parse(
      await (
        await fetch(new URL(`/api/sessions/${run.id}/trace?after=${runsAlias.nextCursor}`, ui.url))
      ).json(),
    );
    expect(tail.events).toHaveLength(1);
    expect(tail.events[0]).toMatchObject({ runId: run.id, type: "model_step" });
    expect(tail.hasMore).toBe(false);
    expect(tail.summary).toEqual(runsAlias.summary);
    expect(tail.publicRun).toEqual(runsAlias.publicRun);
  } finally {
    ui.close();
  }
});

test("trace API returns an empty agents list when no agents participated", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.close();
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL(`/api/runs/${run.id}/trace`, ui.url));
    expect(response.status).toBe(200);
    expect(TracePageSchema.parse(await response.json()).agents).toEqual([]);
  } finally {
    ui.close();
  }
});

test("plans API returns valid stored current plan revisions", async () => {
  const root = await repo();
  const file = join(root, ".factory", "plans.jsonl");
  const first = await createDraftPlan({ ...PLAN_INPUT_EXAMPLE, missionTitle: "First plan" }, file);
  const second = await createDraftPlan(
    { ...PLAN_INPUT_EXAMPLE, missionTitle: "Second plan" },
    file,
  );
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL("/api/plans", ui.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([first, second]);
  } finally {
    ui.close();
  }
});

test("plans API returns only the latest revision for each plan ID", async () => {
  const root = await repo();
  const file = join(root, ".factory", "plans.jsonl");
  const first = await createDraftPlan({ ...PLAN_INPUT_EXAMPLE, missionTitle: "First plan" }, file);
  const latest = {
    ...first,
    revision: 2,
    status: "draft" as const,
    createdAt: new Date(Date.parse(first.createdAt) + 1_000).toISOString(),
    updatedAt: new Date(Date.parse(first.updatedAt) + 1_000).toISOString(),
  };
  await savePlans(
    [{ ...first, status: "superseded", approvedAt: first.updatedAt }, latest],
    [],
    file,
  );
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL("/api/plans", ui.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([latest]);
  } finally {
    ui.close();
  }
});

test("plans API returns an empty list when plan storage is absent", async () => {
  const root = await repo();
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(new URL("/api/plans", ui.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  } finally {
    ui.close();
  }
});

test("artifact API serves a declared architecture document", async () => {
  const root = await repo();
  const artifactPath = "docs/brief.html";
  const contents = "<!doctype html><h1>brief</h1>";
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, artifactPath), contents);
  const file = join(root, ".factory", "plans.jsonl");
  const plan = await createDraftPlan(
    { ...PLAN_INPUT_EXAMPLE, externalArtifacts: [{ path: artifactPath }] },
    file,
  );
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(
      new URL(
        `/api/plans/${encodeURIComponent(plan.id)}/artifact?path=${encodeURIComponent(artifactPath)}`,
        ui.url,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(contents);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
  } finally {
    ui.close();
  }
});

test("artifact API rejects unauthorized and unsupported requests", async () => {
  const root = await repo();
  const htmlPath = "docs/brief.html";
  const notesPath = "notes.md";
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, htmlPath), "<!doctype html><h1>brief</h1>");
  await writeFile(join(root, notesPath), "notes");
  const file = join(root, ".factory", "plans.jsonl");
  const plan = await createDraftPlan(
    {
      ...PLAN_INPUT_EXAMPLE,
      externalArtifacts: [{ path: htmlPath }, { path: notesPath }],
    },
    file,
  );
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    for (const [planId, artifactPath] of [
      ["pln_missing", htmlPath],
      [plan.id, "docs/other.html"],
      [plan.id, "../../etc/passwd"],
      [plan.id, notesPath],
    ]) {
      const response = await fetch(
        new URL(
          `/api/plans/${encodeURIComponent(planId)}/artifact?path=${encodeURIComponent(artifactPath)}`,
          ui.url,
        ),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
  } finally {
    ui.close();
  }
});

test("artifact API reports a declared artifact missing from disk", async () => {
  const root = await repo();
  const artifactPath = "docs/brief.html";
  await mkdir(join(root, "docs"), { recursive: true });
  const artifactFile = join(root, artifactPath);
  await writeFile(artifactFile, "<!doctype html><h1>brief</h1>");
  const file = join(root, ".factory", "plans.jsonl");
  const plan = await createDraftPlan(
    { ...PLAN_INPUT_EXAMPLE, externalArtifacts: [{ path: artifactPath }] },
    file,
  );
  await rm(artifactFile);
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(
      new URL(
        `/api/plans/${encodeURIComponent(plan.id)}/artifact?path=${encodeURIComponent(artifactPath)}`,
        ui.url,
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "artifact file is missing" });
  } finally {
    ui.close();
  }
});

test("artifact API authorizes against the latest plan revision", async () => {
  const root = await repo();
  const artifactPath = "docs/brief.html";
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, artifactPath), "<!doctype html><h1>brief</h1>");
  const file = join(root, ".factory", "plans.jsonl");
  const first = await createDraftPlan(
    { ...PLAN_INPUT_EXAMPLE, externalArtifacts: [{ path: artifactPath }] },
    file,
  );
  const latest = {
    ...first,
    revision: 2,
    status: "draft" as const,
    externalArtifacts: [],
    createdAt: new Date(Date.parse(first.createdAt) + 1_000).toISOString(),
    updatedAt: new Date(Date.parse(first.updatedAt) + 1_000).toISOString(),
  };
  await savePlans(
    [{ ...first, status: "superseded", approvedAt: first.updatedAt }, latest],
    [],
    file,
  );
  const ui = await startUiServer({ repositoryRoot: root, port: 0 });
  try {
    const response = await fetch(
      new URL(
        `/api/plans/${encodeURIComponent(first.id)}/artifact?path=${encodeURIComponent(artifactPath)}`,
        ui.url,
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  } finally {
    ui.close();
  }
});
