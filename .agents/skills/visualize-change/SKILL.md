---
name: visualize-change
description: Visualize a planned software change as a precise, standalone technical architecture brief. Use after repository exploration when a plan needs an HTML change artifact.
---

# Visualize Change

Use this skill after repository exploration to turn discovered architecture and a proposed change into structured visualization data. The Factory workflow renders and writes the HTML; this skill must not create files, run commands, or modify the repository.

## Evidence Rule

Use only facts supported by repository exploration and the proposed plan. Preserve concrete file paths, symbols, endpoints, schemas, compatibility switches, data grains, and verification boundaries. Never invent architecture. Use the exact string `Unavailable detail` for information that was not discovered.

## Document Contract

The rendered document must use this generic technical-change template:

- A wide paper-and-grid canvas with a technical proposal header, serif display type, monospace body, color-coded status tags, and no external assets.
- Sticky section navigation with anchors.
- A prominent Intent decision callout.
- Current Composition as a left-to-right flow of grouped components and arrows.
- Target Layer Composition as numbered responsibility cards.
- Explicit Seams as a vertical boundary timeline.
- Data Model Changes with request/response or before/after code blocks, a change pipeline table, and compatibility routing where applicable.
- Validation as distinct verification cards plus a parity or acceptance table where applicable.
- Resulting Request Flow as a preformatted end-to-end tree.
- Responsive layouts, accessible labels, horizontal overflow for tables, and print styles.
- Inline CSS only. No scripts, fonts, images, external URLs, or network dependencies.

The document always presents these sections in this exact order:

1. Intent
2. Current Composition
3. Target Layer Composition
4. Explicit Seams
5. Data Model Changes
6. Validation
7. Resulting Request Flow

## Structured Result

Return visualization data to the planning agent under `architecture`. Do not return HTML. Use this shape and omit no required arrays; use empty arrays when exploration found no entries:

```json
{
  "lede": "Concise explanation of the change and preserved behavior",
  "statusTags": [{ "label": "New: consolidated request", "tone": "new" }],
  "currentComposition": {
    "summary": "Known current-state summary or Unavailable detail",
    "groups": [
      {
        "title": "Frontend",
        "tone": "client",
        "items": [{ "title": "Widget", "detail": "Responsibility", "code": "path/or/symbol" }]
      }
    ]
  },
  "targetLayers": [
    {
      "title": "Presentation",
      "detail": "Responsibility and preserved behavior",
      "code": "Symbol",
      "tone": "client"
    }
  ],
  "seams": [{ "title": "Compatibility seam", "detail": "Exact boundary and invariant" }],
  "dataModelChanges": {
    "summary": "Schema or contract impact",
    "requestLabel": "Request",
    "requestExample": "Typed request, schema, or before shape",
    "responseLabel": "Response",
    "responseExample": "Typed response, schema, or after shape",
    "stages": [
      { "stage": "Validation", "responsibility": "What changes", "preserves": "Invariant" }
    ],
    "compatibility": {
      "decision": "Authoritative switch",
      "legacyTitle": "Existing path",
      "legacyItems": ["Preserved behavior"],
      "targetTitle": "New path",
      "targetItems": ["New behavior"]
    }
  },
  "validation": {
    "groups": [{ "title": "Service tests", "items": ["High-value proof"] }],
    "parityRows": [
      { "area": "Contract", "comparison": "Expected evidence", "handling": "Special case" }
    ]
  },
  "resultingRequestFlow": "Component\n  -> boundary\n    -> service"
}
```

Allowed tones are `legacy`, `new`, `client`, `test`, and `neutral`. Keep labels short and details specific. Prefer code identifiers and concrete boundaries over generic prose.

## Planning Integration

For the Factory Planner workflow:

1. The planning agent delegates repository exploration to `codebase-explorer`.
2. It loads this skill and applies this contract to the exploration findings and proposed plan.
3. It returns the complete plan under `plan`, where `changePlan` remains required and optional non-empty `changePlanSteps` overrides it for the visualization; each entry is one ordered step. Return this skill's structured data under `architecture` in the marked Factory JSON result. The architecture contract remains unchanged.
4. Factory renders `.factory/architecture/<run-id>.html` before draft creation and attaches it through `externalArtifacts`.

For interactive `plan-mission`, preserve approval-first behavior. Do not create an artifact until the user approves the plan.
