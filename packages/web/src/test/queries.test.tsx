import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { useTrace } from "../data/queries";

const summary = {
  usage: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
  cost: 0.01,
};

function TraceProbe() {
  const query = useTrace("run-1");
  if (query.isPending) return <output>pending</output>;
  if (query.isError) return <output data-testid="error">{query.error.name}</output>;
  return (
    <>
      <button onClick={() => query.fetchNextPage()}>Load more</button>
      <output data-testid="trace">
        {JSON.stringify({ ...query.data?.latest, events: query.data?.events })}
      </output>
    </>
  );
}

function renderTrace(response: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TraceProbe />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trace query", () => {
  test("parses agent lifecycle data without dropping trace metadata", async () => {
    renderTrace({
      runId: "run-1",
      events: [
        {
          id: 1,
          type: "run_started",
          runId: "api",
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: 3,
      hasMore: true,
      summary,
      publicRun: {
        id: "run-1",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        metadata: { request: "Inspect" },
      },
      agents: [
        {
          name: "scout",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
        },
      ],
    });

    const trace = await screen.findByTestId("trace");
    const data = JSON.parse(trace.textContent ?? "{}");
    expect(data.agents).toEqual([
      { name: "scout", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null },
    ]);
    expect(data.events).toHaveLength(1);
    expect(data.nextCursor).toBe(3);
    expect(data.hasMore).toBe(true);
    expect(data.summary).toEqual(summary);
    expect(data.publicRun.id).toBe("run-1");
  });

  test("rejects malformed agent lifecycle data through the query error path", async () => {
    renderTrace({
      runId: "run-1",
      events: [],
      hasMore: false,
      summary,
      agents: [{ name: "scout", startedAt: "not-a-date", finishedAt: null }],
    });

    expect(await screen.findByTestId("error")).toHaveTextContent("ZodError");
  });

  test("preserves publicRun metadata while loading a later trace page", async () => {
    let request = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        request += 1;
        const page =
          request === 1
            ? {
                runId: "run-1",
                events: [],
                nextCursor: 4,
                hasMore: true,
                summary,
                publicRun: {
                  id: "run-1",
                  status: "running",
                  startedAt: "2026-01-01T00:00:00.000Z",
                },
                agents: [
                  { name: "scout", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null },
                ],
              }
            : {
                runId: "run-1",
                events: [
                  { id: 4, type: "run_started", runId: "run-1", at: "2026-01-01T00:00:01.000Z" },
                ],
                hasMore: false,
                summary,
              };
        return Promise.resolve(new Response(JSON.stringify(page)));
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TraceProbe />
      </QueryClientProvider>,
    );

    await screen.findByTestId("trace");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      const data = JSON.parse(screen.getByTestId("trace").textContent ?? "{}");
      expect(data).toMatchObject({ publicRun: { id: "run-1", status: "running" } });
      expect(data.agents).toEqual([
        { name: "scout", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null },
      ]);
      expect(data.events).toHaveLength(1);
    });
    expect(JSON.parse(screen.getByTestId("trace").textContent ?? "{}").events).toHaveLength(1);
  });
});
