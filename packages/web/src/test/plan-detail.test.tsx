import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { PlanDetail } from "../components/plans/plan-detail";
import type { Plan } from "../data/plans";

test("plan detail links only HTML artifacts to the plan-scoped viewer", () => {
  const plan: Plan = {
    id: "pln_test123",
    missionTitle: "Test mission",
    intent: "Test intent",
    changePlan: "Test change plan",
    risks: [],
    alternatives: [],
    acceptanceCriteria: [],
    verificationStrategy: "Test verification strategy",
    verificationMode: "standard",
    revision: 1,
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    externalArtifacts: [
      { path: ".factory/architecture/brief.html", label: "Architecture brief" },
      { path: "notes.md", label: "Notes" },
    ],
  };

  render(<PlanDetail plan={plan} deleting={false} onDelete={() => {}} />);

  const architectureLink = screen.getByRole("link", {
    name: "View architecture: Architecture brief",
  });
  expect(architectureLink.getAttribute("href")).toBe(
    "/api/plans/pln_test123/artifact?path=.factory%2Farchitecture%2Fbrief.html",
  );
  expect(architectureLink.getAttribute("target")).toBe("_blank");
  expect(architectureLink.getAttribute("rel")).toBe("noopener noreferrer");

  const notes = screen.getByText("Notes");
  expect(notes.closest("a")).toBeNull();
});
