import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openWorkflowStorage } from "../src/workflow-storage";

async function repo() {
  return mkdtemp(join(tmpdir(), "factory-storage-"));
}

test("creates private run artifacts and persists normalized traces", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({
    systemPrompt: "system",
    userPrompt: "user",
    metadata: { x: 1 },
  });
  expect(run.id).toMatch(/^run_[a-f0-9]{32}$/);
  expect(await readFile(run.files.systemPrompt, "utf8")).toBe("system");
  expect(await readFile(run.files.userPrompt, "utf8")).toBe("user");
  await expect(stat(run.files.result)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(run.files.directory)).mode & 0o777).toBe(0o700);
  storage.startRun(run.id, "2026-01-01T00:00:00.000Z");
  storage.appendTrace({
    runId: run.id,
    at: "2026-01-01T00:00:01.000Z",
    type: "tool_call",
    agentName: "a",
    tool: "x",
    usage: { input: 1, output: 2, total: 3 },
  });
  expect(storage.trace(run.id)).toHaveLength(2);
  storage.close();
});

test("guards lifecycle transitions and validates terminal failures", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  expect(() => storage.finishRun(run.id, "succeeded")).toThrow();
  storage.startRun(run.id);
  expect(() => storage.startRun(run.id)).toThrow();
  expect(() => storage.finishRun(run.id, "failed")).toThrow();
  storage.finishRun(run.id, "succeeded");
  expect(() => storage.finishRun(run.id, "cancelled")).toThrow();
  expect(storage.trace(run.id).filter((x) => x.type === "run_started")).toHaveLength(1);
  storage.close();
});

test("updates pid and backend session and cleans partial artifacts", async () => {
  const root = await repo();
  const storage = await openWorkflowStorage(root);
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.setAgentProcess(run.id, { agentName: "builder", pid: 123, sessionId: "session" });
  expect(storage.getRun(run.id)).toMatchObject({ childPid: 123, sessionId: "session" });
  storage.setAgentProcess(run.id, { agentName: "builder", pid: 123 });
  expect(storage.getRun(run.id)?.sessionId).toBe("session");
  storage.clearAgentProcess(run.id);
  expect(storage.getRun(run.id)).toMatchObject({ sessionId: "session" });
  storage.startRun(run.id);
  const bad: any = {};
  bad.self = bad;
  await expect(
    storage.createRun({ systemPrompt: "s", userPrompt: "u", metadata: bad }),
  ).rejects.toThrow();
  expect(
    (await Bun.$`ls -1 ${join(root, ".factory", "runs")}`.text()).trim().split("\n"),
  ).toHaveLength(1);
  storage.close();
});
