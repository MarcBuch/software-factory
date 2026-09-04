import { resolve } from "node:path";

import { OpenCode as ClientOpenCode, type OpenCodeEvent } from "@opencode-ai/client";
import { Service, type Endpoint } from "@opencode-ai/client/service";

import {
  defaultLifecycleDiagnostic,
  errorDetails,
  type LifecycleDiagnosticSink,
} from "./lifecycle-diagnostics";

/** The small client surface consumed by the event manager and test fakes. */
export type UiHost = any;
export type UiHostFactory = (options?: unknown) => Promise<UiHost>;
export type UiHostEnsure = (options: {
  version: (version: string) => boolean;
  command: readonly string[];
}) => Promise<Endpoint>;
export type UiHostClientFactory = (endpoint: Endpoint) => UiHost;
export const isV2ServiceVersion = (version: string) =>
  version.startsWith("0.0.0-beta-") || version.startsWith("0.0.0-dev-") || version.startsWith("2.");
/** The generated event union emitted by the singular client event API. */
export type OpenCodeHostEvent = OpenCodeEvent;
/** @deprecated Use OpenCodeHostEvent. */
export type UiHostEvent = OpenCodeHostEvent;
export type UiHostLocation = string | { directory?: string; workspace?: string };

export type OpenCodeEventConsumerOptions = {
  sessionId?: string;
  location?: UiHostLocation;
  queueSize?: number;
  onEvent: (event: OpenCodeHostEvent) => void | Promise<void>;
  /** Called when the host event source fails. A new manager is required afterwards. */
  onError?: (error: UiHostManagerBackendFailureError) => void | Promise<void>;
  onDiagnostic?: LifecycleDiagnosticSink;
};

export type OpenCodeEventSubscription = {
  unsubscribe: () => void;
  readonly droppedEvents: number;
};

function locationIdentity(location: UiHostLocation | undefined): string | undefined {
  if (!location) return undefined;
  const value =
    typeof location === "string" ? location : (location.directory ?? location.workspace);
  return value
    ? resolve(value)
        .replace(/[\\/]$/, "")
        .toLowerCase()
    : undefined;
}

function eventIdentity(event: OpenCodeHostEvent) {
  const data = (event as { data?: Record<string, unknown> }).data;
  const location = data?.location ?? (event as { location?: unknown }).location;
  const directory =
    typeof location === "string"
      ? location
      : location && typeof location === "object"
        ? ((location as { directory?: string; workspace?: string }).directory ??
          (location as { directory?: string; workspace?: string }).workspace)
        : undefined;
  return {
    sessionId:
      typeof data?.sessionID === "string"
        ? data.sessionID
        : typeof data?.sessionId === "string"
          ? data.sessionId
          : undefined,
    location: locationIdentity(directory),
  };
}

export class UiHostManagerClosedError extends Error {
  constructor() {
    super("OpenCode host manager is shutting down");
    this.name = "UiHostManagerClosedError";
  }
}

export class UiHostManagerBackendFailureError extends Error {
  constructor(cause: unknown, message = "OpenCode host event source failed") {
    super(message, { cause });
    this.name = "UiHostManagerBackendFailureError";
  }
}

/** A consumer-local failure; it must not transition the shared host to failed. */
export class UiHostManagerEventQueueOverflowError extends UiHostManagerBackendFailureError {
  readonly sessionId?: string;
  readonly queueSize: number;

  constructor(sessionId: string | undefined, queueSize: number) {
    super(new Error("bounded event queue capacity exceeded"), "OpenCode event queue overflow");
    this.name = "UiHostManagerEventQueueOverflowError";
    this.sessionId = sessionId;
    this.queueSize = queueSize;
  }
}

export type UiHostManagerOptions = {
  factory?: UiHostFactory;
  /** Client options are accepted as a test/configuration seam. */
  options?: Record<string, unknown>;
  ensure?: UiHostEnsure;
  clientFactory?: UiHostClientFactory;
  onDiagnostic?: LifecycleDiagnosticSink;
  /** Maximum time shutdown waits for SDK operations before forcing host close. */
  shutdownGraceMs?: number;
  /** Maximum time to wait for the live service event stream's readiness event. */
  connectedTimeoutMs?: number;
};

const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_CONNECTED_TIMEOUT_MS = 5_000;

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const delay = Math.max(0, timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(undefined);
    }, delay);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Owns the client subscription and local client state, never the service endpoint. */
export class UiHostManager {
  private readonly hostPromise: Promise<UiHost>;
  private readonly consumers = new Set<Consumer>();
  private eventPumpPromise: Promise<void> | undefined;
  private eventIterator: AsyncIterator<OpenCodeHostEvent> | undefined;
  private eventIteratorReturnPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private state: "running" | "failed" | "closing" | "closed" = "running";
  private failure: UiHostManagerBackendFailureError | undefined;
  private readonly onDiagnostic: LifecycleDiagnosticSink;
  private readonly shutdownGraceMs: number;
  private readonly connectedTimeoutMs: number;
  private readonly connectedReady: Promise<void>;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: unknown) => void;
  private connectedTimer: ReturnType<typeof setTimeout> | undefined;
  private connectedRequired = false;

  constructor(options: UiHostManagerOptions = {}) {
    this.onDiagnostic = options.onDiagnostic ?? defaultLifecycleDiagnostic;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.connectedTimeoutMs = options.connectedTimeoutMs ?? DEFAULT_CONNECTED_TIMEOUT_MS;
    this.connectedReady = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    // Readiness is also rejected when construction fails or the stream dies. Keep
    // that internal rejection observed even when no caller reached withHost().
    void this.connectedReady.catch(() => undefined);
    const create = async (): Promise<UiHost> => {
      if (options.factory) return options.factory(options.options);
      this.onDiagnostic({ event: "service_ensure", backend: "v2-client", state: "started" });
      let endpoint: Endpoint;
      try {
        endpoint = await (options.ensure ?? Service.ensure)({
          version: isV2ServiceVersion,
          command: ["opencode2", "serve", "--service"],
        });
      } catch (error) {
        this.onDiagnostic({
          event: "service_ensure",
          backend: "v2-client",
          state: "failed",
          ...errorDetails(error),
        });
        throw error;
      }
      this.onDiagnostic({ event: "service_ensure", backend: "v2-client", state: "succeeded" });
      this.onDiagnostic({ event: "client_creation", backend: "v2-client", state: "started" });
      const client = (
        options.clientFactory ??
        ((service) => {
          this.onDiagnostic({ event: "auth_setup", backend: "v2-client", state: "started" });
          const headers = Service.headers(service);
          const result = ClientOpenCode.make({ baseUrl: service.url, headers }) as UiHost;
          this.onDiagnostic({ event: "auth_setup", backend: "v2-client", state: "succeeded" });
          return result;
        })
      )(endpoint);
      this.onDiagnostic({ event: "client_creation", backend: "v2-client", state: "succeeded" });
      this.onDiagnostic({ event: "health_check", backend: "v2-client", state: "started" });
      const health = await client.health.get();
      if (!health.healthy) throw new Error("OpenCode service health check failed");
      this.onDiagnostic({ event: "health_check", backend: "v2-client", state: "succeeded" });
      return client;
    };
    this.hostPromise = create();
    void this.hostPromise.catch((error) => {
      this.onDiagnostic({
        event: "host_creation_failure",
        backend: "v2-client",
        ...errorDetails(error),
      });
    });
    // Keep the pump promise handled: a failed source must not become an unhandled
    // rejection before close() is called.
    this.eventPumpPromise = this.hostPromise.then(
      (host) => this.pumpEvents(host),
      (error) => {
        this.rejectConnected(error);
        return this.fail(error);
      },
    );
  }

  /** Registers before a prompt is issued. Events are delivered in source order per consumer. */
  registerEventConsumer(options: OpenCodeEventConsumerOptions): OpenCodeEventSubscription {
    let consumer: Consumer;
    consumer = new Consumer(
      {
        ...options,
        onDiagnostic: options.onDiagnostic ?? this.onDiagnostic,
      },
      () => this.consumers.delete(consumer),
    );
    if (this.failure) consumer.fail(this.failure);
    else if (this.state !== "running") consumer.close();
    else this.consumers.add(consumer);
    return {
      unsubscribe: () => {
        consumer.close();
      },
      get droppedEvents() {
        return consumer.droppedEvents;
      },
    };
  }

  /** Exposed for deterministic lifecycle tests without exposing the consumers themselves. */
  get consumerCountForTesting(): number {
    return this.consumers.size;
  }

  private async pumpEvents(host: UiHost): Promise<void> {
    const subscribe = host.event?.subscribe;
    if (!subscribe) {
      this.resolveConnected();
      return;
    }
    let stream: AsyncIterable<OpenCodeHostEvent>;
    this.onDiagnostic({ event: "readiness", backend: "v2-client", state: "started" });
    try {
      stream = subscribe();
      this.connectedRequired = true;
      this.connectedTimer = setTimeout(
        () => {
          const error = new UiHostManagerBackendFailureError(
            new Error("server.connected readiness event was not received"),
            "OpenCode host event source did not become ready",
          );
          this.onDiagnostic({
            event: "readiness",
            backend: "v2-client",
            state: "timed_out",
            ...errorDetails(error),
          });
          this.rejectConnected(error);
          void this.fail(error);
        },
        Math.max(0, this.connectedTimeoutMs),
      );
    } catch (error) {
      this.rejectConnected(error);
      if (this.connectedTimer) clearTimeout(this.connectedTimer);
      this.connectedTimer = undefined;
      this.onDiagnostic({
        event: "event_stream_failure",
        backend: "v2-client",
        ...errorDetails(error),
      });
      await this.fail(error);
      return;
    }
    let iterator: AsyncIterator<OpenCodeHostEvent>;
    try {
      iterator = stream[Symbol.asyncIterator]();
    } catch (error) {
      this.rejectConnected(error);
      if (this.connectedTimer) clearTimeout(this.connectedTimer);
      this.connectedTimer = undefined;
      this.onDiagnostic({
        event: "event_stream_failure",
        backend: "v2-client",
        ...errorDetails(error),
      });
      await this.fail(error);
      return;
    }
    this.eventIterator = iterator;
    try {
      if (this.state !== "running") return;
      while (true) {
        const result = await iterator.next();
        if (result.done) break;
        const event = result.value;
        if (event.type === "server.connected") {
          this.resolveConnected();
          this.onDiagnostic({ event: "readiness", backend: "v2-client", state: "succeeded" });
          if (this.connectedTimer) clearTimeout(this.connectedTimer);
          this.connectedTimer = undefined;
        }
        for (const consumer of this.consumers) consumer.offer(event);
      }
      if (this.state === "running") {
        this.onDiagnostic({ event: "event_stream_end", backend: "v2-client" });
        await this.fail(new Error("OpenCode host event source ended"));
      }
    } catch (error) {
      if (this.state === "running") {
        this.onDiagnostic({
          event: "event_stream_failure",
          backend: "v2-client",
          ...errorDetails(error),
        });
        await this.fail(error);
      }
    } finally {
      try {
        await this.returnEventIterator(iterator);
      } catch (error) {
        if (this.state === "running") {
          this.onDiagnostic({
            event: "event_stream_failure",
            backend: "v2-client",
            ...errorDetails(error),
          });
          await this.fail(error);
        }
      }
      if (this.eventIterator === iterator) this.eventIterator = undefined;
      if (this.connectedRequired && this.connectedTimer) clearTimeout(this.connectedTimer);
      this.connectedTimer = undefined;
    }
  }

  private returnEventIterator(iterator: AsyncIterator<OpenCodeHostEvent>): Promise<void> {
    if (!this.eventIteratorReturnPromise) {
      // Defer the call so the shared promise is installed before a synchronous
      // return() failure can occur. This also makes close/creation races safe.
      this.eventIteratorReturnPromise = Promise.resolve()
        .then(() => iterator.return?.())
        .then(() => undefined);
    }
    return this.eventIteratorReturnPromise;
  }

  private async fail(cause: unknown): Promise<void> {
    if (this.failure || this.state === "closing" || this.state === "closed") return;
    this.failure = new UiHostManagerBackendFailureError(cause);
    this.state = "failed";
    this.rejectConnected(this.failure);
    const consumers = [...this.consumers];
    for (const consumer of consumers) consumer.fail(this.failure);
    if (this.eventIterator)
      void this.returnEventIterator(this.eventIterator).catch(() => undefined);
  }

  /** Runs one operation against the host, while rejecting operations after close starts. */
  async withHost<T>(operation: (host: UiHost) => Promise<T>): Promise<T> {
    if (this.failure) throw this.failure;
    if (this.state !== "running") throw new UiHostManagerClosedError();
    const host = await this.hostPromise;
    if (this.failure) throw this.failure;
    if (this.state !== "running") throw new UiHostManagerClosedError();
    await this.connectedReady;
    if (this.failure) throw this.failure;
    if (this.state !== "running") throw new UiHostManagerClosedError();
    return operation(host);
  }

  /** Begins shutdown and closes the SDK host at most once. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.onDiagnostic({ event: "shutdown", backend: "v2-client", state: "started" });
    this.rejectConnected(new UiHostManagerClosedError());
    if (this.connectedTimer) clearTimeout(this.connectedTimer);
    this.connectedTimer = undefined;
    const consumers = [...this.consumers];
    for (const consumer of consumers) consumer.close();
    if (this.eventIterator)
      void this.returnEventIterator(this.eventIterator).catch(() => undefined);
    this.closePromise = (async () => {
      // Return the concrete iterator, not merely the wrapper returned by
      // subscribe(). A broken stream must not hold UI shutdown indefinitely.
      if (this.eventIteratorReturnPromise)
        await bounded(this.eventIteratorReturnPromise, this.shutdownGraceMs).catch(() => undefined);
      // Host creation failures are already reported by the creation observer and
      // must not turn best-effort shutdown into another lifecycle failure.
      const host = await bounded(this.hostPromise, this.shutdownGraceMs).catch(() => undefined);
      if (!host) {
        // A host that finishes creating after the grace period still must be
        // closed, but it must not keep shutdown pending.
        // The endpoint can be discovered/shared. Do not close or stop a late
        // client: only the manager-owned iterator/subscriptions are local.
        this.onDiagnostic({ event: "shutdown", backend: "v2-client", state: "timed_out" });
        return;
      }
      // Service.ensure can return an existing/shared endpoint. Closing this
      // manager releases no server process; the iterator was closed above.
      void host;
    })().finally(() => {
      this.state = "closed";
      this.onDiagnostic({ event: "shutdown", backend: "v2-client", state: "stopped" });
    });
    return this.closePromise;
  }
}

class Consumer {
  private readonly sessionId?: string;
  private readonly location?: string;
  private readonly queue: OpenCodeHostEvent[] = [];
  private running = false;
  private closed = false;
  droppedEvents = 0;
  private readonly limit: number;

  constructor(
    private readonly options: OpenCodeEventConsumerOptions,
    private readonly onTerminal: () => void,
  ) {
    this.sessionId = options.sessionId;
    this.location = locationIdentity(options.location);
    this.limit = Math.max(1, Math.floor(options.queueSize ?? 64));
  }

  offer(event: OpenCodeHostEvent) {
    if (this.closed) return;
    const identity = eventIdentity(event);
    // Session events may omit location, even when the consumer was registered
    // with one. An exact session match is authoritative in that case. Explicit
    // session or location mismatches still reject the event so consumers that
    // share a workspace cannot receive each other's events.
    if (this.sessionId && identity.sessionId !== this.sessionId) return;
    if (
      this.location &&
      (identity.location === undefined ? !this.sessionId : identity.location !== this.location)
    )
      return;
    if (this.queue.length >= this.limit) {
      this.droppedEvents += 1;
      this.options.onDiagnostic?.({
        event: "event_queue_overflow",
        backend: "v2-client",
        ...((identity.sessionId ?? this.sessionId)
          ? { sessionId: identity.sessionId ?? this.sessionId }
          : {}),
        droppedEvents: this.droppedEvents,
      });
      this.fail(
        new UiHostManagerEventQueueOverflowError(identity.sessionId ?? this.sessionId, this.limit),
      );
      return;
    }
    this.queue.push(event);
    void this.drain();
  }

  fail(error: UiHostManagerBackendFailureError) {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.onTerminal();
    void Promise.resolve(this.options.onError?.(error)).catch(() => undefined);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.onTerminal();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.closed && this.queue.length) await this.options.onEvent(this.queue.shift()!);
    } catch {
      // A consumer must not be able to create an unhandled rejection or stop
      // delivery to other consumers.
    } finally {
      this.running = false;
    }
  }
}
