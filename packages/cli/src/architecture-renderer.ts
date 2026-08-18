import type { PlanInput } from "@software-factory/contracts";

import type { ArchitectureSections } from "./workflow";

const sections = [
  ["intent", "Intent"],
  ["current", "Current Composition"],
  ["target", "Target Layer Composition"],
  ["seams", "Explicit Seams"],
  ["model", "Data Model Changes"],
  ["validation", "Validation"],
  ["flow", "Resulting Request Flow"],
] as const;

function escapeHtml(value: unknown): string {
  return String(value ?? "Unavailable detail")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown): string {
  return escapeHtml(value || "Unavailable detail");
}

function list(items: readonly string[]): string {
  return `<ul>${items.length ? items.map((item) => `<li>${text(item)}</li>`).join("") : "<li>Unavailable detail</li>"}</ul>`;
}

function renderCurrent(data: ArchitectureSections["currentComposition"]): string {
  if (!data) return '<div class="callout muted-callout">Unavailable detail</div>';
  const groups = data.groups.length
    ? data.groups
        .map(
          (group, index) =>
            `${index ? '<div class="arrow" aria-hidden="true">→</div>' : ""}<div class="flow-column ${group.tone}"><div class="flow-title">${text(group.title)}</div>${group.items.length ? group.items.map((item) => `<div class="flow-box"><h3>${text(item.title)}</h3>${item.code ? `<code>${text(item.code)}</code>` : ""}<p>${text(item.detail)}</p></div>`).join("") : '<div class="flow-box">Unavailable detail</div>'}</div>`,
        )
        .join("")
    : '<div class="flow-box">Unavailable detail</div>';
  return `<p class="section-lede">${text(data.summary)}</p><div class="flow" aria-label="Current change architecture">${groups}</div>`;
}

function renderLayers(layers: ArchitectureSections["targetLayers"]): string {
  if (!layers?.length) return '<div class="card span-12">Unavailable detail</div>';
  return layers
    .map(
      (layer, index) =>
        `<article class="card span-4 ${layer.tone}"><h3>${index + 1}. ${text(layer.title)}</h3>${layer.code ? `<p><code>${text(layer.code)}</code></p>` : ""}<p>${text(layer.detail)}</p></article>`,
    )
    .join("");
}

function renderSeams(seams: ArchitectureSections["seams"]): string {
  if (!seams?.length) return '<article class="seam-item">Unavailable detail</article>';
  return seams
    .map(
      (seam) =>
        `<article class="seam-item"><h3>${text(seam.title)}</h3><p>${text(seam.detail)}</p></article>`,
    )
    .join("");
}

function renderModel(data: ArchitectureSections["dataModelChanges"]): string {
  if (!data) return '<div class="callout muted-callout">Unavailable detail</div>';
  const contracts =
    data.requestExample || data.responseExample
      ? `<div class="grid contract-grid">${data.requestExample ? `<div class="span-6"><h3>${text(data.requestLabel || "Request / Before")}</h3><pre><code>${text(data.requestExample)}</code></pre></div>` : ""}${data.responseExample ? `<div class="span-6"><h3>${text(data.responseLabel || "Response / After")}</h3><pre><code>${text(data.responseExample)}</code></pre></div>` : ""}</div>`
      : '<div class="card">Unavailable detail</div>';
  const stages = data.stages.length
    ? `<table><thead><tr><th>Stage</th><th>Responsibility</th><th>Behavior to preserve</th></tr></thead><tbody>${data.stages.map((stage) => `<tr><td>${text(stage.stage)}</td><td>${text(stage.responsibility)}</td><td>${text(stage.preserves)}</td></tr>`).join("")}</tbody></table>`
    : '<div class="card">Unavailable detail</div>';
  const compatibility = data.compatibility
    ? `<div class="route-split"><article class="route-card legacy"><h3>${text(data.compatibility.legacyTitle)}</h3>${list(data.compatibility.legacyItems)}</article><div class="decision">${text(data.compatibility.decision)}</div><article class="route-card new"><h3>${text(data.compatibility.targetTitle)}</h3>${list(data.compatibility.targetItems)}</article></div>`
    : "";
  return `<p class="section-lede">${text(data.summary)}</p>${contracts}${stages}${compatibility}`;
}

function renderValidation(input: PlanInput, data: ArchitectureSections["validation"]): string {
  const groups = data?.groups.length
    ? data.groups
        .map(
          (group) =>
            `<article class="card span-4 test"><h3>${text(group.title)}</h3>${list(group.items)}</article>`,
        )
        .join("")
    : `<article class="card span-12 test"><h3>Acceptance criteria</h3>${list(input.acceptanceCriteria)}</article>`;
  const parity = data?.parityRows.length
    ? `<table><thead><tr><th>Area</th><th>Comparison</th><th>Special handling</th></tr></thead><tbody>${data.parityRows.map((row) => `<tr><td>${text(row.area)}</td><td>${text(row.comparison)}</td><td>${text(row.handling)}</td></tr>`).join("")}</tbody></table>`
    : "";
  const risks = input.risks.length
    ? `<div class="card span-12"><h3>Risks and mitigations</h3><ul>${input.risks.map((risk) => `<li><strong>${text(risk.description)}</strong> ${text(risk.mitigation)}</li>`).join("")}</ul></div>`
    : "";
  return `<p class="section-lede">Verification mode: <strong>${text(input.verificationMode)}</strong>. ${text(input.verificationStrategy)}</p><div class="grid">${groups}${risks}</div>${parity}`;
}

export function renderArchitectureHtml(
  input: PlanInput,
  architecture: ArchitectureSections,
): string {
  const title = text(input.missionTitle);
  const tags = architecture.statusTags.length
    ? architecture.statusTags
        .map(
          (tag) =>
            `<span class="tag ${tag.tone}"><span class="dot"></span>${text(tag.label)}</span>`,
        )
        .join("")
    : '<span class="tag neutral"><span class="dot"></span>Planned change</span>';
  const navigation = sections.map(([id, heading]) => `<a href="#${id}">${heading}</a>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} Architecture</title>
<style>
:root{--bg:#f4f0e6;--paper:#fffdf7;--ink:#17211f;--muted:#65716e;--line:#c9d0c9;--legacy:#b45309;--legacy-soft:#fff1dc;--new:#087f5b;--new-soft:#e3f6ef;--client:#315a8a;--client-soft:#e8f0fa;--test:#6d3fa0;--test-soft:#f1eafa;--code:#10211e}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:linear-gradient(rgba(23,33,31,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(23,33,31,.035) 1px,transparent 1px),var(--bg);background-size:24px 24px;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}a{color:inherit}.shell{width:min(1420px,calc(100% - 32px));margin:0 auto}header{padding:54px 0 34px;border-bottom:2px solid var(--ink)}.eyebrow{margin:0 0 10px;color:var(--new);font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1,h2,h3,p{margin-top:0}h1{max-width:1000px;margin-bottom:16px;font:800 clamp(38px,6vw,76px)/.98 Georgia,serif;letter-spacing:-.045em}h2{margin-bottom:20px;font:800 clamp(27px,3vw,42px)/1.05 Georgia,serif;letter-spacing:-.025em}h3{margin-bottom:8px;font-size:15px;letter-spacing:.06em;text-transform:uppercase}.lede,.section-lede{max-width:900px;color:var(--muted);font-size:18px}.status-row{display:flex;flex-wrap:wrap;gap:8px}.tag{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border:1px solid currentColor;border-radius:999px;background:var(--paper);font-size:12px;font-weight:800}.dot{width:8px;height:8px;border-radius:50%;background:currentColor}.legacy{color:var(--legacy)}.new{color:var(--new)}.client{color:var(--client)}.test{color:var(--test)}.neutral{color:var(--muted)}nav{position:sticky;top:0;z-index:10;border-bottom:1px solid var(--line);background:rgba(244,240,230,.94);backdrop-filter:blur(9px)}nav .shell{display:flex;gap:20px;overflow-x:auto;padding:12px 0}nav a{white-space:nowrap;text-decoration:none;font-size:12px;font-weight:800}main{padding:46px 0 80px}section{margin-bottom:68px;scroll-margin-top:62px}.callout{padding:20px 22px;border-left:5px solid var(--new);background:var(--paper);box-shadow:5px 5px 0 rgba(23,33,31,.11)}.muted-callout{border-color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}.card{padding:20px;border:1px solid var(--line);background:var(--paper);color:var(--ink)}.span-4{grid-column:span 4}.span-6{grid-column:span 6}.span-12{grid-column:span 12}.flow{display:flex;align-items:stretch;gap:8px}.flow-column{display:flex;min-width:0;flex:1;flex-direction:column;gap:12px}.flow-title{padding:10px 14px;border:1px solid currentColor;font-weight:900;text-align:center;text-transform:uppercase}.flow-box{min-height:104px;padding:15px;border:1px solid var(--line);background:var(--paper);color:var(--ink)}.flow-box code{overflow-wrap:anywhere}.arrow{display:grid;place-items:center;color:var(--muted);font-size:30px;font-weight:900}code{padding:2px 5px;border-radius:3px;color:#0a6d50;background:#e5eee9}pre{max-width:100%;margin:0;padding:18px;overflow:auto;border:1px solid #2f4a44;color:#d9eee7;background:var(--code);line-height:1.5}pre code{padding:0;color:inherit;background:none}.contract-grid,table,.route-split{margin:16px 0}table{width:100%;border-collapse:collapse;background:var(--paper)}th,td{padding:13px 14px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:#e8e4da;font-size:12px;text-transform:uppercase}.route-split{display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:stretch}.route-card{padding:22px;border:2px solid currentColor}.route-card.legacy{background:var(--legacy-soft)}.route-card.new{background:var(--new-soft)}.decision{align-self:center;padding:17px 12px;border:2px solid var(--ink);background:var(--ink);color:#fff;font-weight:900;text-align:center;transform:rotate(-2deg)}.seam{position:relative;padding-left:48px}.seam:before{position:absolute;top:0;bottom:0;left:20px;width:2px;content:"";background:var(--ink)}.seam-item{position:relative;margin-bottom:14px;padding:17px 18px;border:1px solid var(--line);background:var(--paper)}.seam-item:before{position:absolute;top:22px;left:-35px;width:13px;height:13px;border:2px solid var(--ink);border-radius:50%;content:"";background:var(--bg)}ul{padding-left:20px}li+li{margin-top:6px}footer{padding:24px 0 42px;border-top:2px solid var(--ink);color:var(--muted);font-size:12px}@media(max-width:900px){.span-4,.span-6{grid-column:span 12}.flow{flex-direction:column}.arrow{min-height:38px;transform:rotate(90deg)}.route-split{grid-template-columns:1fr}.decision{transform:none}section{min-width:0;overflow-x:auto}table{min-width:720px}pre{white-space:pre-wrap;overflow-wrap:anywhere}}@media print{nav{display:none}body{background:#fff}.shell{width:100%;padding:0 18px}section{break-inside:avoid}}
</style></head><body><header><div class="shell"><p class="eyebrow">Technical change proposal</p><h1>${title}</h1><p class="lede">${text(architecture.lede || input.intent)}</p><div class="status-row">${tags}</div></div></header><nav aria-label="Document sections"><div class="shell">${navigation}</div></nav><main class="shell"><section id="intent"><h2>Intent</h2><div class="callout"><strong>${text(input.intent)}</strong><p>${text(input.changePlan)}</p></div></section><section id="current"><h2>Current Composition</h2>${renderCurrent(architecture.currentComposition)}</section><section id="target"><h2>Target Layer Composition</h2><div class="grid">${renderLayers(architecture.targetLayers)}</div></section><section id="seams"><h2>Explicit Seams</h2><div class="seam">${renderSeams(architecture.seams)}</div></section><section id="model"><h2>Data Model Changes</h2>${renderModel(architecture.dataModelChanges)}</section><section id="validation"><h2>Validation</h2>${renderValidation(input, architecture.validation)}</section><section id="flow"><h2>Resulting Request Flow</h2><pre><code>${text(architecture.resultingRequestFlow)}</code></pre></section></main><footer><div class="shell">${title}. Standalone architecture document; no external scripts, fonts, or network dependencies.</div></footer></body></html>`;
}

export { escapeHtml, sections };
