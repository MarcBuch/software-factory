import { expect, test } from "bun:test";

import {
  UiHostManager,
  UiHostManagerBackendFailureError,
  type UiHost,
  type OpenCodeHostEvent,
  type UiHostEvent,
} from "../src/ui-host-manager";

function source() {
  const queue: UiHostEvent[] = [];
  const waiters: Array<(result: IteratorResult<UiHostEvent>) => void> = [];
  let ended = false;
  const stream = {
    next: () => {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<UiHostEvent>>((resolve) => waiters.push(resolve));
    },
    return: () => {
      ended = true;
      for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    stream,
    push(event: UiHostEvent) {
      const resolve = waiters.shift();
      if (resolve) resolve({ value: event, done: false });
      else queue.push(event);
    },
  };
}

const event = (sessionID: string, directory: string, n: number) =>
  ({
    type: `test.${n}`,
    location: { directory },
    data: { sessionID, n },
  }) as unknown as UiHostEvent;

const eventWithoutLocation = (sessionID: string, n: number) =>
  ({ type: `test.${n}`, data: { sessionID, n } }) as unknown as UiHostEvent;

async function setup() {
  const events = source();
  const host = {
    event: { subscribe: () => events.stream },
    close: () => events.stream.return!(),
  } as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host });
  await Bun.sleep(0);
  return { manager, events };
}

test("routes concurrent sessions and normalized locations without cross-talk", async () => {
  const { manager, events } = await setup();
  const first: UiHostEvent[] = [];
  const second: UiHostEvent[] = [];
  manager.registerEventConsumer({
    sessionId: "one",
    location: "/repo/",
    onEvent: (value) => {
      first.push(value);
    },
  });
  manager.registerEventConsumer({
    sessionId: "two",
    location: "/repo",
    onEvent: (value) => {
      second.push(value);
    },
  });
  events.push(event("one", "/repo", 1));
  events.push(event("two", "/repo", 2));
  events.push(event("one", "/other", 3));
  await Bun.sleep(0);
  expect(first.map((value) => (value as unknown as { data: { n: number } }).data.n)).toEqual([1]);
  expect(second.map((value) => (value as unknown as { data: { n: number } }).data.n)).toEqual([2]);
  await manager.close();
});

test("routes an exact session event when SDK omits its location", async () => {
  const { manager, events } = await setup();
  const received: UiHostEvent[] = [];
  manager.registerEventConsumer({
    sessionId: "one",
    location: "/repo",
    onEvent: (value) => {
      received.push(value);
    },
  });

  events.push(eventWithoutLocation("one", 1));
  await Bun.sleep(0);

  expect(received).toHaveLength(1);
  await manager.close();
});

test("uses generated server.connected and session event envelopes", async () => {
  const { manager, events } = await setup();
  const received: OpenCodeHostEvent[] = [];
  manager.registerEventConsumer({
    sessionId: "one",
    location: "/repo",
    onEvent: (value) => {
      received.push(value);
    },
  });
  events.push({
    id: "connected",
    type: "server.connected",
    data: {},
    location: { directory: "/repo" },
  });
  events.push({
    id: "execution",
    created: 1,
    type: "session.execution.started",
    durable: { aggregateID: "one", seq: 1, version: 1 },
    data: { sessionID: "one" },
  });
  await Bun.sleep(0);
  expect(received).toHaveLength(1);
  expect(received[0]?.type).toBe("session.execution.started");
  await manager.close();
});

test("requires matching location when an SDK event includes it", async () => {
  const { manager, events } = await setup();
  const received: UiHostEvent[] = [];
  manager.registerEventConsumer({
    sessionId: "one",
    location: "/repo",
    onEvent: (value) => {
      received.push(value);
    },
  });

  events.push(event("one", "/repo", 1));
  events.push(event("one", "/other", 2));
  await Bun.sleep(0);

  expect(received).toHaveLength(1);
  expect((received[0] as unknown as { data: { n: number } }).data.n).toBe(1);
  await manager.close();
});

test("rejects a foreign session even when it has the same location", async () => {
  const { manager, events } = await setup();
  const received: UiHostEvent[] = [];
  manager.registerEventConsumer({
    sessionId: "one",
    location: "/repo",
    onEvent: (value) => {
      received.push(value);
    },
  });

  events.push(event("two", "/repo", 1));
  await Bun.sleep(0);

  expect(received).toHaveLength(0);
  await manager.close();
});

test("fails only the slow consumer on overflow and keeps other sessions running", async () => {
  const { manager, events } = await setup();
  const received: number[] = [];
  const other: number[] = [];
  const failures: unknown[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const subscription = manager.registerEventConsumer({
    sessionId: "one",
    queueSize: 2,
    onError: (error) => {
      failures.push(error);
    },
    onEvent: async (value) => {
      received.push((value as unknown as { data: { n: number } }).data.n);
      if (received.length === 1) await blocked;
    },
  });
  manager.registerEventConsumer({
    sessionId: "two",
    queueSize: 2,
    onEvent: (value) => {
      other.push((value as unknown as { data: { n: number } }).data.n);
    },
  });
  events.push(event("one", "/repo", 1));
  events.push(event("one", "/repo", 2));
  events.push(event("one", "/repo", 3));
  events.push(event("one", "/repo", 4));
  events.push(event("two", "/repo", 10));
  events.push(event("two", "/repo", 11));
  await Bun.sleep(0);
  expect(subscription.droppedEvents).toBe(1);
  expect(manager.consumerCountForTesting).toBe(1);
  expect(failures[0]).toBeInstanceOf(UiHostManagerBackendFailureError);
  expect((failures[0] as Error).name).toBe("UiHostManagerEventQueueOverflowError");
  expect((failures[0] as Error).message).not.toContain('"data"');
  release();
  await Bun.sleep(0);
  expect(received).toEqual([1]);
  expect(other).toEqual([10, 11]);
  subscription.unsubscribe();
  events.push(event("one", "/repo", 5));
  await Bun.sleep(0);
  expect(received).toEqual([1]);
  await manager.close();
});

test("creates one SDK event subscription", async () => {
  const events = source();
  let subscriptions = 0;
  const host = {
    event: { subscribe: () => (subscriptions++, events.stream) },
    close: () => events.stream.return!(),
  } as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host });
  manager.registerEventConsumer({ onEvent: () => undefined });
  manager.registerEventConsumer({ onEvent: () => undefined });
  await Bun.sleep(0);
  expect(subscriptions).toBe(1);
  await manager.close();
});

test("fails every active consumer when the event source throws and releases it", async () => {
  let rejectNext!: (error: Error) => void;
  let returned = 0;
  const stream = {
    next: () => new Promise<IteratorResult<UiHostEvent>>((_, reject) => (rejectNext = reject)),
    return: async () => {
      returned += 1;
      return { value: undefined, done: true } as const;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const host = {
    event: { subscribe: () => stream },
    close: async () => undefined,
  } as unknown as UiHost;
  const failures: unknown[] = [];
  const manager = new UiHostManager({ factory: async () => host });
  manager.registerEventConsumer({
    onError: (error) => {
      failures.push(error);
    },
    onEvent: () => undefined,
  });
  manager.registerEventConsumer({
    onError: (error) => {
      failures.push(error);
    },
    onEvent: () => undefined,
  });
  await Bun.sleep(0);
  rejectNext(new Error("stream broke"));
  await Bun.sleep(0);

  expect(failures).toHaveLength(2);
  expect(failures[0]).toBeInstanceOf(UiHostManagerBackendFailureError);
  expect(returned).toBe(1);
  await expect(manager.withHost(async () => "unsafe")).rejects.toBeInstanceOf(
    UiHostManagerBackendFailureError,
  );
  await manager.close();
});

test("treats a clean event stream end as backend failure", async () => {
  let resolveNext!: (result: IteratorResult<UiHostEvent>) => void;
  const stream = {
    next: () => new Promise<IteratorResult<UiHostEvent>>((resolve) => (resolveNext = resolve)),
    return: () => Promise.resolve({ value: undefined, done: true } as const),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const host = {
    event: { subscribe: () => stream },
    close: async () => undefined,
  } as unknown as UiHost;
  let failure: unknown;
  const manager = new UiHostManager({ factory: async () => host });
  manager.registerEventConsumer({
    onError: (error) => {
      failure = error;
    },
    onEvent: () => undefined,
  });
  await Bun.sleep(0);
  resolveNext({ value: undefined, done: true });
  await Bun.sleep(0);
  expect(failure).toBeInstanceOf(UiHostManagerBackendFailureError);
  await manager.close();
});

test("recovers only by constructing a new manager after stream failure", async () => {
  const firstHost = {
    event: {
      subscribe: () => ({
        next: async () => ({ value: undefined, done: true as const }),
        [Symbol.asyncIterator]() {
          return this;
        },
      }),
    },
  } as unknown as UiHost;
  const first = new UiHostManager({ factory: async () => firstHost });
  await Bun.sleep(0);
  await expect(first.withHost(async () => "unsafe")).rejects.toBeInstanceOf(
    UiHostManagerBackendFailureError,
  );

  const secondHost = {} as UiHost;
  const second = new UiHostManager({ factory: async () => secondHost });
  await expect(second.withHost(async (host) => host)).resolves.toBe(secondHost);
  await first.close();
  await second.close();
});
