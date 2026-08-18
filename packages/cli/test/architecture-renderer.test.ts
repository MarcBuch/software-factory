import { expect, test } from "bun:test";

import { renderArchitectureHtml, sections } from "../src/architecture-renderer";

const input = {
  missionTitle: "A <danger>",
  intent: "Intent <script>",
  changePlan: "Target",
  risks: [{ description: "Risk &", mitigation: 'Mitigate "it"' }],
  alternatives: [],
  acceptanceCriteria: ["Works"],
  verificationStrategy: "Check",
  verificationMode: "standard" as const,
};

test("architecture renderer is deterministic, ordered, escaped, and self-contained", () => {
  const html = renderArchitectureHtml(input);
  expect(renderArchitectureHtml(input)).toBe(html);
  expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1])).toEqual([...sections]);
  expect(html).toContain("A &lt;danger&gt;");
  expect(html).toContain("Risk &amp;");
  expect(html).toContain("Mitigate &quot;it&quot;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("@media(max-width:600px)");
  expect(html).toContain("@media print");
  expect(html).not.toContain("https://");
});

test("architecture renderer uses fallback and accepts explicit section details", () => {
  const fallback = renderArchitectureHtml(input);
  for (const heading of [
    "Current Composition",
    "Explicit Seams",
    "Data Model Changes",
    "Resulting Request Flow",
  ]) {
    expect(fallback).toContain(`<h2>${heading}</h2><div class="card"><p>Unavailable detail</p>`);
  }
  const supplied = renderArchitectureHtml(input, {
    "Current Composition": "Current <layer>",
    "Explicit Seams": "Seam & boundary",
    "Data Model Changes": "Model change",
    "Resulting Request Flow": "Flow",
  });
  expect(supplied).toContain("Current &lt;layer&gt;");
  expect(supplied).toContain("Seam &amp; boundary");
  expect(supplied).toContain("Model change");
  expect(supplied).toContain("Flow");
});
