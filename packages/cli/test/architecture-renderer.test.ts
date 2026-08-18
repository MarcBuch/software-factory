import { expect, test } from "bun:test";

import { renderArchitectureHtml, sections } from "../src/architecture-renderer";

const input = {
  missionTitle: "A <danger>",
  intent: "Consolidate <script> calls while preserving compatibility",
  changePlan: "Introduce a typed boundary",
  risks: [{ description: "Risk &", mitigation: 'Mitigate "it"' }],
  alternatives: [],
  acceptanceCriteria: ["Works"],
  verificationStrategy: "Check",
  verificationMode: "standard" as const,
};

const architecture = {
  lede: "Three calls become one boundary",
  statusTags: [{ label: "New <path>", tone: "new" as const }],
  currentComposition: {
    summary: "Current & distributed",
    groups: [
      {
        title: "Client",
        tone: "client" as const,
        items: [{ title: "Widget", detail: "Renders KPIs", code: "Widget.tsx" }],
      },
      {
        title: "Backend",
        tone: "legacy" as const,
        items: [{ title: "Three routes", detail: "Separate requests" }],
      },
    ],
  },
  targetLayers: [
    { title: "Transport", detail: "One request", code: "useQuery", tone: "new" as const },
  ],
  seams: [{ title: "Compatibility", detail: "Authoritative mode switch" }],
  dataModelChanges: {
    summary: "Typed contract",
    requestLabel: "Request",
    requestExample: '{ "plan": "<id>" }',
    responseLabel: "Response",
    responseExample: '{ "overview": [] }',
    stages: [{ stage: "Validation", responsibility: "Parse input", preserves: "Errors" }],
    compatibility: {
      decision: "mode",
      legacyTitle: "Existing path",
      legacyItems: ["Three calls"],
      targetTitle: "New path",
      targetItems: ["One call"],
    },
  },
  validation: {
    groups: [{ title: "Contract tests", items: ["Request shape"] }],
    parityRows: [{ area: "Output", comparison: "All fields", handling: "Null masks" }],
  },
  resultingRequestFlow: "Widget\n  -> query\n    -> service",
};

test("architecture renderer matches the structured standalone visual contract", () => {
  const html = renderArchitectureHtml(input, architecture);
  expect(renderArchitectureHtml(input, architecture)).toBe(html);
  expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1])).toEqual(
    sections.map(([, heading]) => heading),
  );
  expect(html).toContain('<nav aria-label="Document sections">');
  expect(html).toContain('class="flow"');
  expect(html).toContain('class="seam"');
  expect(html).toContain('class="route-split"');
  expect(html).toContain("Behavior to preserve");
  expect(html).toContain("Special handling");
  expect(html).toContain("Widget\n  -&gt; query");
  expect(html).toContain("New &lt;path&gt;");
  expect(html).toContain("Current &amp; distributed");
  expect(html).toContain("&lt;id&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("@media(max-width:900px)");
  expect(html).toContain("@media print");
  expect(html).not.toContain("https://");
});

test("architecture renderer uses exact fallbacks without inventing details", () => {
  const html = renderArchitectureHtml(input, {
    lede: "Unavailable detail",
    statusTags: [],
    currentComposition: { summary: "Unavailable detail", groups: [] },
    targetLayers: [],
    seams: [],
    dataModelChanges: { summary: "Unavailable detail", stages: [] },
    validation: { groups: [], parityRows: [] },
    resultingRequestFlow: "Unavailable detail",
  });
  expect(html.match(/Unavailable detail/g)?.length).toBeGreaterThanOrEqual(5);
  expect(html).toContain('<section id="current"><h2>Current Composition</h2>');
  expect(html).toContain('<section id="model"><h2>Data Model Changes</h2>');
  expect(html).toContain(
    '<section id="flow"><h2>Resulting Request Flow</h2><pre><code>Unavailable detail</code>',
  );
});
