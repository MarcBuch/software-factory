import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { routeTree } from "../routeTree.gen";

const run = {
  id: "run-1",
  status: "succeeded",
  metadata: { request: "Inspect the repository" },
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
};
const summary = {
  usage: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
  cost: 0.01,
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener() {}
  close() {
    this.closed = true;
  }
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(initialEntry = "/runs") {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") return Promise.resolve(jsonResponse({ accepted: true, run }));
    if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ deleted: true }));
    if (path.includes("/trace"))
      return Promise.resolve(
        jsonResponse({ runId: "run-1", events: [], hasMore: false, summary, publicRun: run }),
      );
    return Promise.resolve(jsonResponse({ runs: [run] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({ routeTree, history });
  return { fetchMock, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("router shell", () => {
  test("redirects the root, marks navigation, and preserves detail history", async () => {
    const { router } = setup("/");
    const rendered = render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /workspace/i })).toHaveAttribute("data-active", "true");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/events");
    fireEvent.click(screen.getByRole("link", { name: /^runs$/i }));
    expect(await screen.findByRole("heading", { name: "Session traces" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /inspect the repository/i }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/runs/run-1"));
    expect(await screen.findByText("run-1")).toBeInTheDocument();
    router.history.back();
    await waitFor(() => expect(router.history.location.pathname).toBe("/runs"));
    rendered.unmount();
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  test("routes launch and delete actions", async () => {
    const { router, fetchMock } = setup("/runs");
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Session traces" });
    fireEvent.change(screen.getByRole("textbox", { name: "Workflow request" }), {
      target: { value: "Launch this workflow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Launch session" }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/runs/run-1"));
    expect(await screen.findByRole("button", { name: /delete session/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /delete session/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete session" }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/runs"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/run-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("renders an unavailable detail", async () => {
    const { router, fetchMock } = setup("/runs/missing");
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).includes("/trace")
        ? Promise.resolve(jsonResponse({ error: "missing" }, 404))
        : Promise.resolve(jsonResponse({ runs: [] })),
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Run unavailable" })).toBeInTheDocument();
  });
});
