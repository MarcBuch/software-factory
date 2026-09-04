import { expect, test } from "bun:test";

import {
  UiHostManager,
  type UiHost,
  UiHostManagerBackendFailureError,
  UiHostManagerClosedError,
  type UiHostFactory,
} from "../src/ui-host-manager";

const fakeHost = () => {
  let closeCount = 0;
  const host = {
    close: async () => {
      closeCount += 1;
    },
  } as unknown as UiHost;
  return {
    host,
    get closeCount() {
      return closeCount;
    },
  };
};

test("creates one client and never stops it for repeated shutdown calls", async () => {
  let createCount = 0;
  const fake = fakeHost();
  const factory: UiHostFactory = async () => {
    createCount += 1;
    return fake.host;
  };

  const manager = new UiHostManager({ factory });
  await Promise.all([
    manager.withHost(async (host) => expect(host).toBe(fake.host)),
    manager.withHost(async (host) => expect(host).toBe(fake.host)),
  ]);
  await Promise.all([manager.close(), manager.close(), manager.close()]);

  expect(createCount).toBe(1);
  expect(fake.closeCount).toBe(0);
});

test("ensures and health-checks one service client for repeated work", async () => {
  let ensureCount = 0;
  let clientCount = 0;
  let predicate!: (version: string) => boolean;
  const endpoint = { url: "http://127.0.0.1:4096" };
  const client = { health: { get: async () => ({ healthy: true }) } };
  const manager = new UiHostManager({
    ensure: async (options) => {
      ensureCount += 1;
      predicate = options.version;
      expect(options.command).toEqual(["opencode2", "serve", "--service"]);
      return endpoint;
    },
    clientFactory: (received) => {
      clientCount += 1;
      expect(received).toBe(endpoint);
      return client;
    },
  });

  await Promise.all([
    manager.withHost(async (host) => expect(host).toBe(client)),
    manager.withHost(async (host) => expect(host).toBe(client)),
  ]);
  expect(ensureCount).toBe(1);
  expect(clientCount).toBe(1);
  expect(predicate("2.0.0")).toBe(true);
  expect(predicate("1.0.0")).toBe(false);
  await manager.close();
});

test("rejects new work as soon as shutdown begins", async () => {
  let resolveHost!: (host: UiHost) => void;
  const hostPromise = new Promise<UiHost>((resolve) => {
    resolveHost = resolve;
  });
  const manager = new UiHostManager({ factory: async () => hostPromise });
  const pending = manager.withHost(async () => "started");

  const closing = manager.close();
  await expect(manager.withHost(async () => "rejected")).rejects.toBeInstanceOf(
    UiHostManagerClosedError,
  );
  const fake = fakeHost();
  resolveHost(fake.host);
  await expect(pending).rejects.toBeInstanceOf(UiHostManagerClosedError);
  await closing;
  expect(fake.closeCount).toBe(0);
});

test("bounds shutdown while service ensure is pending", async () => {
  let ensureStarted!: () => void;
  const ensure = new Promise<never>((_, reject) => {
    ensureStarted = () => reject(new Error("test cleanup"));
  });
  const manager = new UiHostManager({
    shutdownGraceMs: 10,
    ensure: async () => ensure,
  });
  const started = performance.now();
  await manager.close();
  expect(performance.now() - started).toBeLessThan(250);
  ensureStarted();
});

test("does not reject shutdown after host creation fails", async () => {
  const manager = new UiHostManager({
    factory: async () => {
      throw new Error("host creation failed");
    },
  });

  await expect(manager.close()).resolves.toBeUndefined();
});

test("closing a manager leaves a discovered endpoint usable", async () => {
  let healthCalls = 0;
  const client = { health: { get: async () => ({ healthy: ++healthCalls > 0 }) } };
  const manager = new UiHostManager({
    ensure: async () => ({ url: "http://127.0.0.1:4096" }),
    clientFactory: () => client,
  });
  await manager.withHost(async (received) => expect(received).toBe(client));
  await manager.close();
  await expect(client.health.get()).resolves.toEqual({ healthy: true });
  expect(healthCalls).toBe(2);
});

test("does not permit reuse after manager close", async () => {
  const host = {} as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host });

  await expect(manager.close()).resolves.toBeUndefined();
  await expect(manager.withHost(async () => "unsafe")).rejects.toBeInstanceOf(
    UiHostManagerClosedError,
  );
  await expect(manager.close()).resolves.toBeUndefined();
});

test("bounds readiness when a service never emits server.connected", async () => {
  const iterator: AsyncIterator<never> = {
    next: () => new Promise<IteratorResult<never>>(() => {}),
    return: async () => ({ value: undefined, done: true }),
  };
  const host = {
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) },
  } as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host, connectedTimeoutMs: 10 });

  await expect(manager.withHost(async () => "unreachable")).rejects.toBeInstanceOf(
    UiHostManagerBackendFailureError,
  );
  await manager.close();
});

test("does not poison the manager when an individual request fails", async () => {
  const host = {} as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host });
  const requestError = new Error("request failed");

  await expect(manager.withHost(async () => Promise.reject(requestError))).rejects.toBe(
    requestError,
  );
  await expect(manager.withHost(async () => "recovered")).resolves.toBe("recovered");
  await manager.close();
});

test("returns the iterator rather than the async iterable wrapper", async () => {
  let nextStarted!: () => void;
  const nextReady = new Promise<void>((resolve) => {
    nextStarted = resolve;
  });
  let resolveNext!: (result: IteratorResult<never>) => void;
  let iteratorReturns = 0;
  let wrapperReturns = 0;
  const iterator: AsyncIterator<never> = {
    next: () => {
      nextStarted();
      return new Promise<IteratorResult<never>>((resolve) => {
        resolveNext = resolve;
      });
    },
    return: () => {
      iteratorReturns += 1;
      resolveNext({ value: undefined, done: true });
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  const stream = {
    [Symbol.asyncIterator]: () => iterator,
    return: () => {
      wrapperReturns += 1;
      return Promise.resolve({ value: undefined, done: true });
    },
  };
  const host = {
    event: { subscribe: () => stream },
    close: async () => {},
  } as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host });

  await nextReady;
  await manager.close();
  await Bun.sleep(0);

  expect(iteratorReturns).toBe(1);
  expect(wrapperReturns).toBe(0);
});

test("does not let a rejecting iterator return prevent shutdown", async () => {
  let resolveNext!: (result: IteratorResult<never>) => void;
  const returnError = new Error("iterator return failed");
  let iteratorReturns = 0;
  const iterator: AsyncIterator<never> = {
    next: () =>
      new Promise<IteratorResult<never>>((resolve) => {
        resolveNext = resolve;
      }),
    return: () => {
      iteratorReturns += 1;
      resolveNext({ value: undefined, done: true });
      return Promise.reject(returnError);
    },
  };
  const host = {
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) },
    close: async () => {},
  } as unknown as UiHost;
  const manager = new UiHostManager({ factory: async () => host });

  await Bun.sleep(0);
  await expect(manager.close()).resolves.toBeUndefined();
  await Bun.sleep(0);
  expect(iteratorReturns).toBe(1);
});
