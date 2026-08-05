import { expect, test } from "bun:test";

import { parseFinalAssistantResult } from "../src/completion";
import {
  BUILTIN_ROSTER_VERSION,
  RESULT_INSTRUCTIONS,
  getRosterEntry,
  lookupRoster,
  renderAgentPrompts,
} from "../src/roster";
import {
  AgentResultSchema,
  ArtifactRecordSchema,
  BackendInvocationSchema,
  BackendResultSchema,
  RunSchema,
  TraceEventSchema,
  WorkflowInputSchema,
} from "../src/workflow";

const result = { status: "success" as const, summary: "done", artifacts: [], notes: [] };

test("workflow contracts accept valid domain records", () => {
  expect(WorkflowInputSchema.parse({ request: "Build it", agentName: "builder" })).toEqual({
    request: "Build it",
    agentName: "builder",
  });
  expect(
    ArtifactRecordSchema.parse({ path: "src/output.ts", kind: "source", description: "Output" }),
  ).toBeDefined();
  expect(AgentResultSchema.parse(result)).toEqual(result);
  expect(
    RunSchema.parse({
      id: "run_1",
      status: "succeeded",
      startedAt: "2026-01-01T01:00:00+01:00",
      finishedAt: "2026-01-01T01:00:01+01:00",
    }).status,
  ).toBe("succeeded");
  expect(
    TraceEventSchema.parse({ runId: "run_1", at: "2026-01-01T00:00:00Z", type: "run_started" }),
  ).toBeDefined();
  expect(
    BackendInvocationSchema.parse({
      agent: {
        name: "builder",
        purpose: "Build",
        model: "model",
        systemPrompt: "System",
        userPromptTemplate: "Request: {{request}}",
        allowedTools: [],
        writeBoundary: ["src"],
      },
      prompt: "Build it",
      tools: [],
    }),
  ).toBeDefined();
  expect(
    TraceEventSchema.parse({
      runId: "run_1",
      at: "2026-01-01T00:00:01Z",
      type: "run_finished",
      status: "succeeded",
      usage: { input: 2, output: 3, total: 5 },
    }),
  ).toBeDefined();
  expect(BackendResultSchema.parse({ result })).toEqual({ result });
});

test("runs accept every valid lifecycle state", () => {
  expect(RunSchema.parse({ id: "pending", status: "pending" }).status).toBe("pending");
  expect(
    RunSchema.parse({
      id: "running",
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
    }).status,
  ).toBe("running");
  for (const status of ["succeeded", "cancelled"] as const)
    expect(
      RunSchema.parse({
        id: status,
        status,
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
      }).status,
    ).toBe(status);
  expect(
    RunSchema.parse({
      id: "failed",
      status: "failed",
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      failure: { code: "ERR", message: "failed" },
    }).status,
  ).toBe("failed");
});

test("trace events accept valid event variants", () => {
  const base = { runId: "r", at: "2026-01-01T00:00:00Z" };
  expect(TraceEventSchema.parse({ ...base, type: "run_started" }).type).toBe("run_started");
  for (const status of ["succeeded", "failed", "cancelled"] as const)
    expect(TraceEventSchema.parse({ ...base, type: "run_finished", status }).type).toBe(
      "run_finished",
    );
  expect(TraceEventSchema.parse({ ...base, type: "agent_started", agentName: "a" }).type).toBe(
    "agent_started",
  );
  expect(
    TraceEventSchema.parse({ ...base, type: "agent_finished", agentName: "a", result }).type,
  ).toBe("agent_finished");
  expect(
    TraceEventSchema.parse({ ...base, type: "tool_call", agentName: "a", tool: "x" }).type,
  ).toBe("tool_call");
  expect(TraceEventSchema.parse({ ...base, type: "error", message: "oops" }).type).toBe("error");
});

test("built-in scout roster lookup and prompt rendering are deterministic", () => {
  expect(BUILTIN_ROSTER_VERSION).toBe(1);
  const scout = getRosterEntry("scout");
  expect(scout?.name).toBe("scout");
  expect(scout?.allowedTools).toEqual(["read", "glob", "grep"]);
  expect(scout?.writeBoundary).toEqual([]);
  expect(getRosterEntry("missing")).toBeUndefined();
  expect(() => lookupRoster("missing")).toThrow("Unknown agent: missing");

  const rendered = renderAgentPrompts("scout", "Inspect the repository", {
    runId: "run_1",
    storagePath: ".factory/runs/run_1",
  });
  expect(rendered.userPrompt).toContain("Inspect the repository");
  expect(rendered.userPrompt).toContain('"storagePath": ".factory/runs/run_1"');
  expect(rendered.userPrompt).toContain("---FACTORY_RESULT_JSON---");
  expect(rendered.userPrompt).not.toMatch(/\{\{[^}]+\}\}/);
  expect(rendered.systemPrompt).toContain("post-run");
  expect(rendered.systemPrompt).toContain(RESULT_INSTRUCTIONS);

  const literal = renderAgentPrompts("scout", "Search for {{request}} literally");
  expect(literal.userPrompt).toContain("Search for {{request}} literally");
  const reordered = renderAgentPrompts("scout", "same", { b: 2, a: 1 });
  const ordered = renderAgentPrompts("scout", "same", { a: 1, b: 2 });
  expect(reordered.userPrompt).toBe(ordered.userPrompt);
});

test("contracts reject unsafe paths, unknown fields, and inconsistent runs", () => {
  for (const path of [
    "/tmp/x",
    "../x",
    "src/../x",
    "src\\x",
    "./x",
    "C:/x",
    "C:\\x",
    "\\\\server\\share",
    "src\0x",
  ])
    expect(() => ArtifactRecordSchema.parse({ path, kind: "source", description: "x" })).toThrow();
  expect(() => WorkflowInputSchema.parse({ request: "x", agentName: "a", extra: true })).toThrow();
  expect(() =>
    RunSchema.parse({ id: "r", status: "failed", startedAt: "2026-01-01T00:00:00Z" }),
  ).toThrow();
  expect(() =>
    TraceEventSchema.parse({ runId: "r", at: "2026-01-01T00:00:00Z", type: "unknown" }),
  ).toThrow();
  expect(() =>
    RunSchema.parse({
      id: "r",
      status: "succeeded",
      startedAt: "2026-01-01T00:30:00Z",
      finishedAt: "2026-01-01T02:00:00+02:00",
    }),
  ).toThrow();
  expect(() =>
    TraceEventSchema.parse({
      runId: "r",
      at: "2026-01-01T00:00:00Z",
      type: "run_finished",
      status: "pending",
    }),
  ).toThrow();
  expect(() =>
    TraceEventSchema.parse({
      runId: "r",
      at: "2026-01-01T00:00:00Z",
      type: "tool_call",
      agentName: "a",
      tool: "x",
      usage: { input: 2, output: 3, total: 6 },
    }),
  ).toThrow();
  expect(() => BackendResultSchema.parse({ result, extra: true })).toThrow();
  expect(() => BackendResultSchema.parse({ result: { ...result, status: "pending" } })).toThrow();
});

test("stderr assistant sentinel is never accepted as a result", () => {
  const result = parseFinalAssistantResult([
    {
      stream: "stderr",
      raw: JSON.stringify({
        role: "assistant",
        content: `---FACTORY_RESULT_JSON---
{"status":"success","summary":"bad","artifacts":[],"notes":[]}
---END_FACTORY_RESULT_JSON---`,
      }),
      parsed: {
        role: "assistant",
        content:
          '---FACTORY_RESULT_JSON---\n{"status":"success","summary":"bad","artifacts":[],"notes":[]}\n---END_FACTORY_RESULT_JSON---',
      },
    },
  ]);
  expect(result.ok).toBe(false);
});
