import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
