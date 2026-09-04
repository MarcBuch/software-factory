import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EffectiveRunDefinition } from "../src/workflow";
import { openWorkflowStorage } from "../src/workflow-storage";

async function repo() {
  return mkdtemp(join(tmpdir(), "factory-storage-"));
}

async function databaseRoot() {
  const root = await repo();
  await mkdir(join(root, ".factory"));
  return root;
}

const definition: EffectiveRunDefinition = {
  schemaVersion: 1,
  agent: { id: "builder", version: 1, provenance: "builtin" },
  workflow: { id: "workflow", version: 1, agent: "builder", provenance: "builtin" },
  runtime: { id: "opencode", adapterId: "opencode-cli-v1", capabilities: [], model: "model" },
  completionContract: "factory-result-json-v1",
  policy: { capabilities: [], writeBoundary: ["src"] },
};

test("definition writes once, is schema-shaped, and excludes secrets and request text", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({
    systemPrompt: "SYSTEM-CREDENTIAL-123",
    userPrompt: "USER-REQUEST-456",
  });
  await storage.writeDefinition(run.id, definition);
  const persisted = JSON.parse(await readFile(run.files.definition, "utf8"));
  const allowed: Record<string, string[]> = {
    root: ["schemaVersion", "agent", "workflow", "runtime", "completionContract", "policy"],
    agent: ["id", "version", "provenance"],
    workflow: ["id", "version", "agent", "provenance"],
    runtime: ["id", "adapterId", "capabilities", "model", "profile"],
    policy: ["capabilities", "writeBoundary"],
  };
  const visit = (value: unknown, kind = "root"): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      expect(allowed[kind] ?? []).toContain(key);
      visit((value as Record<string, unknown>)[key], key);
    }
  };
  visit(persisted);
  const serialized = JSON.stringify(persisted);
  expect(serialized).not.toContain("SYSTEM-CREDENTIAL-123");
  expect(serialized).not.toContain("USER-REQUEST-456");
  expect(serialized).not.toContain("credential");
  await expect(storage.writeDefinition(run.id, definition)).rejects.toThrow("already exists");
  storage.close();
});

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

test("migrates a pre-migration database and can be opened repeatedly", async () => {
  const root = await databaseRoot();
  const database = new Database(join(root, ".factory", "workflow.sqlite"));
  database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, repository_root TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, failure_json TEXT,
      system_prompt_path TEXT NOT NULL, user_prompt_path TEXT NOT NULL,
      raw_stream_path TEXT NOT NULL, result_path TEXT NOT NULL, metadata_path TEXT NOT NULL,
      child_pid INTEGER, session_id TEXT
    );
    CREATE TABLE agents (run_id TEXT NOT NULL, agent_name TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, child_pid INTEGER, session_id TEXT, PRIMARY KEY (run_id, agent_name));
    CREATE TABLE trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      at TEXT NOT NULL, type TEXT NOT NULL, agent_name TEXT, tool TEXT, status TEXT,
      payload_json TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, cost_amount REAL, cost_currency TEXT);
  `);
  database.close();

  const first = await openWorkflowStorage(root);
  expect(first.database.query("PRAGMA table_info(runs)").all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "execution_kind" }),
      expect.objectContaining({ name: "cancellation_requested" }),
    ]),
  );
  first.close();
  const second = await openWorkflowStorage(root);
  second.close();
});

test("migrates a partially migrated database without re-adding columns", async () => {
  const root = await databaseRoot();
  const database = new Database(join(root, ".factory", "workflow.sqlite"));
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, repository_root TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, failure_json TEXT, system_prompt_path TEXT NOT NULL,
      user_prompt_path TEXT NOT NULL, raw_stream_path TEXT NOT NULL, result_path TEXT NOT NULL,
      metadata_path TEXT NOT NULL, child_pid INTEGER, session_id TEXT,
      process_identity TEXT, execution_kind TEXT);
    CREATE TABLE trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  database.close();
  const storage = await openWorkflowStorage(root);
  expect(
    storage.database
      .query<{ name: string }, []>("PRAGMA table_info(runs)")
      .all()
      .map((column) => column.name),
  ).toContain("cancellation_requested");
  storage.close();
});

test("rejects unknown persisted execution kinds", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.database.query("UPDATE runs SET execution_kind='unknown' WHERE id=?").run(run.id);
  expect(() => storage.getRun(run.id)).toThrow("Unknown persisted execution kind");
  storage.close();
});

test("propagates migration failures instead of treating them as already migrated", async () => {
  const root = await databaseRoot();
  const database = new Database(join(root, ".factory", "workflow.sqlite"));
  database.exec("CREATE VIEW runs AS SELECT 1 AS id; PRAGMA user_version = 1;");
  database.close();
  await expect(openWorkflowStorage(root)).rejects.toThrow();
});

test("guards lifecycle transitions and validates terminal failures", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  expect(() => storage.finishRun(run.id, "succeeded")).toThrow();
  storage.startRun(run.id);
  expect(() => storage.startRun(run.id)).toThrow();
  expect(() => storage.finishRun(run.id, "failed")).toThrow();
  storage.finishRun(run.id, "succeeded");
  expect(storage.finishRun(run.id, "cancelled")?.status).toBe("succeeded");
  expect(storage.trace(run.id).filter((x) => x.type === "run_started")).toHaveLength(1);
  storage.close();
});

test("serializes cancellation requests against success and failure completion", async () => {
  const storage = await openWorkflowStorage(await repo());
  const makeRunning = async () => {
    const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
    storage.startRun(run.id);
    return run;
  };

  const successAfterStop = await makeRunning();
  expect(storage.requestCancellation(successAfterStop.id).accepted).toBe(true);
  expect(storage.finishRun(successAfterStop.id, "succeeded")?.status).toBe("cancelled");
  expect(storage.requestCancellation(successAfterStop.id).accepted).toBe(false);

  const failureAfterStop = await makeRunning();
  expect(storage.requestCancellation(failureAfterStop.id).accepted).toBe(true);
  expect(
    storage.finishRun(failureAfterStop.id, "failed", { code: "BACKEND_FAILURE", message: "x" })
      ?.status,
  ).toBe("cancelled");

  const successBeforeStop = await makeRunning();
  expect(storage.finishRun(successBeforeStop.id, "succeeded")?.status).toBe("succeeded");
  expect(storage.requestCancellation(successBeforeStop.id).accepted).toBe(false);

  const failureBeforeStop = await makeRunning();
  expect(
    storage.finishRun(failureBeforeStop.id, "failed", { code: "BACKEND_FAILURE", message: "x" })
      ?.status,
  ).toBe("failed");
  expect(storage.requestCancellation(failureBeforeStop.id).accepted).toBe(false);
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

test("persists service execution identity without inventing a child PID", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.setAgentProcess(run.id, {
    agentName: "builder",
    executionKind: "service",
    sessionId: "v2-session",
    pid: 0,
    identity: "must-not-persist",
  });
  expect(storage.getRun(run.id)).toMatchObject({
    executionKind: "service",
    sessionId: "v2-session",
  });
  expect(storage.getRun(run.id)?.childPid).toBeUndefined();
  expect(storage.getRun(run.id)?.processIdentity).toBeUndefined();
  storage.close();
});

test("reads legacy embedded execution identity without rewriting the SQLite row", async () => {
  const storage = await openWorkflowStorage(await repo());
  const run = await storage.createRun({ systemPrompt: "s", userPrompt: "u" });
  storage.database.query("UPDATE runs SET execution_kind='embedded' WHERE id=?").run(run.id);
  expect(storage.getRun(run.id)).toMatchObject({ executionKind: "embedded" });
  expect(storage.database.query("SELECT execution_kind FROM runs WHERE id=?").get(run.id)).toEqual({
    execution_kind: "embedded",
  });
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
