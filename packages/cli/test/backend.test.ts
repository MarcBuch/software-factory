import { expect, test } from "bun:test";

import { OpenCodeAdapter, type BackendInvocation } from "../src/backend";
import type { AgentRosterEntry } from "../src/workflow";

const agent: AgentRosterEntry = {
  name: "scout",
  purpose: "inspect",
  model: "github-copilot/gpt-5.6-luna",
  systemPrompt: "system",
  userPromptTemplate: "{{request}}",
  allowedTools: ["read"],
  writeBoundary: [],
};

function stream(lines: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

test("OpenCode builds the documented JSON run command and streams raw/normalized events", async () => {
  let captured: { command: readonly string[]; cwd: string } | undefined;
  const adapter = new OpenCodeAdapter({
    executable: "/fake/opencode",
    env: { FACTORY_FAKE: "1" },
    spawn(command, options) {
      captured = { command, cwd: options.cwd };
      return {
        pid: 1234,
        stdout: stream([
          '{"type":"step_start","sessionID":"ses_1"}\n',
          '{"type":"step_finish","part":{"type":"step-finish","cost":0.0123,"tokens":{"input":10,"output":4,"reasoning":2,"cache":{"read":3,"write":1}}}}\n',
          "malformed\n",
          '{"type":"tool_use","tool":"read","input":{"path":"x"}}\n',
        ]),
        stderr: stream(["warning\n"]),
        exited: Promise.resolve(0),
      };
    },
  });
  const invocation: BackendInvocation = {
    repositoryRoot: "/repo",
    runId: "run_1",
    agent,
    prompt: "inspect",
    systemPrompt: "system",
  };
  const process = adapter.start(invocation);
  expect(process.pid).toBe(1234);
  expect(captured?.cwd).toBe("/repo");
  expect(captured?.command).toEqual([
    "/fake/opencode",
    "run",
    "--format",
    "json",
    "--dir",
    "/repo",
    "--model",
    "github-copilot/gpt-5.6-luna",
    "system\n\ninspect",
  ]);
  const events = [];
  for await (const event of process) events.push(event);
  expect(events.map((event) => event.raw)).toEqual(
    expect.arrayContaining([
      '{"type":"step_start","sessionID":"ses_1"}',
      "malformed",
      '{"type":"tool_use","tool":"read","input":{"path":"x"}}',
      "warning",
    ]),
  );
  expect(events[0]?.sessionId).toBe("ses_1");
  expect(events[0]?.normalized).toBeUndefined();
  expect(
    events.find(
      (event) => event.parsed && (event.parsed as { type?: string }).type === "step_finish",
    )?.normalized,
  ).toMatchObject({
    type: "model_step",
    usage: { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 20 },
    cost: { amount: 0.0123, currency: "USD" },
  });
  expect(
    events.find(
      (event) =>
        event.parsed &&
        typeof event.parsed === "object" &&
        (event.parsed as { type?: string }).type === "tool_use",
    )?.normalized?.type,
  ).toBe("tool_call");
  expect(events[1]?.parsed).toBeUndefined();
  expect(await process.exit).toEqual({
    code: 0,
    signal: null,
    signalCode: null,
    sessionId: "ses_1",
  });
});

test("adapter reports nested OpenCode error messages without forwarding roster names", async () => {
  const adapter = new OpenCodeAdapter({
    executable: "fake",
    spawn(command) {
      expect(command).not.toContain("--agent");
      return {
        pid: 2,
        stdout: stream([
          '{"type":"error","error":{"data":{"message":"Unexpected server error"}}}\n',
        ]),
        stderr: stream([]),
        exited: Promise.resolve(1),
      };
    },
  });
  const process = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "inspect" });
  const events = [];
  for await (const event of process) events.push(event);
  expect(events[0]?.normalized).toMatchObject({
    type: "error",
    message: "Unexpected server error",
  });
});

test("continuation uses the captured OpenCode session", async () => {
  const commands: (readonly string[])[] = [];
  const adapter = new OpenCodeAdapter({
    executable: "fake",
    spawn(command) {
      commands.push(command);
      return {
        pid: commands.length,
        stdout: stream(['{"type":"session_start","sessionId":"s1"}\n']),
        stderr: stream([]),
        exited: Promise.resolve(0),
      };
    },
  });
  const first = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "one" });
  for await (const _event of first) {
  }
  const second = first.continue("correction");
  expect(second.command).toContain("--session");
  expect(second.command).toContain("s1");
  expect(second.command.at(-1)).toBe("correction");
  expect(commands).toHaveLength(2);
});

test("adapter preserves signals, flushes unterminated UTF-8 lines, and retains late stream events", async () => {
  let release!: () => void;
  const late = new Promise<void>((resolve) => (release = resolve));
  const decoderFlush = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"session_start","sessionID":"flush"}'));
      await late;
      controller.close();
    },
  });
  const adapter = new OpenCodeAdapter({
    executable: "fake",
    spawn() {
      return {
        pid: 9,
        stdout: decoderFlush,
        stderr: stream([]),
        signalCode: "SIGTERM",
        exited: Promise.resolve(null as any),
      };
    },
  });
  const process = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "x" });
  const eventsPromise = (async () => {
    const events = [];
    for await (const event of process) events.push(event);
    return events;
  })();
  await Bun.sleep(5);
  release();
  const events = await eventsPromise;
  expect(events.at(-1)?.raw).toContain("session_start");
  expect((await process.exit).signal).toBe("SIGTERM");
  expect((await process.exit).signalCode).toBe("SIGTERM");
});

test("adapter decodes multibyte UTF-8 split across stdout and stderr chunks", async () => {
  const split = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const character = new TextEncoder().encode("é");
    const characterOffset = text.indexOf("é");
    const splitAt = new TextEncoder().encode(text.slice(0, characterOffset)).length + 1;
    expect(bytes.slice(splitAt - 1, splitAt + 1)).toEqual(character);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
        controller.close();
      },
    });
  };
  const adapter = new OpenCodeAdapter({
    executable: "fake",
    spawn() {
      return {
        pid: 12,
        stdout: split('{"type":"text","message":"café"}\n'),
        stderr: split("diagnóstico é\n"),
        exited: Promise.resolve(0),
      };
    },
  });
  const process = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "x" });
  const events = [];
  for await (const event of process) events.push(event);
  expect(events.find((event) => event.stream === "stdout")?.raw).toBe(
    '{"type":"text","message":"café"}',
  );
  expect(events.find((event) => event.stream === "stderr")?.raw).toBe("diagnóstico é");
});

test("adapter turns stream and process rejection into observable diagnostics", async () => {
  const rejecting = () =>
    new ReadableStream<Uint8Array>({
      async pull() {
        throw Error("stream broke");
      },
    });
  const adapter = new OpenCodeAdapter({
    spawn() {
      return {
        pid: 10,
        stdout: rejecting(),
        stderr: stream([]),
        exited: Promise.reject(Error("process broke")),
      };
    },
  });
  const process = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "x" });
  const events = [];
  for await (const event of process) events.push(event);
  expect(events.map((event) => event.raw).join("\n")).toContain("stdout error");
  expect(events.map((event) => event.raw).join("\n")).toContain("process error");
  expect((await process.exit).code).toBeNull();
});

test("kill and cancel are safe when child kill is absent or throws", async () => {
  const adapter = new OpenCodeAdapter({
    spawn() {
      return { pid: 11, stdout: stream([]), stderr: stream([]), exited: Promise.resolve(0) };
    },
  });
  const process = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "x" });
  process.kill("SIGTERM");
  process.cancel();
  for await (const _event of process) {
  }
  expect((await process.exit).code).toBe(0);
});
