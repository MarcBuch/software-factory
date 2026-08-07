import type { AgentRosterEntry, TraceEvent } from "./workflow";
import { TraceEventSchema } from "./workflow";

/** The deliberately small contract implemented by all workflow backends. */
export type BackendInvocation = Readonly<{
  repositoryRoot: string;
  runId: string;
  agent: AgentRosterEntry;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  tools?: readonly string[];
}>;

export type BackendEvent = Readonly<{
  stream: "stdout" | "stderr";
  raw: string;
  parsed?: unknown;
  normalized?: TraceEvent;
  sessionId?: string;
}>;

export type BackendExit = Readonly<{
  code: number | null;
  signal: string | null;
  signalCode: string | null;
  sessionId?: string;
}>;

export interface BackendProcess extends AsyncIterable<BackendEvent> {
  readonly pid: number;
  readonly command: readonly string[];
  readonly exit: Promise<BackendExit>;
  kill(signal?: number | NodeJS.Signals): void;
  cancel(): void;
  continue(prompt: string): BackendProcess;
}

export interface BackendAdapter {
  start(invocation: BackendInvocation): BackendProcess;
}

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
  if (type === "tool_use" || type === "tool_call" || type === "tool_start")
    candidate = {
      ...base,
      type: "tool_call",
      agentName: name,
      tool: String(event.tool ?? event.name ?? event.part?.tool ?? "tool"),
      input: event.input ?? event.part?.state?.input,
      ...(typeof (event.callID ?? event.callId ?? event.toolCallId ?? event.id) === "string"
        ? { spanId: event.callID ?? event.callId ?? event.toolCallId ?? event.id }
        : {}),
      ...(type === "tool_start" || type === "tool_use" ? { phase: "start" } : {}),
    };
  else if (type === "tool_result" || type === "tool_end")
    candidate = {
      ...base,
      type: "tool_call",
      agentName: name,
      tool: String(event.tool ?? event.name ?? event.part?.tool ?? "tool"),
      output: event.output ?? event.part?.state?.output,
      ...(typeof (event.callID ?? event.callId ?? event.toolCallId ?? event.id) === "string"
        ? { spanId: event.callID ?? event.callId ?? event.toolCallId ?? event.id }
        : {}),
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
          sessionId: this.sessionId,
        };
      },
      (_error: unknown) => {
        return {
          code: null,
          signal: child.signalCode ?? null,
          signalCode: child.signalCode ?? null,
          sessionId: this.sessionId,
        };
      },
    );
    void Promise.all([streams, exited]).then(() => this.finish());
  }

  private push(event: BackendEvent) {
    if (event.sessionId) this.sessionId = event.sessionId;
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
            sessionId: sessionOf(parsed),
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
  constructor(private readonly options: OpenCodeOptions = {}) {}
  start(invocation: BackendInvocation & { _sessionId?: string }): BackendProcess {
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
      ...(invocation.agent.opencodeAgent ? ["--agent", invocation.agent.opencodeAgent] : []),
      "--model",
      invocation.model ?? invocation.agent.model,
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
