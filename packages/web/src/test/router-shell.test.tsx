import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { routeTree } from "../routeTree.gen";

const mockPlans = [
  {
    id: "pln_one",
    missionTitle: "First plan",
    intent: "First intent",
    changePlan: "Change plan",
    verificationStrategy: "Verify it",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["Accept"],
    revision: 1,
    status: "approved",
    verificationMode: "standard",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    approvedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "pln_two",
    missionTitle: "Second plan",
    intent: "Second intent",
    changePlan: "Change plan",
    verificationStrategy: "Verify it",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["Accept"],
    revision: 1,
    status: "draft",
    verificationMode: "fast",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    id: "pln_three",
    missionTitle: "Third plan",
    intent: "Third intent",
    changePlan: "Change plan",
    verificationStrategy: "Verify it",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["Accept"],
    revision: 1,
    status: "draft",
    verificationMode: "fast",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-04T00:00:00.000Z",
  },
  {
    id: "pln_four",
    missionTitle: "Fourth plan",
    intent: "Fourth intent",
    changePlan: "Change plan",
    verificationStrategy: "Verify it",
    risks: [],
    alternatives: [],
    acceptanceCriteria: ["Accept"],
    revision: 1,
    status: "approved",
    verificationMode: "standard",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    approvedAt: "2026-01-03T00:00:00.000Z",
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
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ accepted: true, run }));
      if (init?.method === "DELETE" && path.includes("/api/plans/"))
        return Promise.resolve(
          jsonResponse({
            deleted: true,
            planId: "pln_one",
            revisionsDeleted: 1,
            missionsDeleted: 2,
          }),
        );
      if (init?.method === "DELETE")
        return Promise.resolve(jsonResponse({ deleted: true, runId: "run-1" }));
      if (path.includes("/trace"))
        return Promise.resolve(
          jsonResponse({ runId: "run-1", events: [], hasMore: false, summary, publicRun: run }),
        );
      if (path.endsWith("/api/plans")) return Promise.resolve(jsonResponse(mockPlans));
      return Promise.resolve(jsonResponse({ runs: [run] }));
    },
  );
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
      screen.getByText(
        "Durable plan revisions, change intent, and verification strategy in one place.",
      ),
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

  test("navigates to a dedicated plan detail and preserves browser back", async () => {
    const { router, queryClient } = setup("/workspace");
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Plan revisions" })).toBeInTheDocument();
    const tableScroller = screen.getByRole("region", { name: "Scrollable plan revisions" });
    expect(tableScroller).toBeInTheDocument();
    expect(tableScroller).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    const firstPlanRow = screen.getByRole("row", { name: /first plan/i });
    const secondPlanRow = screen.getByRole("row", { name: /second plan/i });
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]!.textContent),
    ).toEqual([
      expect.stringContaining("Third plan"),
      expect.stringContaining("Second plan"),
      expect.stringContaining("Fourth plan"),
      expect.stringContaining("First plan"),
    ]);
    const updatedDate = new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(mockPlans[0].updatedAt));
    expect(within(firstPlanRow).getByText("First plan")).toBeInTheDocument();
    expect(within(firstPlanRow).getByText("pln_one")).toBeInTheDocument();
    expect(within(firstPlanRow).getByText("approved")).toBeInTheDocument();
    expect(within(firstPlanRow).getByText(updatedDate)).toBeInTheDocument();
    expect(within(secondPlanRow).getByText("draft")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View plan: First plan" }));

    await waitFor(() => expect(router.history.location.pathname).toBe("/workspace/pln_one"));
    expect(
      await screen.findByRole("heading", { name: mockPlans[0].missionTitle }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Plan revisions")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /workspace/i })).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/workspace"));
  });

  test("preserves browser back from a plan detail", async () => {
    const { router, queryClient } = setup("/workspace");
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View plan: First plan" }));
    await waitFor(() => expect(router.history.location.pathname).toBe("/workspace/pln_one"));
    router.history.back();
    await waitFor(() => expect(router.history.location.pathname).toBe("/workspace"));
    expect(await screen.findByRole("heading", { name: "Plan revisions" })).toBeInTheDocument();
  });

  test("renders a direct plan detail route", async () => {
    const { router, queryClient } = setup("/workspace/pln_two");
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: mockPlans[1].missionTitle }),
    ).toBeInTheDocument();
    expect(screen.getByText(mockPlans[1].intent)).toBeInTheDocument();
  });

  test("confirms and deletes a plan before replacing the detail route", async () => {
    const { router, fetchMock, queryClient } = setup("/workspace/pln_one");
    let deleted = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve(
          jsonResponse({
            deleted: true,
            planId: "pln_one",
            revisionsDeleted: 1,
            missionsDeleted: 2,
          }),
        );
      }
      if (path.endsWith("/api/plans"))
        return Promise.resolve(jsonResponse(deleted ? mockPlans.slice(1) : mockPlans));
      return Promise.resolve(jsonResponse({ runs: [run] }));
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { name: mockPlans[0].missionTitle });
    fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "All revisions and linked missions are permanently removed.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));

    await waitFor(() => expect(router.history.location.pathname).toBe("/workspace"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plans/pln_one",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(queryClient.getQueryData<typeof mockPlans>(["plans"])).not.toContainEqual(mockPlans[0]);
  });

  test("announces a pending plan detail without an aria-busy ancestor", async () => {
    const { router, fetchMock, queryClient } = setup("/workspace/pln_two");
    let resolvePlans!: (response: Response) => void;
    const plansResponse = new Promise<Response>((resolve) => {
      resolvePlans = resolve;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith("/api/plans")
        ? plansResponse
        : Promise.resolve(jsonResponse({ runs: [run] })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const status = await screen.findByText("Loading plan");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent("Loading plan");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.closest("[aria-busy='true']")).toBeNull();
    resolvePlans(jsonResponse(mockPlans));
    expect(
      await screen.findByRole("heading", { name: mockPlans[1].missionTitle }),
    ).toBeInTheDocument();
    expect(router.history.location.pathname).toBe("/workspace/pln_two");
  });

  test("renders an unavailable plan detail", async () => {
    const { router, queryClient } = setup("/workspace/missing");
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Plan unavailable" })).toBeInTheDocument();
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

  test("renders the workspace loading state before plans resolve", async () => {
    const { router, fetchMock, queryClient } = setup("/workspace");
    let resolvePlans!: (response: Response) => void;
    const plansResponse = new Promise<Response>((resolve) => {
      resolvePlans = resolve;
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith("/api/plans")
        ? plansResponse
        : Promise.resolve(jsonResponse({ runs: [run] })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText("Loading workspace")).toHaveAttribute("aria-busy", "true");
    resolvePlans(jsonResponse(mockPlans));
    expect(await screen.findByRole("table", { name: "Plan revisions" })).toBeInTheDocument();
  });

  test("renders an error for malformed successful plans data", async () => {
    const { router, fetchMock, queryClient } = setup("/workspace");
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith("/api/plans")
        ? Promise.resolve(jsonResponse([{ ...mockPlans[0], risks: "invalid" }]))
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
