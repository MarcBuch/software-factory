import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { routeTree } from "../routeTree.gen";

const mockPlans = [
  {
    id: "pln_one",
    missionTitle: "First plan",
    verificationMode: "standard",
    milestones: [{ key: "m1", title: "Build" }],
    revision: 1,
    status: "approved",
    sections: {
      context: "Context",
      intent: "First intent",
      approach: "Approach",
      executionDesign: "Design",
      implementationDetails: "Details",
      alternatives: [],
      risks: [],
      acceptance: ["Accept"],
    },
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    approvedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "pln_two",
    missionTitle: "Second plan",
    verificationMode: "fast",
    milestones: [],
    revision: 1,
    status: "draft",
    sections: {
      context: "Context",
      intent: "Second intent",
      approach: "Approach",
      executionDesign: "Design",
      implementationDetails: "Details",
      alternatives: [],
      risks: [],
      acceptance: ["Accept"],
    },
    steps: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
] as const;

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
  window.history.replaceState({}, "", initialEntry);
  vi.stubGlobal("EventSource", MockEventSource);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") return Promise.resolve(jsonResponse({ accepted: true, run }));
    if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ deleted: true }));
    if (path.includes("/trace"))
      return Promise.resolve(
        jsonResponse({ runId: "run-1", events: [], hasMore: false, summary, publicRun: run }),
      );
    if (path.endsWith("/api/plans")) return Promise.resolve(jsonResponse(mockPlans));
    return Promise.resolve(jsonResponse({ runs: [run] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const history = createMemoryHistory({ initialEntries: [initialEntry] });
  const router = createRouter({ routeTree, history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { fetchMock, router, queryClient };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("router shell", () => {
  test("redirects the root, marks navigation, and preserves detail history", async () => {
    const { router, queryClient } = setup("/");
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(
      screen.getByText("Durable plan revisions, milestones, and execution intent in one place."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /workspace/i })).toHaveAttribute("data-active", "true");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/events");
    fireEvent.click(screen.getByRole("link", { name: /^runs$/i }));
    expect(await screen.findByRole("heading", { name: "Session traces" })).toBeInTheDocument();
    expect(screen.getByText("WORKFLOW")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /inspect the repository/i }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/runs/run-1"));
    expect(await screen.findByText("run-1")).toBeInTheDocument();
    router.history.back();
    await waitFor(() => expect(router.history.location.pathname).toBe("/runs"));
    rendered.unmount();
    expect(MockEventSource.instances[0].closed).toBe(true);
  });

  test("routes launch and delete actions", async () => {
    const { router, fetchMock, queryClient } = setup("/runs");
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
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
    const { router, fetchMock, queryClient } = setup("/runs/missing");
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).includes("/trace")
        ? Promise.resolve(jsonResponse({ error: "missing" }, 404))
        : Promise.resolve(jsonResponse({ runs: [] })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Run unavailable" })).toBeInTheDocument();
  });

  test("renders workspace plans and updates the selected plan detail", async () => {
    const { router, queryClient } = setup("/workspace");
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Selected" })).toBeInTheDocument();
    const detail = screen.getByRole("region", { name: mockPlans[0].missionTitle });
    expect(
      within(detail).getByRole("heading", { name: mockPlans[0].missionTitle }),
    ).toBeInTheDocument();
    expect(within(detail).getByText(mockPlans[0].sections.intent)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View plan" }));

    expect(await within(detail).findByText(mockPlans[1].sections.intent)).toBeInTheDocument();
    expect(within(detail).queryByText(mockPlans[0].sections.intent)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Selected" })).toBeInTheDocument();
  });

  test.each([
    ["empty", "No plan revisions yet"],
    ["error", "Plans could not be loaded"],
  ] as const)("renders the API-driven workspace %s state", async (state, expected) => {
    const { router, fetchMock, queryClient } = setup("/workspace");
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith("/api/plans")
        ? state === "empty"
          ? Promise.resolve(jsonResponse([]))
          : Promise.resolve(jsonResponse({ error: "unavailable" }, 503))
        : Promise.resolve(jsonResponse({ runs: [run] })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  test("renders an error for malformed successful plans data", async () => {
    const { router, fetchMock, queryClient } = setup("/workspace");
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith("/api/plans")
        ? Promise.resolve(
            jsonResponse([
              { ...mockPlans[0], sections: { ...mockPlans[0].sections, risks: "invalid" } },
            ]),
          )
        : Promise.resolve(jsonResponse({ runs: [run] })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Plans could not be loaded")).toBeInTheDocument();
  });
});
