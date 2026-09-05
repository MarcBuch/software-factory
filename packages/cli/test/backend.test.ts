import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OpenCodeEvent,
  SessionMessageAssistant,
  SessionMessagesResponse,
} from "@opencode-ai/client";

import {
  OpenCodeAdapter,
  V2OpenCodeAdapter,
  V2PreflightError,
  ensureV2AgentAvailable,
  normalizedV2,
  type BackendInvocation,
  type V2Client,
} from "../src/backend";
import { UiHostManagerEventQueueOverflowError, type UiHostEvent } from "../src/ui-host-manager";
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

const emptyV2Messages = {
  async list() {
    return { data: [] };
  },
};

const emptyV2Session = {
  async wait() {},
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

const temporaryRepos: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepos
      .splice(0)
      .map((repositoryRoot) => rm(repositoryRoot, { recursive: true, force: true })),
  );
});

async function tempGitRepo(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "factory-v2-test-"));
  const git = Bun.spawn(["git", "init", "--quiet", repositoryRoot], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await git.exited) !== 0) throw new Error("failed to initialize temporary Git repository");
  temporaryRepos.push(repositoryRoot);
  return realpath(repositoryRoot);
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
  expect(events[0]?.executionId).toBe("ses_1");
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
    executionId: "ses_1",
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

test("adapter normalizes completed OpenCode tool_use state as a finished span", async () => {
  const adapter = new OpenCodeAdapter({
    executable: "fake",
    spawn() {
      return {
        pid: 3,
        stdout: stream([
          '{"type":"tool_use","part":{"tool":"task","callID":"explore","state":{"status":"completed","input":{"subagent_type":"codebase-explorer"},"output":"exploration findings"}}}\n',
        ]),
        stderr: stream([]),
        exited: Promise.resolve(0),
      };
    },
  });
  const process = adapter.start({ repositoryRoot: "/repo", runId: "r", agent, prompt: "x" });
  const events = [];
  for await (const event of process) events.push(event);
  expect(events[0]?.normalized).toMatchObject({
    type: "tool_call",
    tool: "task",
    spanId: "explore",
    phase: "finish",
    input: { subagent_type: "codebase-explorer" },
    output: { status: "completed", value: "exploration findings" },
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

test("V2 registers event routing before creating one configured session and prompt", async () => {
  const repositoryRoot = await tempGitRepo();
  const calls: string[] = [];
  let onEvent: ((event: UiHostEvent) => void) | undefined;
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create(input: unknown) {
        calls.push(`create:${JSON.stringify(input)}`);
        return { id: "v2-session" } as never;
      },
      async prompt(input: unknown) {
        calls.push(`prompt:${JSON.stringify(input)}`);
        onEvent?.({
          type: "session.execution.started",
          data: { sessionID: "v2-session" },
        } as never);
        return {} as never;
      },
    },
  };
  const adapter = new V2OpenCodeAdapter({
    client: client as unknown as V2Client,
    hostManager: {
      registerEventConsumer(options) {
        calls.push("register");
        onEvent = options.onEvent;
        return { unsubscribe() {}, droppedEvents: 0 };
      },
      withHost: async (operation) => operation(client as never),
    },
  });
  const process = adapter.start({
    repositoryRoot,
    runId: "r",
    agent,
    model: "provider/requested-model",
    systemPrompt: "system",
    prompt: "user",
  });
  expect(process.executionKind).toBe("service");
  expect(await process.exit).toMatchObject({ code: 0, executionId: "v2-session" });
  expect(calls[0]).toBe("register");
  expect(calls.filter((call) => call.startsWith("create:")).length).toBe(1);
  expect(calls.find((call) => call.startsWith("create:"))).toMatch(/"id":"ses_[0-9a-f]{32}"/);
  expect(
    calls.some(
      (call) =>
        call.startsWith(`create:{"location":{"directory":"${repositoryRoot}"}`) &&
        !call.includes('"agent"') &&
        call.includes('"providerID":"provider"') &&
        call.includes('"id":"requested-model"'),
    ),
  ).toBe(true);
  expect(
    calls.some((call) =>
      call.startsWith('prompt:{"sessionID":"v2-session","text":"system\\n\\nuser"'),
    ),
  ).toBe(true);
});

test("V2 preflight and sessions preserve two temporary repository locations", async () => {
  const repositoryA = await tempGitRepo();
  const repositoryB = await tempGitRepo();
  const calls = {
    location: [] as unknown[],
    agents: [] as unknown[],
    evict: [] as unknown[],
    creates: [] as unknown[],
  };
  const consumers = new Map<string, (event: UiHostEvent) => void>();
  const interrupted: string[] = [];
  const waits = new Map<string, () => void>();
  const client = {
    location: {
      get: async (input: unknown) => {
        calls.location.push(input);
        return {
          directory: (input as any).location.directory,
          project: { directory: (input as any).location.directory },
        };
      },
    },
    agent: {
      list: async (input: unknown) => {
        calls.agents.push(input);
        return { location: (input as any).location, data: [{ id: "scout", name: "scout" }] };
      },
    },
    debug: {
      location: {
        evict: async (input: unknown) => {
          calls.evict.push(input);
        },
      },
    },
    message: { list: async () => ({ data: [] }) },
    session: {
      create: async (input: unknown) => {
        calls.creates.push(input);
        const id = `session-${(input as any).location.directory === repositoryA ? "A" : "B"}`;
        return { id };
      },
      prompt: async () => {},
      wait: async (input: { sessionID: string }) =>
        new Promise<void>((resolve) => waits.set(input.sessionID, resolve)),
      interrupt: async (input: { sessionID: string }) => {
        interrupted.push(input.sessionID);
        waits.get(input.sessionID)?.();
      },
    },
  } as unknown as V2Client;
  let firstA = true;
  const originalList = client.agent.list;
  client.agent.list = (async (input: unknown) => {
    calls.agents.push(input);
    if (input && (input as any).location.directory === repositoryA && firstA) {
      firstA = false;
      return { location: (input as any).location, data: [] };
    }
    return { location: (input as any).location, data: [{ id: "scout", name: "scout" }] };
  }) as never;
  await ensureV2AgentAvailable(client, repositoryA, "scout");
  await ensureV2AgentAvailable(client, repositoryB, "scout");
  expect(calls.location).toEqual([
    { location: { directory: repositoryA } },
    { location: { directory: repositoryA } },
    { location: { directory: repositoryB } },
  ]);
  expect(calls.agents).toEqual([
    { location: { directory: repositoryA } },
    { location: { directory: repositoryA } },
    { location: { directory: repositoryB } },
  ]);
  expect(calls.evict).toEqual([{ location: { directory: repositoryA } }]);
  client.agent.list = originalList;
  const manager = {
    registerEventConsumer: (options: {
      location: { directory: string };
      onEvent: (event: UiHostEvent) => void;
    }) => {
      consumers.set(options.location.directory, options.onEvent);
      return {
        unsubscribe: () => void consumers.delete(options.location.directory),
        droppedEvents: 0,
      };
    },
    withHost: async <T>(operation: (value: V2Client) => Promise<T>) => operation(client),
  };
  const invocation = (root: string, runId: string, profile: string, model: string) => ({
    repositoryRoot: root,
    runId,
    agent: { ...agent, adapterProfile: { opencodeAgent: profile } },
    model,
    systemPrompt: "system",
    prompt: runId,
  });
  const processA = new V2OpenCodeAdapter({ client, hostManager: manager }).start(
    invocation(repositoryA, "run-a", "scout-a", "provider/model-a"),
  );
  const processB = new V2OpenCodeAdapter({ client, hostManager: manager }).start(
    invocation(repositoryB, "run-b", "scout-b", "provider/model-b"),
  );
  for (let i = 0; i < 1000 && calls.creates.length < 2; i++) await Bun.sleep(0);
  expect(calls.creates).toHaveLength(2);
  const createA = calls.creates.find(
    (value: any) => value.location.directory === repositoryA,
  ) as any;
  const createB = calls.creates.find(
    (value: any) => value.location.directory === repositoryB,
  ) as any;
  expect(createA).toEqual({
    location: { directory: repositoryA },
    agent: "scout-a",
    id: expect.any(String),
    model: { providerID: "provider", id: "model-a" },
  });
  expect(createB).toEqual({
    location: { directory: repositoryB },
    agent: "scout-b",
    id: expect.any(String),
    model: { providerID: "provider", id: "model-b" },
  });
  const idA = "session-A";
  const idB = "session-B";
  expect(idA).not.toBe(idB);
  consumers.get(repositoryB)?.({
    type: "session.text.delta",
    data: { sessionID: idB, delta: "b" },
  } as never);
  consumers.get(repositoryA)?.({
    type: "session.text.delta",
    data: { sessionID: idA, delta: "a" },
  } as never);
  processA.cancel();
  waits.get(idB)?.();
  expect((await processA.exit).executionId).toBe(idA);
  expect((await processB.exit).executionId).toBe(idB);
  expect(interrupted).toEqual([idA]);
});

test("V2 preflight retry taxonomy preserves typed metadata and eviction boundaries", async () => {
  const repositoryRoot = await tempGitRepo();
  const cases = [
    {
      name: "mismatch",
      response: { directory: "/wrong", project: { directory: "/wrong" } },
      code: "V2_LOCATION_MISMATCH",
      category: "location",
      retryable: true,
      evict: 1,
    },
    {
      name: "missing agent",
      response: { directory: repositoryRoot, project: { directory: repositoryRoot } },
      code: "V2_AGENT_MISSING",
      category: "agent",
      retryable: true,
      evict: 1,
    },
    {
      name: "transport",
      response: new Error("transport"),
      code: "V2_LOCATION_TRANSPORT",
      category: "transport",
      retryable: false,
      evict: 0,
    },
    {
      name: "protocol",
      response: { directory: repositoryRoot },
      code: "V2_PROTOCOL_ERROR",
      category: "protocol",
      retryable: false,
      evict: 0,
    },
  ] as const;
  for (const item of cases) {
    let evictions = 0;
    const client = {
      location: {
        get: async () => {
          if (item.response instanceof Error) throw item.response;
          return item.response;
        },
      },
      agent: { list: async () => ({ location: { directory: repositoryRoot }, data: [] }) },
      debug: {
        location: {
          evict: async () => {
            evictions++;
          },
        },
      },
    } as unknown as V2Client;
    const result = ensureV2AgentAvailable(client, repositoryRoot, "scout");
    await expect(result).rejects.toMatchObject({
      code: item.code,
      category: item.category,
      retryable: item.retryable,
    });
    expect(evictions).toBe(item.evict);
  }
  const client = {
    location: {
      get: async () => ({ directory: repositoryRoot, project: { directory: repositoryRoot } }),
    },
    agent: { list: async () => ({ location: { directory: repositoryRoot }, data: [] }) },
  } as unknown as V2Client;
  await expect(ensureV2AgentAvailable(client, repositoryRoot, "scout")).rejects.toMatchObject({
    code: "V2_LOCATION_RELOAD_FAILED",
    category: "reload",
    retryable: false,
  });
});

test("V2 queue overflow is a session failure and does not interrupt another session", async () => {
  const repositoryRoot = await tempGitRepo();
  const interrupted: string[] = [];
  const failures: Array<(error: UiHostManagerEventQueueOverflowError) => void> = [];
  let nextSession = 0;
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create() {
        nextSession += 1;
        return { id: `overflow-${nextSession}` } as never;
      },
      async prompt(input: { sessionID: string; signal?: AbortSignal }) {
        if (input.sessionID === "overflow-1")
          return new Promise((_, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
      },
      async interrupt(input: { sessionID: string }) {
        interrupted.push(input.sessionID);
      },
    },
  };
  const manager = {
    registerEventConsumer(options: {
      onError?: (error: UiHostManagerEventQueueOverflowError) => void;
    }) {
      failures.push(options.onError!);
      return { unsubscribe() {}, droppedEvents: 0 };
    },
  };
  const adapter = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: manager as never,
  });
  const first = adapter.start({ repositoryRoot, runId: "overflow", agent, prompt: "x" });
  while (failures.length < 1) await Bun.sleep(0);
  failures[0](new UiHostManagerEventQueueOverflowError("overflow-1", 1));
  const second = adapter.start({ repositoryRoot, runId: "healthy", agent, prompt: "x" });
  expect((await second.exit).code).toBe(0);
  expect((await first.exit).code).toBeNull();
  expect(interrupted).toEqual(["overflow-1"]);
  const firstEvents = [];
  for await (const event of first) firstEvents.push(event);
  expect(firstEvents.every((event) => event.stream === "stderr")).toBe(true);
});

test("V2 lifecycle diagnostics identify prompt failures without payloads", async () => {
  const repositoryRoot = await tempGitRepo();
  const diagnostics: unknown[] = [];
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create(input: { id: string }) {
        return { id: input.id } as never;
      },
      async prompt() {
        const error = new Error("secret prompt and Authorization: bearer token");
        (error as Error & { code?: string }).code = "E_PROVIDER";
        throw error;
      },
    },
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    hostManager: { registerEventConsumer: () => ({ unsubscribe() {}, droppedEvents: 0 }) } as never,
  }).start({
    repositoryRoot,
    runId: "run-safe",
    agent,
    prompt: "secret user prompt",
  });

  await process.exit;
  const promptFailure = diagnostics.find(
    (value) => (value as { event?: string }).event === "session_prompt_failure",
  );
  expect(promptFailure).toMatchObject({
    event: "session_prompt_failure",
    backend: "v2-client",
    runId: "run-safe",
    errorClass: "Error",
    errorCode: "E_PROVIDER",
  });
  expect(JSON.stringify(diagnostics)).not.toContain("secret");
  expect(JSON.stringify(diagnostics)).not.toContain("Authorization");
});

test("V2 does not leak pre-creation events from a concurrent session", async () => {
  const repositoryRoot = await tempGitRepo();
  let onEvent: ((event: UiHostEvent) => void) | undefined;
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create() {
        onEvent?.({
          type: "session.text.delta",
          data: { sessionID: "other", delta: "foreign" },
        } as never);
        onEvent?.({
          type: "session.text.delta",
          data: { sessionID: "owned", delta: "owned" },
        } as never);
        return { id: "owned" } as never;
      },
      async prompt() {},
    },
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: {
      registerEventConsumer(options) {
        onEvent = options.onEvent;
        return { unsubscribe() {}, droppedEvents: 0 };
      },
      withHost: async (operation) => operation(client as never),
    },
  }).start({ repositoryRoot, runId: "r", agent, prompt: "prompt" });
  const events = [];
  for await (const event of process) events.push(event);
  expect(events.map((event) => event.executionId)).toEqual(["owned"]);
  expect(events[0]?.raw).toContain("owned");
});

test("V2 accepts a reserved session event without location before creation resolves", async () => {
  const repositoryRoot = await tempGitRepo();
  let onEvent: ((event: UiHostEvent) => void) | undefined;
  let createInput: { id: string } | undefined;
  let resolveCreate!: (value: { id: string }) => void;
  const createPending = new Promise<{ id: string }>((resolve) => (resolveCreate = resolve));
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create(input: { id: string }) {
        createInput = input;
        return createPending;
      },
      async prompt() {},
    },
  };
  const adapter = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: {
      registerEventConsumer(options) {
        onEvent = options.onEvent;
        return { unsubscribe() {}, droppedEvents: 0 };
      },
      withHost: async (operation) => operation(client as never),
    },
  });
  const process = adapter.start({ repositoryRoot, runId: "r", agent, prompt: "prompt" });
  while (!createInput || !onEvent) await Bun.sleep(0);

  onEvent({
    type: "session.execution.started",
    data: { sessionID: createInput.id },
  } as never);
  resolveCreate({ id: createInput.id });

  const events = [];
  for await (const value of process) events.push(value);
  expect(events.map((value) => value.executionId)).toEqual([createInput.id]);
  expect((await process.exit).code).toBe(0);
});

test("V2 host stream failure fails the process and closes its iterator", async () => {
  const repositoryRoot = await tempGitRepo();
  let onError: ((error: Error) => void) | undefined;
  const interrupted: string[] = [];
  let sessionId: string | undefined;
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create(input: { id: string }) {
        sessionId = input.id;
        onError?.(new Error("stream offline"));
        return { id: input.id } as never;
      },
      async prompt() {},
      async interrupt(input: { sessionID: string }) {
        interrupted.push(input.sessionID);
      },
    },
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: {
      registerEventConsumer(options) {
        onError = options.onError as never;
        return { unsubscribe() {}, droppedEvents: 0 };
      },
      withHost: async (operation) => operation(client as never),
    },
  }).start({ repositoryRoot, runId: "r", agent, prompt: "prompt" });
  const events = [];
  for await (const event of process) events.push(event);
  expect((await process.exit).code).toBeNull();
  expect(events.map((event) => event.raw)).toContain("stream offline");
  expect(interrupted).toEqual([sessionId!]);
  expect((await process[Symbol.asyncIterator]().next()).done).toBe(true);
});

test("V2 continuation reuses the session and reconciles its latest stored assistant message", async () => {
  const repositoryRoot = await tempGitRepo();
  const calls: string[] = [];
  let onEvent: ((event: UiHostEvent) => void) | undefined;
  const client = {
    session: {
      ...emptyV2Session,

      async create() {
        calls.push("create");
        return { id: "same-session" } as never;
      },
      async prompt(input: { sessionID: string; text: string }) {
        calls.push(`prompt:${input.sessionID}:${input.text}`);
        onEvent?.({
          type: "session.text.delta",
          data: { sessionID: input.sessionID, delta: "live" },
        } as never);
        return {} as never;
      },
      async wait(input: { sessionID: string }) {
        calls.push(`wait:${input.sessionID}`);
      },
    },
    message: {
      async list(input: { sessionID: string }) {
        calls.push(`messages:${input.sessionID}`);
        return {
          data: [{ type: "assistant", content: [{ type: "text", text: "durable" }] }],
        } as never;
      },
    },
  };
  const manager = {
    registerEventConsumer(options: { onEvent: (event: UiHostEvent) => void }) {
      onEvent = options.onEvent;
      return { unsubscribe() {}, droppedEvents: 0 };
    },
    withHost: async (operation: (value: unknown) => Promise<unknown>) => operation(client),
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: manager as never,
  }).start({
    repositoryRoot,
    runId: "r",
    agent,
    prompt: "first",
  });
  await process.exit;
  const continuation = process.continue("second");
  expect((await continuation.exit).executionId).toBe("same-session");
  expect(calls.filter((call) => call === "create")).toHaveLength(1);
  expect(calls).toContain("prompt:same-session:second");
  expect(calls).toContain("messages:same-session");
});

test("V2 reconciliation uses an ID boundary, ascending pages, and owns corrections", async () => {
  const repositoryRoot = await tempGitRepo();
  const prompts: string[] = [];
  const listInputs: Array<{ sessionID: string; order?: string; cursor?: string }> = [];
  const assistant = (id: string, created: number) =>
    ({ id, type: "assistant", time: { created }, content: [] }) as never;
  const old = assistant("old", 1);
  const first = assistant("first", 2);
  const correction = assistant("correction", 3);
  let pageCalls = 0;
  let snapshot: (typeof old)[] = [old];
  const client = {
    session: {
      ...emptyV2Session,

      async create() {
        return { id: "boundary-session" } as never;
      },
      async prompt(input: { text: string }) {
        prompts.push(input.text);
        // A host may persist the assistant output before prompt resolves.
        snapshot = [...snapshot, prompts.length === 1 ? first : correction];
      },
      async wait() {},
    },
    message: {
      async list(input: { sessionID: string; order?: string; cursor?: string }) {
        listInputs.push(input);
        const page = pageCalls++ % 2;
        // Every snapshot is paginated; the output can already be present in
        // the second page by the time the prompt promise resolves.
        if (page === 0) return { data: [old], cursor: { next: "page-2" } } as never;
        return { data: snapshot.slice(1).reverse(), cursor: {} } as never;
      },
    },
  };
  const manager = {
    registerEventConsumer() {
      return { unsubscribe() {}, droppedEvents: 0 };
    },
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: manager as never,
  }).start({ repositoryRoot, runId: "boundary", agent, prompt: "initial" });
  await process.exit;
  const firstEvents: unknown[] = [];
  for await (const event of process) firstEvents.push(event);
  const continuation = process.continue("correction prompt");
  await continuation.exit;
  const correctionEvents: unknown[] = [];
  for await (const event of continuation) correctionEvents.push(event);

  expect(listInputs.filter((input) => !input.cursor).every((input) => input.order === "asc")).toBe(
    true,
  );
  expect(
    listInputs.filter((input) => input.cursor).every((input) => input.order === undefined),
  ).toBe(true);
  expect(listInputs.filter((input) => input.cursor === "page-2")).toHaveLength(4);
  expect(JSON.stringify(firstEvents)).toContain('"id":"first"');
  expect(JSON.stringify(firstEvents)).not.toContain('"id":"old"');
  expect(JSON.stringify(correctionEvents)).toContain('"id":"correction"');
  expect(JSON.stringify(correctionEvents)).not.toContain('"id":"first"');
});

test("V2 reconciliation does not reuse an old assistant when no new message is stored", async () => {
  const repositoryRoot = await tempGitRepo();
  const assistant: SessionMessageAssistant = {
    id: "old",
    type: "assistant",
    agent: "scout",
    model: { providerID: "provider", id: "model" },
    time: { created: 1 },
    content: [],
  };
  let lists = 0;
  const page: SessionMessagesResponse = {
    data: lists++ === 0 ? [assistant] : [assistant],
    cursor: {},
  };
  const client = {
    session: {
      ...emptyV2Session,
      async create(input: { id: string }) {
        return { id: input.id };
      },
      async prompt() {},
    },
    message: {
      async list() {
        return page;
      },
    },
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: {
      registerEventConsumer: () => ({ unsubscribe() {}, droppedEvents: 0 }),
      withHost: async () => client,
    } as never,
  }).start({ repositoryRoot, runId: "no-new", agent, prompt: "prompt" });
  await process.exit;
  const events: unknown[] = [];
  for await (const event of process) events.push(event);
  expect(events).toHaveLength(0);
});

test("V2 reconciliation reports message retrieval failures and cancellation", async () => {
  const repositoryRoot = await tempGitRepo();
  let retrievalFailure = true;
  let resolveList!: () => void;
  const pendingList = new Promise<SessionMessagesResponse>((resolve) => {
    resolveList = () => resolve({ data: [], cursor: {} });
  });
  const interrupted: string[] = [];
  const client = {
    session: {
      ...emptyV2Session,
      async create(input: { id: string }) {
        return { id: input.id };
      },
      async prompt() {},
      async interrupt(input: { sessionID: string }) {
        interrupted.push(input.sessionID);
      },
    },
    message: {
      async list() {
        if (retrievalFailure) {
          retrievalFailure = false;
          throw new Error("history unavailable");
        }
        return pendingList;
      },
    },
  };
  const manager = {
    registerEventConsumer: () => ({ unsubscribe() {}, droppedEvents: 0 }),
    withHost: async () => client,
  };
  const failed = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: manager as never,
  }).start({
    repositoryRoot,
    runId: "retrieval-failure",
    agent,
    prompt: "prompt",
  });
  await failed.exit;
  const failureEvents: unknown[] = [];
  for await (const event of failed) failureEvents.push(event);
  expect(JSON.stringify(failureEvents)).toContain("history unavailable");

  const canceled = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: manager as never,
  }).start({
    repositoryRoot,
    runId: "retrieval-cancel",
    agent,
    prompt: "prompt",
  });
  await Promise.resolve();
  canceled.cancel();
  resolveList();
  expect((await canceled.exit).code).toBeNull();
  expect(interrupted).toHaveLength(1);
});

test("V2 cancellation interrupts only its session and remains safe when interrupt fails", async () => {
  const firstRepositoryRoot = await tempGitRepo();
  const secondRepositoryRoot = await tempGitRepo();
  const interrupted: string[] = [];
  const pending = new Promise<never>(() => {});
  let firstSession: string | undefined;
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      async create(input: { id: string; location: { directory: string } }) {
        if (input.location.directory === firstRepositoryRoot) firstSession = input.id;
        return { id: input.id } as never;
      },
      async prompt(input: { sessionID: string; text: string }) {
        return input.sessionID === firstSession ? pending : {};
      },
      async interrupt(input: { sessionID: string }) {
        interrupted.push(input.sessionID);
        if (input.sessionID === "session-one") throw new Error("interrupt failed");
      },
    },
  };
  const manager = {
    registerEventConsumer() {
      return { unsubscribe() {}, droppedEvents: 0 };
    },
    withHost: async (operation: (value: unknown) => Promise<unknown>) => operation(client),
  };
  const adapter = new V2OpenCodeAdapter({ client: client as never, hostManager: manager as never });
  const first = adapter.start({
    repositoryRoot: firstRepositoryRoot,
    runId: "one",
    agent,
    prompt: "first",
  });
  const second = adapter.start({
    repositoryRoot: secondRepositoryRoot,
    runId: "two",
    agent,
    prompt: "second",
  });
  expect((await second.exit).code).toBe(0);
  first.cancel();
  first.cancel();
  expect((await first.exit).code).toBeNull();
  expect(interrupted).toEqual([firstSession!]);
});

test("V2 cancellation before creation completes still settles and interrupts the late session", async () => {
  const repositoryRoot = await tempGitRepo();
  let resolveCreate!: (value: { id: string }) => void;
  const interrupted: string[] = [];
  const client = {
    message: emptyV2Messages,
    session: {
      ...emptyV2Session,

      create: (input: { id: string }) =>
        new Promise<{ id: string }>((resolve) => {
          resolveCreate = () => resolve({ id: input.id });
        }),
      async prompt() {},
      async interrupt(input: { sessionID: string }) {
        interrupted.push(input.sessionID);
      },
    },
  };
  const manager = {
    registerEventConsumer() {
      return { unsubscribe() {}, droppedEvents: 0 };
    },
    withHost: async (operation: (value: unknown) => Promise<unknown>) => operation(client),
  };
  const process = new V2OpenCodeAdapter({
    client: client as never,
    hostManager: manager as never,
  }).start({
    repositoryRoot,
    runId: "r",
    agent,
    prompt: "prompt",
  });
  while (!resolveCreate) await Bun.sleep(0);
  process.cancel();
  const exit = process.exit;
  resolveCreate({ id: "late-session" });
  expect((await exit).code).toBeNull();
  expect(interrupted).toHaveLength(1);
});

test("V2 maps typed text, tool, step usage, and structured failures", () => {
  const toolNames = new Map<string, string>();
  const ended = normalizedV2("run-v2", {
    type: "session.step.ended",
    created: 1_735_689_600_000,
    data: {
      sessionID: "session-a",
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      cost: 0.25,
    },
  } as never);
  expect(ended).toMatchObject({
    runId: "run-v2",
    type: "model_step",
    usage: { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 20 },
    cost: { amount: 0.25, currency: "USD" },
  });
  expect(
    normalizedV2(
      "run-v2",
      {
        id: "event-content-1",
        created: 1_735_689_600_001,
        durable: { aggregateID: "session-a", seq: 1, version: 1 },
        type: "session.message.content.updated",
        data: {
          sessionID: "session-a",
          messageID: "message-a",
          content: [
            {
              type: "tool",
              id: "call-1",
              name: "read",
              state: { status: "running", input: { path: "x" } },
              time: { created: 1_735_689_600_001 },
            },
          ],
        },
      } as never,
      toolNames,
    ),
  ).toBeUndefined();
  expect(
    normalizedV2(
      "run-v2",
      {
        id: "event-called-1",
        created: 1_735_689_600_002,
        durable: { aggregateID: "session-a", seq: 2, version: 1 },
        type: "session.tool.called",
        data: {
          sessionID: "session-a",
          assistantMessageID: "message-a",
          id: "call-1",
          input: { path: "x" },
          executed: false,
        },
      } as never,
      toolNames,
    ),
  ).toMatchObject({ type: "tool_call", tool: "read", phase: "start" });
  expect(
    normalizedV2(
      "run-v2",
      {
        type: "session.step.failed",
        data: { sessionID: "session-a", error: { type: "ProviderError", message: "nope" } },
      } as never,
      toolNames,
    ),
  ).toMatchObject({ type: "error", code: "ProviderError", message: "nope" });
});

test("V2 extracts generated session failure and usage events", () => {
  const failed = {
    id: "execution-failed",
    created: 1_735_689_600_003,
    type: "session.execution.failed",
    durable: { aggregateID: "session-a", seq: 4, version: 1 },
    data: {
      sessionID: "session-a",
      error: { type: "ProviderError", message: "provider unavailable", status: 503 },
    },
  } satisfies OpenCodeEvent;
  expect(normalizedV2("run-v2", failed)).toMatchObject({
    type: "error",
    code: "ProviderError",
    message: "provider unavailable",
  });

  const usage = {
    id: "step-ended",
    created: 1_735_689_600_004,
    type: "session.step.ended",
    durable: { aggregateID: "session-a", seq: 5, version: 1 },
    data: {
      sessionID: "session-a",
      assistantMessageID: "message-a",
      finish: "stop",
      cost: 0.05,
      tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 0 } },
    },
  } satisfies OpenCodeEvent;
  expect(normalizedV2("run-v2", usage)).toMatchObject({
    type: "model_step",
    usage: { input: 2, output: 3, reasoning: 1, cacheRead: 4, cacheWrite: 0, total: 10 },
    cost: { amount: 0.05, currency: "USD" },
  });
});

test("V1 JSON and V2 SDK normalize representative scout/planner results identically", async () => {
  const timestamp = "2025-01-01T00:00:00.000Z";
  const adapter = new OpenCodeAdapter({
    executable: "fake",
    spawn() {
      return {
        pid: 13,
        stdout: stream([
          JSON.stringify({
            type: "tool_use",
            timestamp,
            tool: "read",
            callID: "call-1",
            part: {
              state: {
                status: "completed",
                input: { path: "README.md" },
                output: { value: "contents", status: "completed" },
              },
            },
          }) + "\n",
          JSON.stringify({
            type: "step_finish",
            timestamp,
            usage: { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
            cost: 0.25,
          }) + "\n",
          JSON.stringify({
            type: "error",
            timestamp,
            error: { data: { message: "provider unavailable" } },
            code: "E_PROVIDER",
          }) + "\n",
        ]),
        stderr: stream([]),
        exited: Promise.resolve(0),
      };
    },
  });
  const v1 = adapter.start({ repositoryRoot: "/repo", runId: "parity", agent, prompt: "inspect" });
  const v1Events = [];
  for await (const event of v1) if (event.normalized) v1Events.push(event.normalized);

  const toolNames = new Map<string, string>();
  const v2Events = [
    normalizedV2(
      "parity",
      {
        id: "content-1",
        created: Date.parse(timestamp),
        durable: { aggregateID: "session-a", seq: 1, version: 1 },
        type: "session.message.content.updated",
        data: {
          sessionID: "session-a",
          messageID: "message-a",
          content: [
            {
              type: "tool",
              id: "call-1",
              name: "read",
              state: { status: "completed", input: { path: "README.md" } },
              time: { created: Date.parse(timestamp), completed: Date.parse(timestamp) },
            },
          ],
        },
      } as never,
      toolNames,
    ),
    normalizedV2(
      "parity",
      {
        id: "tool-success-1",
        durable: { aggregateID: "session-a", seq: 2, version: 2 },
        type: "session.tool.success",
        created: Date.parse(timestamp),
        data: {
          sessionID: "session-a",
          assistantMessageID: "message-a",
          id: "call-1",
          input: { path: "README.md" },
          content: [{ type: "text", text: "contents" }],
          executed: true,
        },
      } as never,
      toolNames,
    ),
    normalizedV2(
      "parity",
      {
        type: "session.step.ended",
        created: Date.parse(timestamp),
        data: {
          tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
          cost: 0.25,
        },
      } as never,
      toolNames,
    ),
    normalizedV2(
      "parity",
      {
        type: "session.step.failed",
        created: Date.parse(timestamp),
        data: { error: { type: "E_PROVIDER", message: "provider unavailable" } },
      } as never,
      toolNames,
    ),
  ];
  expect(v1Events).toHaveLength(3);
  const normalizedV2Events = v2Events.filter(
    (event): event is NonNullable<typeof event> => event !== undefined,
  );
  expect(normalizedV2Events).toHaveLength(3);
  expect(v1Events[0]).toMatchObject({
    runId: "parity",
    type: "tool_call",
    tool: "read",
    input: { path: "README.md" },
    phase: "finish",
    spanId: "call-1",
  });
  expect(normalizedV2Events[0]).toMatchObject({
    runId: "parity",
    type: "tool_call",
    tool: "read",
    input: { path: "README.md" },
    phase: "finish",
    spanId: "call-1",
  });
  expect(v1Events.slice(1)).toEqual(normalizedV2Events.slice(1));
});

test("V2 leaves unknown events unnormalized and does not infer malformed optional usage", () => {
  const raw = { type: "session.future.event", data: { sessionID: "session-a", value: 1 } };
  expect(normalizedV2("run-v2", raw as never)).toBeUndefined();
  expect(
    normalizedV2("run-v2", {
      type: "session.step.ended",
      data: {
        sessionID: "session-a",
        tokens: { input: "bad", output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } as never),
  ).toMatchObject({ type: "model_step" });
  expect(
    normalizedV2("run-v2", {
      type: "session.step.ended",
      data: {
        sessionID: "session-b",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } as never),
  ).toMatchObject({ runId: "run-v2", type: "model_step" });
});

test("V2 resolves tool names by call ID without changing raw result ordering", () => {
  const names = new Map<string, string>();
  const resultBeforeName = normalizedV2(
    "names",
    {
      id: "result-1",
      created: 1,
      durable: { aggregateID: "session-a", seq: 1, version: 2 },
      type: "session.tool.success",
      data: {
        sessionID: "session-a",
        assistantMessageID: "message-a",
        id: "call-unknown",
        content: [{ type: "text", text: "done" }],
        executed: true,
      },
    } as never,
    names,
  );
  expect(resultBeforeName).toMatchObject({ tool: "tool", spanId: "call-unknown" });

  expect(
    normalizedV2(
      "names",
      {
        id: "content-1",
        created: 2,
        durable: { aggregateID: "session-a", seq: 2, version: 1 },
        type: "session.message.content.updated",
        data: {
          sessionID: "session-a",
          messageID: "message-a",
          content: [
            {
              type: "tool",
              id: "call-unknown",
              name: "read",
              state: { status: "completed", input: {} },
              time: { created: 2, completed: 2 },
            },
            {
              type: "tool",
              id: "call-2",
              name: "write",
              state: { status: "running", input: {} },
              time: { created: 2 },
            },
          ],
        },
      } as never,
      names,
    ),
  ).toBeUndefined();

  expect(
    normalizedV2(
      "names",
      {
        id: "called-2",
        created: 3,
        durable: { aggregateID: "session-a", seq: 3, version: 1 },
        type: "session.tool.called",
        data: {
          sessionID: "session-a",
          assistantMessageID: "message-a",
          id: "call-2",
          input: {},
          executed: false,
        },
      } as never,
      names,
    ),
  ).toMatchObject({ tool: "write", spanId: "call-2" });

  expect(
    normalizedV2(
      "names",
      {
        id: "failed-unknown",
        created: 4,
        durable: { aggregateID: "session-a", seq: 4, version: 2 },
        type: "session.tool.failed",
        data: {
          sessionID: "session-a",
          assistantMessageID: "message-a",
          id: "call-never-named",
          error: "failed",
        },
      } as never,
      names,
    ),
  ).toMatchObject({ tool: "tool", spanId: "call-never-named" });
});
