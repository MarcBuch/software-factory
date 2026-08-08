import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDraftPlan, PLAN_INPUT_EXAMPLE, savePlans } from "../src/plans";
import { startUiServer } from "../src/ui";
import { WorkflowAlreadyRunning } from "../src/workflow-service";
import { openWorkflowStorage } from "../src/workflow-storage";

const directories: string[] = [];

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "factory-ui-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
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
    expect(await response.json()).toMatchObject({
      publicRun: {
        id: run.id,
        status: "succeeded",
        metadata: { request: "inspect", agentName: "scout" },
      },
    });
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
