import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("timeline motion accessibility", () => {
  test("disables active bar animation when reduced motion is preferred", () => {
    expect(styles).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.bar-active\s*\{[\s\S]*?animation:\s*none;/,
    );
  });

  test("keeps the timeline horizontally navigable at narrow widths", () => {
    expect(styles).toMatch(/\.gantt\s*\{[\s\S]*?overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.agent\s*\{[\s\S]*?min-width:\s*620px;/);
  });

  test("uses a wide timeline grid with readable labels and status", () => {
    expect(styles).toMatch(
      /\.agent\s*\{[\s\S]*?grid-template-columns:\s*minmax\(110px,\s*240px\)\s+minmax\(320px,\s*1fr\)\s+minmax\(140px,\s*auto\);/,
    );
    expect(styles).toMatch(/\.agent-status\s*\{[\s\S]*?white-space:\s*nowrap;/);
    expect(styles).toMatch(/\.agent-dates\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/);
  });
});
