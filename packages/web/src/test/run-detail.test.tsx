import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Detail } from "../components/runs/run-detail";

const run = {
  id: "run-1",
  status: "running" as const,
  startedAt: "2026-01-01T00:00:00.000Z",
  metadata: { request: "Review timeline" },
};

const agents = [
  { name: "scout", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null },
  {
    name: "builder",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:03.000Z",
  },
];

afterEach(() => {
  document.body.replaceChildren();
});

describe("run detail timeline", () => {
  test("exposes agent labels and statuses as accessible buttons", () => {
    render(
      <Detail
        run={run}
        trace={[]}
        agents={agents}
        onBack={vi.fn<() => void>()}
        onMore={vi.fn<() => void>()}
        hasMore={false}
        deleting={false}
        onDelete={vi.fn<() => void>()}
      />,
    );

    const scout = screen.getByRole("button", { name: /scout.*0 events.*running/i });
    const builder = screen.getByRole("button", { name: /builder.*0 events.*finished/i });
    expect(scout.tagName).toBe("BUTTON");
    expect(builder.tagName).toBe("BUTTON");
    expect(scout.querySelector(".bar-active")).not.toBeNull();
    expect(builder.querySelector(".bar-completed")).not.toBeNull();
  });

  test("renders the scrollable timeline viewport and completed dates", () => {
    render(
      <Detail
        run={run}
        trace={[]}
        agents={agents}
        onBack={vi.fn<() => void>()}
        onMore={vi.fn<() => void>()}
        hasMore={false}
        deleting={false}
        onDelete={vi.fn<() => void>()}
      />,
    );

    const viewport = screen.getByRole("region", { name: "Agent timeline" });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 660 },
    });
    expect(viewport).toHaveAttribute("tabindex", "0");
    expect(viewport).toHaveAttribute("aria-describedby", "gantt-instructions");
    viewport.focus();
    expect(document.activeElement).toBe(viewport);
    expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
    expect(screen.getByText(/Jan 1.*– Jan 1/)).toBeVisible();
  });

  test("renders without horizontal overflow for a wide viewport", () => {
    render(
      <Detail
        run={run}
        trace={[]}
        agents={[]}
        onBack={vi.fn<() => void>()}
        onMore={vi.fn<() => void>()}
        hasMore={false}
        deleting={false}
        onDelete={vi.fn<() => void>()}
      />,
    );

    const viewport = screen.getByRole("region", { name: "Agent timeline" });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1024 },
      scrollWidth: { configurable: true, value: 1024 },
    });
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  });

  test("marks the selected agent active and filters its events", () => {
    render(
      <Detail
        run={run}
        trace={[
          {
            id: 1,
            type: "model_step",
            at: "2026-01-01T00:00:02.000Z",
            agentName: "builder",
          },
        ]}
        agents={agents}
        onBack={vi.fn<() => void>()}
        onMore={vi.fn<() => void>()}
        hasMore={false}
        deleting={false}
        onDelete={vi.fn<() => void>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /builder.*1 events.*finished/i }));
    expect(screen.getByRole("heading", { name: "builder events" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /builder.*1 events.*finished/i })).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    expect(screen.queryByRole("heading", { name: "All events" })).not.toBeInTheDocument();
  });
});
