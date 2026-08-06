import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, total: 15 },
    cost: { amount: 0.0123, currency: "USD" },
  });
  expect(storage.trace(run.id)).toHaveLength(2);
  expect(storage.trace(run.id)[1]).toMatchObject({
    usage: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, total: 15 },
    cost: { amount: 0.0123, currency: "USD" },
  });
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

test("supports newest-first run pages and incremental trace polling", async () => {
  const storage = await openWorkflowStorage(await repo());
  const first = await storage.createRun({
    systemPrompt: "s",
    userPrompt: "one",
    metadata: { agent: "a" },
  });
  storage.startRun(first.id, "2026-01-01T00:00:00.000Z");
  storage.appendTrace({
    runId: first.id,
    at: "2026-01-01T00:00:01.000Z",
    type: "error",
    message: "x",
  });
  const second = await storage.createRun({ systemPrompt: "s", userPrompt: "two" });
  const page = storage.listRuns({ limit: 1 });
  expect(page.runs[0]?.id).toBe(second.id);
  expect(page.nextCursor).toBeDefined();
  expect(storage.listRuns({ limit: 1, before: page.nextCursor }).runs[0]?.id).toBe(first.id);
  expect(storage.getRun(first.id)?.metadata).toEqual({ agent: "a" });
  const trace = storage.tracePage(first.id, { limit: 1 });
  expect(trace.events).toHaveLength(1);
  expect(trace.nextCursor).toBeDefined();
  const tail = storage.tracePage(first.id, { after: trace.nextCursor });
  expect(tail.events).toHaveLength(1);
  expect(storage.tracePage(first.id, { after: tail.nextCursor }).events).toHaveLength(0);
  storage.close();
});

test("deletes terminal run records, traces, and artifacts", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(run.id);
  storage.appendTrace({
    runId: run.id,
    at: "2026-01-01T00:00:01.000Z",
    type: "error",
    message: "x",
  });
  storage.finishRun(run.id, "failed", { code: "FAILURE", message: "x" });
  const before = storage.changeToken();
  await storage.deleteRun(run.id);
  expect(storage.getRun(run.id)).toBeUndefined();
  expect(storage.trace(run.id)).toEqual([]);
  await expect(stat(run.files.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(storage.changeToken().runCount).toBe(before.runCount - 1);

  const pending = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  await expect(storage.deleteRun(pending.id)).rejects.toThrow("non-terminal");
  storage.startRun(pending.id);
  await expect(storage.deleteRun(pending.id)).rejects.toThrow("non-terminal");
  storage.close();
});

test("deletes a terminal record when its artifact directory is already missing", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.startRun(run.id);
  storage.finishRun(run.id, "succeeded");
  await rm(run.files.directory, { recursive: true });
  await storage.deleteRun(run.id);
  expect(storage.getRun(run.id)).toBeUndefined();
  storage.close();
});
