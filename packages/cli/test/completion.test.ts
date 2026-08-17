import { expect, test } from "bun:test";

import type { BackendAdapter, BackendProcess } from "../src/backend";
import { completeAgent } from "../src/completion";
import { parseFinalAssistantResult } from "../src/completion";

const invocation: any = {
  repositoryRoot: "/tmp",
  runId: "run_test",
  agent: {
    name: "scout",
    model: "m",
    systemPrompt: "s",
    purpose: "p",
    userPromptTemplate: "{{request}}",
    allowedTools: [],
    writeBoundary: [],
  },
  prompt: "x",
};
const processOf = (
  iterator: AsyncIterator<any>,
  exit: Promise<any>,
  continuation?: () => BackendProcess,
): BackendProcess => ({
  pid: 1,
  command: ["fake"],
  exit,
  kill() {},
  cancel() {},
  continue:
    continuation ??
    (() => {
      throw Error("no continuation");
    }),
  [Symbol.asyncIterator]() {
    return iterator;
  },
});
const adapterOf = (start: () => BackendProcess): BackendAdapter => ({ start });

test("completeAgent converts iterator and exit failures to backend_failure", async () => {
  const iterator = processOf(
    {
      next: async () => {
        throw Error("iterator");
      },
    },
    Promise.resolve({ code: 0, signal: null, signalCode: null }),
  );
  expect(
    (
      await completeAgent(
        adapterOf(() => iterator),
        invocation,
      )
    ).kind,
  ).toBe("backend_failure");
  const exit = processOf(
    { next: async () => ({ done: true, value: undefined }) },
    Promise.reject(Error("exit")),
  );
  expect(
    (
      await completeAgent(
        adapterOf(() => exit),
        invocation,
      )
    ).kind,
  ).toBe("backend_failure");
});

test("completeAgent handles continuation start and stream failures", async () => {
  const first = processOf(
    { next: async () => ({ done: true, value: undefined }) },
    Promise.resolve({ code: 0, signal: null, signalCode: null }),
  );
  expect(
    (
      await completeAgent(
        adapterOf(() => first),
        invocation,
      )
    ).kind,
  ).toBe("backend_failure");
  let calls = 0;
  const valid = JSON.stringify({
    role: "assistant",
    content:
      '---FACTORY_RESULT_JSON---\n{"status":"success","summary":"ok","artifacts":[],"notes":[]}\n---END_FACTORY_RESULT_JSON---',
  });
  const firstProcess = processOf(
    {
      next: async () =>
        calls++
          ? { done: true, value: undefined }
          : { done: false, value: { stream: "stdout", raw: "invalid" } },
    },
    Promise.resolve({ code: 0, signal: null, signalCode: null }),
    () =>
      processOf(
        {
          next: async () => {
            throw Error("stream");
          },
        },
        Promise.resolve({ code: 0, signal: null, signalCode: null }),
      ),
  );
  expect(
    (
      await completeAgent(
        adapterOf(() => firstProcess),
        invocation,
      )
    ).kind,
  ).toBe("backend_failure");
  expect(valid).toContain("FACTORY_RESULT_JSON");
});

test("completion accepts direct assistant results and preserves direct agent failures", async () => {
  const event = (status: string) => ({
    stream: "stdout" as const,
    raw: JSON.stringify({
      role: "assistant",
      content: `---FACTORY_RESULT_JSON---\n${JSON.stringify({ status, summary: status, artifacts: [], notes: [] })}\n---END_FACTORY_RESULT_JSON---`,
    }),
  });
  expect(parseFinalAssistantResult([event("success")])).toEqual({
    ok: true,
    result: { status: "success", summary: "success", artifacts: [], notes: [] },
  });
  expect(parseFinalAssistantResult([event("failure")])).toEqual({
    ok: true,
    result: { status: "failure", summary: "failure", artifacts: [], notes: [] },
  });
  const process = processOf(
    { next: async () => ({ done: false, value: event("failure") }) },
    Promise.resolve({ code: 0, signal: null, signalCode: null }),
  );
  // The iterator intentionally ends after the first event in this bounded test.
  let read = false;
  process[Symbol.asyncIterator] = () => ({
    next: async () =>
      read
        ? { done: true, value: undefined }
        : ((read = true), { done: false, value: event("failure") }),
  });
  expect(
    (
      await completeAgent(
        adapterOf(() => process),
        invocation,
      )
    ).kind,
  ).toBe("agent_failure");
});

test("completion reports invalid planner result fields", () => {
  const event = {
    stream: "stdout" as const,
    raw: JSON.stringify({
      role: "assistant",
      content:
        '---FACTORY_RESULT_JSON---\n{"status":"success","summary":"Plan","artifacts":[],"notes":[],"plan":{"title":"Wrong key"}}\n---END_FACTORY_RESULT_JSON---',
    }),
  };
  expect(parseFinalAssistantResult([event])).toEqual({
    ok: false,
    reason: expect.stringContaining("plan.missionTitle"),
  });
});

test("completion accepts a complete planner plan input", () => {
  const plan = {
    missionTitle: "Notifications",
    intent: "Intent",
    changePlan: "Approach",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["Accepted"],
    verificationStrategy: "Run focused test",
    verificationMode: "fast" as const,
  };
  const event = {
    stream: "stdout" as const,
    raw: JSON.stringify({
      role: "assistant",
      content: `---FACTORY_RESULT_JSON---\n${JSON.stringify({ status: "success", summary: "Plan", artifacts: [], notes: [], plan })}\n---END_FACTORY_RESULT_JSON---`,
    }),
  };
  expect(parseFinalAssistantResult([event])).toEqual({
    ok: true,
    result: { status: "success", summary: "Plan", artifacts: [], notes: [], plan },
  });
});
