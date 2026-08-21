---
name: visualize-change
description: Author a precise standalone HTML technical architecture brief for a planned change.
---

# Visualize Change

After repository exploration, directly author one standalone HTML document. In Factory planner runs write only the exact run-context path `.factory/architecture/<run-id>.html`; in normal standalone use write to the caller-specified repository-relative `.html` path. Never return structured architecture data as a substitute.

## Evidence rule

Use only facts supported by exploration and the proposed plan. Preserve concrete paths, symbols, endpoints, schemas, compatibility switches, data grains, and verification boundaries. Never invent architecture; use the exact string `Unavailable detail` when information was not discovered. Escape all text before inserting it into HTML.

## Document contract

Use this exact section order: Intent; Current Composition; Target Layer Composition; Explicit Seams; Data Model Changes; Validation; Resulting Request Flow. Every required section must be a sibling direct child of `<main>` and its own visually distinct bordered box; never nest one required section inside another. Close every `<pre>`, content wrapper, and `<section>` before opening the next section. Present the wide paper-and-grid technical proposal header, serif display type, monospace body, status tags, sticky anchored navigation, prominent Intent callout, left-to-right grouped current flow, numbered target cards, boundary timeline, request/response or before/after blocks, change pipeline table, compatibility routing when applicable, verification cards, parity/acceptance table, and a preformatted end-to-end tree.

The HTML must be self-contained, responsive, accessible, printable, and reasonably sized (under 1 MB): inline CSS only; no scripts, fonts, images, external URLs, imports, forms, event-handler attributes, iframe/object/embed, or network dependencies. Tables must have horizontal overflow on narrow screens.

## Planning integration

The planner first delegates to `codebase-explorer`, then loads this skill and writes the exact artifact. It returns the complete plan under `plan` and exactly one `artifacts` declaration whose path is `.factory/architecture/<run-id>.html` (kind `architecture`). Factory validates, attaches, persists, and never renders or rewrites HTML. Normal standalone callers may specify another safe repository-relative `.html` output path.
