import { realpath } from "node:fs/promises";

import type { OpenCodeClient, OpenCodeEvent, SessionMessageAssistant } from "@opencode-ai/client";
import { TraceEventSchema, type TraceEvent } from "@software-factory/contracts";

import type {
  AgentRuntimeAdapter,
  BackendEvent,
  BackendExit,
  BackendInvocation,
  BackendProcess,
} from "./agent-runtime";
import {
  defaultLifecycleDiagnostic,
  errorDetails,
  type LifecycleDiagnosticSink,
} from "./lifecycle-diagnostics";
import type {
  UiHostEvent,
  UiHostManager,
  UiHostManagerBackendFailureError,
} from "./ui-host-manager";
import { UiHostManagerEventQueueOverflowError } from "./ui-host-manager";

/** The deliberately small contract implemented by all workflow backends. */
export type { BackendEvent, BackendExit, BackendInvocation, BackendProcess } from "./agent-runtime";

/** Harness-neutral runtime vocabulary. Adapters translate these to their native tools. */
export type { RuntimeCapability } from "./agent-runtime";
/** Compatibility alias; orchestration uses the neutral runtime contract. */
export type BackendAdapter = AgentRuntimeAdapter;

type Spawned = {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  signalCode?: string | null;
  kill?: (signal?: number | NodeJS.Signals) => void;
};

export type OpenCodeOptions = Readonly<{
  executable?: string;
  env?: Record<string, string | undefined>;
  /** Primarily useful for deterministic tests; production uses Bun.spawn. */
  spawn?: (
    command: readonly string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => Spawned;
}>;

const isoNow = () => new Date().toISOString();

function sessionOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["sessionID", "sessionId", "session_id"]) {
    if (typeof object[key] === "string" && object[key]) return object[key];
  }
  if (object.session && typeof object.session === "object") return sessionOf(object.session);
  if (object.data && typeof object.data === "object") return sessionOf(object.data);
  return undefined;
}

function normalized(runId: string, value: unknown): TraceEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, any>;
  const at = typeof event.timestamp === "string" ? event.timestamp : isoNow();
  const base = { runId, at };
  const name = typeof event.agent === "string" ? event.agent : "opencode";
  let candidate: Record<string, unknown> | undefined;
  const type = String(event.type ?? "").toLowerCase();
  const part =
    event.part && typeof event.part === "object" ? (event.part as Record<string, any>) : {};
  const state =
    part.state && typeof part.state === "object" ? (part.state as Record<string, any>) : {};
  const stateStatus = typeof state.status === "string" ? state.status.toLowerCase() : undefined;
  const actualToolCompleted =
    type === "tool_use" && ["completed", "success"].includes(stateStatus ?? "");
  const spanId =
    event.callID ?? event.callId ?? event.toolCallId ?? event.id ?? part.callID ?? part.callId;
  const stateOutput = actualToolCompleted
    ? state.output && typeof state.output === "object"
      ? { ...state.output, status: state.output.status ?? stateStatus }
      : { status: stateStatus, value: state.output }
    : undefined;
  if (type === "tool_use" || type === "tool_call" || type === "tool_start")
    candidate = {
      ...base,
      type: "tool_call",
      agentName: name,
      tool: String(event.tool ?? event.name ?? part.tool ?? "tool"),
      input: event.input ?? state.input,
      ...(typeof spanId === "string" ? { spanId } : {}),
      ...(actualToolCompleted
        ? { output: stateOutput, phase: "finish" as const }
        : type === "tool_start" || type === "tool_use"
          ? { phase: "start" as const }
          : {}),
    };
  else if (type === "tool_result" || type === "tool_end")
    candidate = {
      ...base,
      type: "tool_call",
      agentName: name,
      tool: String(event.tool ?? event.name ?? part.tool ?? "tool"),
      output: event.output ?? state.output,
      ...(typeof spanId === "string" ? { spanId } : {}),
      phase: "finish",
    };
  else if (type === "error") {
    const errorData =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>).data
        : event.data;
    const nestedMessage =
      errorData && typeof errorData === "object"
        ? (errorData as Record<string, unknown>).message
        : undefined;
    candidate = {
      ...base,
      type: "error",
      message: String(nestedMessage ?? event.message ?? event.error ?? "Backend error"),
      code: typeof event.code === "string" ? event.code : undefined,
      agentName: name,
    };
  } else if (type === "step_finish") candidate = { ...base, type: "model_step", agentName: name };
  if (!candidate) return undefined;
  const usage = event.usage ?? event.part?.tokens;
  if (usage && typeof usage === "object") {
    const input = Number(usage.input ?? usage.inputTokens ?? 0);
    const output = Number(usage.output ?? usage.outputTokens ?? 0);
    const reasoning = Number(usage.reasoning ?? 0);
    const cacheRead = Number(usage.cacheRead ?? usage.cache?.read ?? 0);
    const cacheWrite = Number(usage.cacheWrite ?? usage.cache?.write ?? 0);
    if ([input, output, reasoning, cacheRead, cacheWrite].every(Number.isFinite))
      candidate.usage = {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite,
      };
  }
  const cost = event.cost ?? event.part?.cost;
  if (typeof cost === "number" && Number.isFinite(cost))
    candidate.cost = { amount: cost, currency: "USD" };
  return TraceEventSchema.safeParse(candidate).success ? (candidate as TraceEvent) : undefined;
}

/** Projects the generated V2 event envelope without widening unknown payloads. */
type V2ToolNames = Map<string, string>;

function updateV2ToolNames(event: Record<string, unknown>, names: V2ToolNames) {
  if (event.type !== "session.message.content.updated") return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const content = (data as Record<string, unknown>).content;
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (part.type === "tool" && typeof part.id === "string" && typeof part.name === "string")
      names.set(part.id, part.name);
  }
}

export function normalizedV2(
  runId: string,
  value: OpenCodeEvent,
  toolNames: V2ToolNames = new Map(),
): TraceEvent | undefined {
  const event = value as unknown as Record<string, unknown>;
  const data =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : undefined;
  if (!data || typeof event.type !== "string") return undefined;
  const created = event.created;
  const at =
    typeof created === "number" && Number.isFinite(created)
      ? new Date(created).toISOString()
      : isoNow();
  const base = { runId, at };
  const agentName = "opencode";
  const spanId = typeof data.id === "string" ? data.id : undefined;
  updateV2ToolNames(event, toolNames);
  const tool =
    spanId && typeof data.name === "string"
      ? data.name
      : spanId
        ? (toolNames.get(spanId) ?? "tool")
        : "tool";
  let candidate: Record<string, unknown> | undefined;
  switch (event.type) {
    case "session.message.content.updated":
      return undefined;
    case "session.tool.called":
      candidate = {
        ...base,
        type: "tool_call",
        agentName,
        tool,
        input: data.input,
        ...(spanId ? { spanId } : {}),
        phase: "start",
      };
      break;
    case "session.tool.success":
      candidate = {
        ...base,
        type: "tool_call",
        agentName,
        tool,
        ...(data.input !== undefined ? { input: data.input } : {}),
        output: data.content,
        ...(spanId ? { spanId } : {}),
        phase: "finish",
      };
      break;
    case "session.tool.failed":
      candidate = {
        ...base,
        type: "tool_call",
        agentName,
        tool,
        output: data.error,
        ...(spanId ? { spanId } : {}),
        phase: "finish",
      };
      break;
    case "session.step.ended":
      candidate = { ...base, type: "model_step", agentName };
      break;
    case "session.step.failed": {
      const error = data.error;
      const detail =
        error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
      candidate = {
        ...base,
        type: "error",
        agentName,
        message: typeof detail?.message === "string" ? detail.message : "Step failed",
        ...(typeof detail?.type === "string" ? { code: detail.type } : {}),
      };
      break;
    }
    case "session.execution.failed": {
      const error = data.error;
      const detail =
        error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
      candidate = {
        ...base,
        type: "error",
        agentName,
        message: typeof detail?.message === "string" ? detail.message : "Session execution failed",
        ...(typeof detail?.type === "string" ? { code: detail.type } : {}),
      };
      break;
    }
    case "session.execution.interrupted":
      candidate = {
        ...base,
        type: "error",
        agentName,
        message: "Session execution interrupted",
        code: "interrupted",
      };
      break;
    default:
      return undefined;
  }
  if (!candidate) return undefined;
  const tokens = data.tokens;
  if (tokens && typeof tokens === "object") {
    const t = tokens as Record<string, unknown>;
    const cache =
      t.cache && typeof t.cache === "object" ? (t.cache as Record<string, unknown>) : {};
    const numbers = [t.input, t.output, t.reasoning, cache.read, cache.write];
    if (numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
      const [input, output, reasoning, cacheRead, cacheWrite] = numbers as number[];
      candidate.usage = {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite,
      };
    }
  }
  if (typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0)
    candidate.cost = { amount: data.cost, currency: "USD" };
  return TraceEventSchema.safeParse(candidate).success ? (candidate as TraceEvent) : undefined;
}

class OpenCodeProcess implements BackendProcess {
  readonly pid: number;
  readonly command: readonly string[];
  readonly exit: Promise<BackendExit>;
  private sessionId?: string;
  private queue: BackendEvent[] = [];
  private waiting: ((result: IteratorResult<BackendEvent>) => void)[] = [];
  private done = false;

  constructor(
    private readonly invocation: BackendInvocation,
    private readonly options: OpenCodeOptions,
    command: readonly string[],
    private readonly child: Spawned,
  ) {
    this.pid = child.pid;
    this.command = command;
    const streams = Promise.allSettled([
      this.consume(child.stdout, "stdout"),
      this.consume(child.stderr, "stderr"),
    ]);
    const exited = child.exited.then(
      (code) => ({ code, signal: child.signalCode ?? null, signalCode: child.signalCode ?? null }),
      (error: unknown) => {
        this.error("process", error);
        return {
          code: null,
          signal: child.signalCode ?? null,
          signalCode: child.signalCode ?? null,
        };
      },
    );
    this.exit = exited.then(
      async ({ code, signal, signalCode }) => {
        await streams;
        return {
          code,
          signal,
          signalCode,
          executionId: this.sessionId,
        };
      },
      (_error: unknown) => {
        return {
          code: null,
          signal: child.signalCode ?? null,
          signalCode: child.signalCode ?? null,
          executionId: this.sessionId,
        };
      },
    );
    void Promise.all([streams, exited]).then(() => this.finish());
  }

  private push(event: BackendEvent) {
    if (event.executionId) this.sessionId = event.executionId;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  private async consume(stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr") {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) this.line(source, raw.replace(/\r$/, ""));
      }
      buffer += decoder.decode();
      if (buffer) this.line(source, buffer);
    } catch (error: unknown) {
      this.error(source, error);
    } finally {
      reader.releaseLock();
    }
  }

  private error(source: "stdout" | "stderr" | "process", error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.push({
      stream: source === "process" ? "stderr" : source,
      raw: `${source} error: ${message}`,
    });
  }

  kill(signal?: number | NodeJS.Signals) {
    const child = this.child;
    if (!child.kill) return;
    try {
      child.kill(signal);
    } catch (error) {
      this.error("process", error);
    }
  }

  cancel() {
    this.kill("SIGTERM");
  }

  private line(stream: "stdout" | "stderr", raw: string) {
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* raw is intentionally retained */
    }
    this.push({
      stream,
      raw,
      ...(parsed === undefined
        ? {}
        : {
            parsed,
            normalized: normalized(this.invocation.runId, parsed),
            executionId: sessionOf(parsed),
          }),
    });
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiting) waiter({ value: undefined, done: true });
    this.waiting = [];
  }
  [Symbol.asyncIterator](): AsyncIterator<BackendEvent> {
    return {
      next: () =>
        this.queue.length
          ? Promise.resolve({ value: this.queue.shift()!, done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => this.waiting.push(resolve)),
    };
  }
  continue(prompt: string): BackendProcess {
    if (!this.sessionId) throw new Error("Cannot continue before OpenCode exposes a session ID");
    return new OpenCodeAdapter(this.options).start({
      ...this.invocation,
      prompt,
      _sessionId: this.sessionId,
    } as BackendInvocation & { _sessionId: string });
  }
}

export class OpenCodeAdapter implements BackendAdapter {
  readonly id = "opencode-cli-v1";
  readonly capabilities = [
    "repository.read",
    "repository.write",
    "workflow.delegate",
    "workflow.skill",
  ] as const;
  constructor(private readonly options: OpenCodeOptions = {}) {}
  start(invocation: BackendInvocation & { _sessionId?: string }): BackendProcess {
    const profile = openCodeProfile(invocation.agent.adapterProfile, invocation.agent);
    const prompt = invocation.systemPrompt
      ? `${invocation.systemPrompt}\n\n${invocation.prompt}`
      : invocation.prompt;
    const executable = this.options.executable ?? "opencode";
    const command = [
      ...(executable.endsWith(".js") ? [process.execPath, executable] : [executable]),
      "run",
      "--format",
      "json",
      "--dir",
      invocation.repositoryRoot,
      ...(profile ? ["--agent", profile] : []),
      "--model",
      invocation.model ?? invocation.agent.model ?? "",
      ...(invocation._sessionId ? ["--session", invocation._sessionId] : []),
      prompt,
    ];
    const env = { ...process.env, ...this.options.env };
    const child = this.options.spawn
      ? this.options.spawn(command, { cwd: invocation.repositoryRoot, env })
      : Bun.spawn(command, { cwd: invocation.repositoryRoot, env, stdout: "pipe", stderr: "pipe" });
    return new OpenCodeProcess(invocation, this.options, command, child as Spawned);
  }
}

type OpenCodeBinding = Readonly<{ opencodeAgent?: string }>;
function openCodeProfile(
  profile: Readonly<Record<string, unknown>> | undefined,
  legacyAgent?: unknown,
): string | undefined {
  const value =
    profile?.opencodeAgent ??
    (legacyAgent && typeof legacyAgent === "object"
      ? (legacyAgent as OpenCodeBinding).opencodeAgent
      : undefined);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The small subset of the V2 service client used to start a run. */
export type V2Client = {
  agent: Pick<OpenCodeClient["agent"], "list">;
  location: Pick<OpenCodeClient["location"], "get">;
  debug?: {
    location?: Pick<NonNullable<OpenCodeClient["debug"]>["location"], "evict">;
  };
  session: Pick<OpenCodeClient["session"], "create" | "prompt" | "wait" | "interrupt" | "active">;
  message: Pick<OpenCodeClient["message"], "list">;
};

export type V2PreflightErrorCode =
  | "V2_LOCATION_TRANSPORT"
  | "V2_LOCATION_MISMATCH"
  | "V2_AGENT_MISSING"
  | "V2_LOCATION_RELOAD_FAILED"
  | "V2_PROTOCOL_ERROR";

export type V2PreflightErrorCategory = "transport" | "protocol" | "location" | "agent" | "reload";

/** Safe, structured failure returned when the service cannot serve a repository. */
export class V2PreflightError extends Error {
  readonly code: V2PreflightErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly category: V2PreflightErrorCategory;
  readonly retryable: boolean;

  constructor(
    code: V2PreflightErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    metadata: { category?: V2PreflightErrorCategory; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "V2PreflightError";
    this.code = code;
    this.details = details;
    this.category =
      metadata.category ??
      (code === "V2_LOCATION_TRANSPORT"
        ? "transport"
        : code === "V2_PROTOCOL_ERROR"
          ? "protocol"
          : code === "V2_LOCATION_MISMATCH"
            ? "location"
            : code === "V2_AGENT_MISSING"
              ? "agent"
              : "reload");
    this.retryable =
      metadata.retryable ?? (code === "V2_LOCATION_MISMATCH" || code === "V2_AGENT_MISSING");
  }
}

/** All supported location-scoped SDK calls go through this input builder. */
function locationInput(directory: string) {
  return { location: { directory } };
}

/** Verify a repository-local custom agent, refreshing only that location when needed. */
export async function ensureV2AgentAvailable(
  client: V2Client,
  repositoryRoot: string,
  opencodeAgent: string | undefined,
  onDiagnostic?: LifecycleDiagnosticSink,
) {
  const diagnostic = onDiagnostic ?? (() => {});
  const expected = await realpath(repositoryRoot);
  let lastPreflightError: V2PreflightError | undefined;
  const equivalent = async (value: unknown, target: string) => {
    if (typeof value !== "string") return false;
    try {
      return (await realpath(value)) === target;
    } catch {
      return false;
    }
  };
  const check = async () => {
    diagnostic({ event: "agent_preflight", backend: "v2-client", state: "started" });
    let resolvedResponse: unknown;
    let agentsResponse: unknown;
    try {
      const input = locationInput(expected);
      resolvedResponse = await client.location.get(input);
      agentsResponse = await client.agent.list(input);
    } catch (cause) {
      throw new V2PreflightError("V2_LOCATION_TRANSPORT", "OpenCode location preflight failed", {
        directory: expected,
        cause: errorDetails(cause),
      });
    }
    const resolved = resolvedResponse as { directory?: unknown; project?: { directory?: unknown } };
    const agentsEnvelope = agentsResponse as { location?: unknown; data?: unknown };
    const agents = agentsEnvelope?.data;
    if (
      !resolved ||
      typeof resolved !== "object" ||
      typeof resolved.directory !== "string" ||
      !resolved.project ||
      typeof resolved.project !== "object" ||
      typeof resolved.project.directory !== "string" ||
      !agentsEnvelope ||
      typeof agentsEnvelope !== "object" ||
      !agentsEnvelope.location ||
      typeof agentsEnvelope.location !== "object" ||
      typeof (agentsEnvelope.location as { directory?: unknown }).directory !== "string" ||
      !Array.isArray(agents)
    )
      throw new V2PreflightError(
        "V2_PROTOCOL_ERROR",
        "OpenCode location preflight returned an invalid response",
        {
          directory: expected,
        },
      );
    const locationOk =
      (await equivalent(resolved.directory, expected)) &&
      (await equivalent(resolved.project?.directory, expected));
    if (!locationOk)
      throw new V2PreflightError(
        "V2_LOCATION_MISMATCH",
        "OpenCode location verification failed: service location does not match repository",
        {
          directory: expected,
          resolvedDirectory: resolved.directory,
          projectDirectory: resolved.project?.directory,
        },
      );
    const agentOk =
      !opencodeAgent ||
      agents.some((agent) => {
        if (!agent || typeof agent !== "object") return false;
        const value = agent as { id?: unknown; name?: unknown };
        return value.id === opencodeAgent || value.name === opencodeAgent;
      });
    if (!agentOk)
      throw new V2PreflightError(
        "V2_AGENT_MISSING",
        `OpenCode location verification failed: agent is unavailable: ${opencodeAgent}`,
        {
          directory: expected,
          agent: opencodeAgent,
        },
      );
    const valid = true;
    diagnostic({
      event: "agent_preflight",
      backend: "v2-client",
      state: valid ? "succeeded" : "failed",
    });
    return valid;
  };
  // A shared service can retain a failed location load. Refresh only this repository;
  // callers must check their workflow lock before invoking this operation.
  try {
    if (await check()) return;
  } catch (error) {
    if (!(error instanceof V2PreflightError) || !error.retryable) throw error;
    lastPreflightError = error;
  }
  diagnostic({ event: "location_refresh", backend: "v2-client", state: "started" });
  try {
    if (!client.debug?.location?.evict)
      throw new Error("location eviction endpoint is unavailable");
    await client.debug.location.evict(locationInput(expected));
  } catch (cause) {
    const error = new V2PreflightError(
      "V2_LOCATION_RELOAD_FAILED",
      "OpenCode location reload failed",
      { directory: expected, cause: errorDetails(cause) },
    );
    diagnostic({
      event: "location_refresh",
      backend: "v2-client",
      state: "failed",
      ...errorDetails(error),
    });
    throw error;
  }
  diagnostic({ event: "location_refresh", backend: "v2-client", state: "succeeded" });
  let verified = false;
  try {
    verified = await check();
  } catch (error) {
    if (!(error instanceof V2PreflightError)) throw error;
    lastPreflightError = error;
  }
  if (!verified) {
    const error =
      lastPreflightError ??
      new V2PreflightError("V2_LOCATION_RELOAD_FAILED", "OpenCode location verification failed", {
        directory: expected,
      });
    diagnostic({
      event: "agent_preflight",
      backend: "v2-client",
      state: "failed",
      ...errorDetails(error),
    });
    throw error;
  }
}

type V2MessageList = NonNullable<V2Client["message"]>["list"];
type V2Message = Awaited<ReturnType<V2MessageList>>["data"][number];

function createV2SessionId() {
  return `ses_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The prompt endpoint returns an inbox user item, not the assistant message
 * produced by that item. Take a complete, ascending message snapshot on both
 * sides of the prompt and only reconcile assistant IDs that did not exist in
 * the pre-prompt snapshot. `message.list` is cursor paginated, so never treat
 * its first page as the complete history.
 */
async function allSessionMessages(
  client: V2Client,
  sessionID: string,
  signal: AbortSignal,
): Promise<V2Message[]> {
  const list = client.message.list;
  const messages: V2Message[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(
      {
        sessionID,
        // The V2 API rejects combining a cursor with an order. Ordering the
        // first page is sufficient: subsequent pages continue that order.
        ...(cursor ? {} : { order: "asc" }),
        ...(cursor ? { cursor } : {}),
      },
      { signal },
    );
    if (!page) break;
    messages.push(...page.data);
    cursor = page.cursor?.next ?? undefined;
  } while (cursor);
  return messages;
}

function newAssistantMessage(
  before: readonly V2Message[],
  after: readonly V2Message[],
): SessionMessageAssistant | undefined {
  const beforeIds = new Set(before.map((message) => message.id));
  // The SDK contract guarantees ascending order when requested above. The
  // timestamp comparison also makes this safe if a compatible host ignores
  // the order parameter, without ever considering a pre-prompt message.
  return after
    .filter(
      (message): message is SessionMessageAssistant =>
        message.type === "assistant" && !beforeIds.has(message.id),
    )
    .reduce<SessionMessageAssistant | undefined>((latest, message) => {
      if (!latest || message.time.created >= latest.time.created) return message;
      return latest;
    }, undefined);
}

export type V2OpenCodeOptions = Readonly<{
  hostManager: Pick<UiHostManager, "registerEventConsumer" | "withHost">;
  /** Optional client seam for deterministic tests. Production obtains this from the manager. */
  client?: V2Client;
  onDiagnostic?: LifecycleDiagnosticSink;
}>;

class V2OpenCodeProcess implements BackendProcess {
  readonly executionKind = "service" as const;
  readonly pid = 0;
  readonly command: readonly string[] = [];
  readonly exit: Promise<BackendExit>;
  private readonly events: BackendEvent[] = [];
  private readonly waiters: ((result: IteratorResult<BackendEvent>) => void)[] = [];
  private closed = false;
  private sessionId: string | undefined;
  private readonly preSessionEvents: {
    event: UiHostEvent;
    sessionId?: string;
  }[] = [];
  private hostFailure: UiHostManagerBackendFailureError | undefined;
  private subscription: { unsubscribe: () => void } | undefined;
  private readonly abortController = new AbortController();
  private readonly toolNames: V2ToolNames = new Map();
  private canceled = false;
  private interruptRequested = false;
  private interruptPromise: Promise<void> | undefined;
  private readonly createsSession: boolean;
  private readonly onDiagnostic: LifecycleDiagnosticSink;
  private repositoryRoot: string;

  constructor(
    private readonly invocation: BackendInvocation,
    private readonly options: V2OpenCodeOptions,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
    this.createsSession = sessionId === undefined;
    this.onDiagnostic = options.onDiagnostic ?? defaultLifecycleDiagnostic;
    this.repositoryRoot = invocation.repositoryRoot;
    this.exit = this.run();
  }

  private push(event: BackendEvent) {
    if (event.executionId) this.sessionId = event.executionId;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
  }

  private async run(): Promise<BackendExit> {
    try {
      // Adapters are also callable directly by hosts/tests; do not rely on
      // startWorkflow having canonicalized the path first.
      this.repositoryRoot = await realpath(this.invocation.repositoryRoot);
      this.onDiagnostic({
        event: "run",
        backend: "v2-client",
        runId: this.invocation.runId,
        state: "started",
      });
      // This intentionally precedes both SDK calls: session.created and execution
      // events can be emitted synchronously by an embedded host.
      this.subscription = this.options.hostManager.registerEventConsumer({
        location: { directory: this.repositoryRoot },
        sessionId: this.sessionId,
        onEvent: (event) => {
          const value = event as unknown;
          const sessionId = sessionOf(value);
          if (!this.sessionId) {
            // A consumer cannot be registered with a session filter until create
            // returns. Buffer this small race window so concurrent invocations
            // in one directory cannot leak each other's early events.
            this.preSessionEvents.push({ event, sessionId });
            return;
          }
          // The host is shared by all invocations; never let a known foreign
          // session leak into this process's stream.
          if (this.sessionId && sessionId !== this.sessionId) return;
          this.push({
            stream: "stdout",
            raw: JSON.stringify(value),
            parsed: value,
            normalized: normalizedV2(this.invocation.runId, event, this.toolNames),
            executionId: sessionId,
          });
        },
        onError: (error: UiHostManagerBackendFailureError) => {
          this.hostFailure = error;
          if (error instanceof UiHostManagerEventQueueOverflowError) {
            if (error.sessionId) this.sessionId = error.sessionId;
            this.canceled = true;
          }
          this.onDiagnostic({
            event: "event_stream_failure",
            backend: "v2-client",
            runId: this.invocation.runId,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...errorDetails(error),
          });
          this.push({ stream: "stderr", raw: error.message });
          this.abortController.abort();
          // A broken event stream can leave the provider running even though
          // the local process is no longer able to observe it. Stop only this
          // session, and keep failures in the shared manager best effort.
          const sessionId =
            this.sessionId ??
            (error instanceof UiHostManagerEventQueueOverflowError ? error.sessionId : undefined);
          if (this.options.client) void this.requestInterrupt(this.options.client, sessionId);
          else if (sessionId)
            void this.options.hostManager
              .withHost(async (client) => {
                await this.requestInterrupt(client, sessionId);
              })
              .catch(() => undefined);
        },
      });
      const execute = async (client: V2Client) => {
        const model = this.invocation.model ?? this.invocation.agent.model ?? "";
        const profile = openCodeProfile(this.invocation.agent.adapterProfile);
        if (this.createsSession) {
          const reservedId = this.sessionId ?? createV2SessionId();
          this.onDiagnostic({
            event: "session_create",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: reservedId,
            state: "started",
          });
          const slash = model.indexOf("/");
          const creating = client.session.create(
            {
              ...locationInput(this.repositoryRoot),
              ...(profile ? { agent: profile } : {}),
              id: reservedId,
              ...(model
                ? {
                    model: {
                      providerID: slash < 0 ? "" : model.slice(0, slash),
                      id: slash < 0 ? model : model.slice(slash + 1),
                    },
                  }
                : {}),
            },
            { signal: this.abortController.signal },
          );
          // Still observe a creation that outlives cancellation so a session
          // created by a slow host is interrupted rather than leaked.
          // Keep observing a late create, but never make process finalization
          // depend on an SDK promise that may never settle.
          void creating.then(
            (created: { id: string }) => {
              if (this.canceled || this.hostFailure) {
                this.sessionId = created.id;
                void this.requestInterrupt(client, created.id);
              }
            },
            () => undefined,
          );
          let created: Awaited<typeof creating> | undefined;
          try {
            created = await this.abortable(creating);
          } catch (error) {
            this.onDiagnostic({
              event: "session_create_failure",
              backend: "v2-client",
              runId: this.invocation.runId,
              sessionId: reservedId,
              ...errorDetails(error),
            });
            throw error;
          }
          this.sessionId = created!.id;
          this.onDiagnostic({
            event: "session_create",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "succeeded",
          });
          if (this.hostFailure) void this.requestInterrupt(client, this.sessionId);
          const pending = this.preSessionEvents.splice(0);
          for (const item of pending) {
            if (item.sessionId === this.sessionId)
              this.push({
                stream: "stdout",
                raw: JSON.stringify(item.event),
                parsed: item.event,
                normalized: normalizedV2(this.invocation.runId, item.event, this.toolNames),
                executionId: item.sessionId,
              });
          }
          if (this.canceled) this.requestInterrupt(client);
        }
        const text = this.invocation.systemPrompt
          ? `${this.invocation.systemPrompt}\n\n${this.invocation.prompt}`
          : this.invocation.prompt;
        let messagesBeforePrompt: V2Message[];
        this.onDiagnostic({
          event: "session_message_retrieval",
          backend: "v2-client",
          runId: this.invocation.runId,
          sessionId: this.sessionId,
          state: "started",
        });
        try {
          messagesBeforePrompt =
            (await this.abortable(
              allSessionMessages(client, this.sessionId!, this.abortController.signal),
            )) ?? [];
          this.onDiagnostic({
            event: "session_message_retrieval",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "succeeded",
          });
        } catch (error) {
          this.onDiagnostic({
            event: "session_message_retrieval_failure",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            ...errorDetails(error),
          });
          throw error;
        }
        try {
          this.onDiagnostic({
            event: "session_prompt",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "started",
          });
          await this.abortable(
            client.session.prompt(
              {
                sessionID: this.sessionId!,
                text,
              },
              { signal: this.abortController.signal },
            ),
          );
          this.onDiagnostic({
            event: "session_prompt",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "succeeded",
          });
        } catch (error) {
          this.onDiagnostic({
            event: "session_prompt_failure",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            ...errorDetails(error),
          });
          throw error;
        }
        // prompt is not required to wait for execution on every V2 host.
        try {
          this.onDiagnostic({
            event: "session_wait",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "started",
          });
          await this.abortable(
            client.session.wait(
              {
                sessionID: this.sessionId!,
              },
              { signal: this.abortController.signal },
            ),
          );
          this.onDiagnostic({
            event: "session_wait",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "succeeded",
          });
        } catch (error) {
          this.onDiagnostic({
            event: "session_wait_failure",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            ...errorDetails(error),
          });
          throw error;
        }
        let messagesAfterPrompt: V2Message[];
        this.onDiagnostic({
          event: "session_message_retrieval",
          backend: "v2-client",
          runId: this.invocation.runId,
          sessionId: this.sessionId,
          state: "started",
        });
        try {
          messagesAfterPrompt =
            (await this.abortable(
              allSessionMessages(client, this.sessionId!, this.abortController.signal),
            )) ?? [];
          this.onDiagnostic({
            event: "session_message_retrieval",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            state: "succeeded",
          });
        } catch (error) {
          this.onDiagnostic({
            event: "session_message_retrieval_failure",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId: this.sessionId,
            ...errorDetails(error),
          });
          throw error;
        }
        // The prompt response has no causal assistant-message ID. The
        // before/after ID boundary is therefore the safest supported
        // correlation; it deliberately has no fallback to an older response.
        const latestAssistant = newAssistantMessage(messagesBeforePrompt, messagesAfterPrompt);
        if (latestAssistant) {
          this.push({
            stream: "stdout",
            // SessionMessageAssistant is part of the generated client model;
            // emit it directly rather than inventing an SDK event discriminant.
            raw: JSON.stringify(latestAssistant),
            parsed: latestAssistant,
            executionId: this.sessionId,
          });
        }
      };
      if (this.options.client) await execute(this.options.client);
      else await this.abortable(this.options.hostManager.withHost(execute));
      if (this.hostFailure)
        return { code: null, signal: null, signalCode: null, executionId: this.sessionId };
      this.onDiagnostic({
        event: "run",
        backend: "v2-client",
        runId: this.invocation.runId,
        sessionId: this.sessionId,
        state: "succeeded",
      });
      return { code: 0, signal: null, signalCode: null, executionId: this.sessionId };
    } catch (error) {
      if (this.canceled) {
        return { code: null, signal: null, signalCode: null, executionId: this.sessionId };
      }
      if (this.hostFailure)
        return { code: null, signal: null, signalCode: null, executionId: this.sessionId };
      const message = error instanceof Error ? error.message : String(error);
      this.push({ stream: "stderr", raw: `V2 error: ${message}`, executionId: this.sessionId });
      return { code: null, signal: null, signalCode: null, executionId: this.sessionId };
    } finally {
      // Cancellation is best effort. In particular, a host may never settle
      // create/prompt/wait/list; exit must still release the UI shutdown path.
      void this.interruptPromise;
      this.subscription?.unsubscribe();
      this.finish();
    }
  }

  private abortable<T>(operation: Promise<T> | undefined): Promise<T | undefined> {
    if (!operation) return Promise.resolve(undefined);
    if (this.abortController.signal.aborted)
      return Promise.reject(new Error("V2 process canceled"));
    return new Promise<T | undefined>((resolve, reject) => {
      const onAbort = () => {
        this.abortController.signal.removeEventListener("abort", onAbort);
        reject(new Error("V2 process canceled"));
      };
      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          this.abortController.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          this.abortController.signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private requestInterrupt(client?: V2Client, sessionId = this.sessionId): Promise<void> {
    if (this.interruptRequested || !sessionId) return Promise.resolve();
    this.interruptRequested = true;
    this.onDiagnostic({
      event: "session_interrupt",
      backend: "v2-client",
      runId: this.invocation.runId,
      sessionId,
      state: "requested",
    });
    const interrupt = client?.session.interrupt;
    if (!interrupt) return Promise.resolve();
    // Never let an SDK interrupt failure reject exit (or the shared host).
    const pending = Promise.resolve()
      .then(() => interrupt({ sessionID: sessionId }))
      .then(
        () => {
          this.onDiagnostic({
            event: "session_interrupt",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId,
            state: "stopped",
          });
          return undefined;
        },
        (error) => {
          this.onDiagnostic({
            event: "session_interrupt_failure",
            backend: "v2-client",
            runId: this.invocation.runId,
            sessionId,
            ...errorDetails(error),
          });
          return undefined;
        },
      );
    this.interruptPromise = pending;
    return pending;
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter({ value: undefined, done: true });
    this.waiters.length = 0;
  }
  kill(): void {}
  cancel(): void {
    if (this.closed || this.canceled) return;
    this.canceled = true;
    this.abortController.abort();
    // The client seam is available in tests; production resolves it through
    // withHost without touching the manager lifecycle.
    if (this.options.client) this.requestInterrupt(this.options.client);
    else if (this.sessionId) {
      void this.options.hostManager
        .withHost(async (client) => {
          this.requestInterrupt(client);
        })
        .catch(() => undefined);
    }
  }
  continue(prompt: string): BackendProcess {
    if (!this.sessionId) throw new Error("Cannot continue before V2 exposes a session ID");
    return new V2OpenCodeProcess({ ...this.invocation, prompt }, this.options, this.sessionId);
  }
  [Symbol.asyncIterator](): AsyncIterator<BackendEvent> {
    return {
      next: () =>
        this.events.length
          ? Promise.resolve({ value: this.events.shift()!, done: false })
          : this.closed
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => this.waiters.push(resolve)),
    };
  }
}

/** Service V2 adapter. It creates exactly one session per invocation. */
export class V2OpenCodeAdapter implements BackendAdapter {
  readonly id = "opencode-service-v2";
  readonly capabilities = [
    "repository.read",
    "repository.write",
    "workflow.delegate",
    "workflow.skill",
  ] as const;
  readonly supportsConcurrent = true;
  constructor(private readonly options: V2OpenCodeOptions) {}
  start(invocation: BackendInvocation): BackendProcess {
    return new V2OpenCodeProcess(invocation, this.options);
  }
}
