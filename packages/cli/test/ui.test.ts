import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startUiServer } from "../src/ui";
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
