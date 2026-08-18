import type { PlanInput } from "@software-factory/contracts";

const sections = [
  "Intent",
  "Current Composition",
  "Target Layer Composition",
  "Explicit Seams",
  "Data Model Changes",
  "Validation",
  "Resulting Request Flow",
] as const;
export type ArchitectureSectionInput = Partial<Record<(typeof sections)[number], string>>;

function escapeHtml(value: unknown): string {
  return String(value ?? "Unavailable")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown): string {
  return escapeHtml(value || "Unavailable detail");
}

function list(items: readonly unknown[]): string {
  return `<ul>${items.length ? items.map((item) => `<li>${text(item)}</li>`).join("") : "<li>Unavailable detail</li>"}</ul>`;
}

export function renderArchitectureHtml(
  input: PlanInput,
  details: ArchitectureSectionInput = {},
): string {
  const title = text(input.missionTitle);
  const intent = text(input.intent);
  const plan = text(input.changePlan);
  const detail = (heading: (typeof sections)[number]) => text(details[heading]);
  const risks = input.risks.map(
    (risk) => `<li>${text(risk.description)} — mitigation: ${text(risk.mitigation)}</li>`,
  );
  const criteria = input.acceptanceCriteria;
  const sectionsHtml = [
    ["Intent", `<p>${intent}</p>`],
    ["Current Composition", `<p>${detail("Current Composition")}</p>`],
    ["Target Layer Composition", `<p>${plan}</p>`],
    ["Explicit Seams", `<p>${detail("Explicit Seams")}</p>`],
    ["Data Model Changes", `<p>${detail("Data Model Changes")}</p>`],
    [
      "Validation",
      `<p>Verification mode: <strong>${text(input.verificationMode)}</strong></p><p>${text(input.verificationStrategy)}</p>${list(criteria)}${risks.length ? `<h3>Risks</h3><ul>${risks.join("")}</ul>` : ""}`,
    ],
    ["Resulting Request Flow", `<p>${detail("Resulting Request Flow")}</p>`],
  ] as const;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Architecture</title>
<style>
:root{--ink:#17211f;--muted:#65716e;--paper:#fffdf7;--bg:#f4f0e6;--line:#c9d0c9;--accent:#087f5b}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--bg);font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.shell{width:min(1100px,calc(100% - 32px));margin:auto}header{padding:48px 0 30px;border-bottom:2px solid var(--ink)}.eyebrow{color:var(--accent);font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1,h2{font-family:Georgia,serif;letter-spacing:-.03em}h1{font-size:clamp(34px,6vw,68px);line-height:1;margin:12px 0}h2{font-size:clamp(25px,4vw,40px);margin:0 0 14px}main{padding:28px 0}section{break-inside:avoid;border-top:1px solid var(--line);padding:28px 0}section:first-child{border-top:0}.card{background:var(--paper);border:1px solid var(--line);padding:20px}p{max-width:80ch}li{margin:.45em 0}@media(max-width:600px){.shell{width:min(100% - 20px,1100px)}header{padding-top:28px}.card{padding:15px}}@media print{body{background:#fff}.shell{width:100%}header{padding:18px 0}section{padding:16px 0}.card{border-color:#999}a{color:inherit}}
</style></head><body><div class="shell"><header><div class="eyebrow">Architecture brief</div><h1>${title}</h1><p>Deterministic planning composition for Factory integration.</p></header><main>${sectionsHtml.map(([heading, body]) => `<section><h2>${heading}</h2><div class="card">${body}</div></section>`).join("")}</main></div></body></html>`;
}

export { escapeHtml, sections };
