import { expect, test } from "bun:test";

import { AgentLifecycleSchema, TracePageSchema } from "../src";

const startedAt = "2026-01-01T00:00:00.000Z";
const finishedAt = "2026-01-01T00:01:00.000Z";

test("lifecycle and trace schemas accept valid completed and running records", () => {
  expect(AgentLifecycleSchema.parse({ name: "scout", startedAt, finishedAt })).toMatchObject({
    name: "scout",
    finishedAt,
  });
  expect(
    AgentLifecycleSchema.parse({ name: "planner", startedAt, finishedAt: null }),
  ).toMatchObject({
    name: "planner",
    finishedAt: null,
  });

  const page = {
    runId: "run-1",
    events: [],
    hasMore: false,
    summary: {
      usage: { input: 0, output: 0, total: 0 },
      cost: 0,
    },
    agents: [{ name: "planner", startedAt, finishedAt: null }],
  };
  expect(TracePageSchema.parse(page).agents).toEqual(page.agents);
  const { agents: _agents, ...pageWithoutAgents } = page;
  expect(TracePageSchema.parse(pageWithoutAgents)).not.toHaveProperty("agents");
  expect(TracePageSchema.parse({ ...page, agents: [] }).agents).toEqual([]);
});

test("lifecycle and trace schemas reject malformed and chronologically invalid values", () => {
  expect(() => AgentLifecycleSchema.parse({ name: "", startedAt, finishedAt })).toThrow();
  expect(() =>
    AgentLifecycleSchema.parse({
      name: "scout",
      startedAt,
      finishedAt: "2025-12-31T23:59:00.000Z",
    }),
  ).toThrow();
  expect(() =>
    TracePageSchema.parse({
      runId: "run-1",
      events: [],
      hasMore: false,
      summary: { usage: { input: 0, output: 0, total: 0 }, cost: 0 },
      agents: [{ name: "scout", startedAt, finishedAt: "not-a-date" }],
    }),
  ).toThrow();
});
