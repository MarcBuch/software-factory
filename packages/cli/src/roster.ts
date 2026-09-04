import { AgentResultSchema, AgentRosterEntrySchema, type AgentRosterEntry } from "./workflow";

/** Shared wire protocol for the final agent response. Markers must occupy lines by themselves. */
export const FACTORY_RESULT_START = "---FACTORY_RESULT_JSON---";
export const FACTORY_RESULT_END = "---END_FACTORY_RESULT_JSON---";
export const FactoryFinalResultSchema = AgentResultSchema;

/** Stable, source-controlled definitions for agents shipped with the CLI. */
export const BUILTIN_ROSTER_VERSION = 1 as const;

const RESULT_INSTRUCTIONS = `Return only one result between the exact markers
${FACTORY_RESULT_START} and ${FACTORY_RESULT_END}. The content must be a
JSON object matching this schema: {"status":"success"|"failure","summary":string,
"artifacts":[{"path":string,"kind":string,"description":string}],"notes":[string]}.
Use repository-relative artifact paths only. Do not include planning, testing,
commits, retries, or handoffs in the result or perform those activities.`;

const PLANNER_RESULT_INSTRUCTIONS = `Return only one result between the exact markers
${FACTORY_RESULT_START} and ${FACTORY_RESULT_END}. The content must be a
JSON object matching this schema: {"status":"success"|"failure","summary":string,
"artifacts":[{"path":string,"kind":string,"description":string}],"notes":[string],
"plan":{"missionTitle":string,"intent":string,"changePlan":string,"changePlanSteps"?:["Step 1","Step 2"],
"externalArtifacts"?:[{"path":string,"label"?:string}],
"risks":[{"description":string,"mitigation":string}],
"alternatives":[{"name":string,"rejectedBecause":string}],
"acceptanceCriteria":[string],"verificationStrategy":string,
"verificationMode":"fast"|"standard"|"exhaustive"}}.
For a successful result, plan and exactly one architecture artifact declaration are required; notes are also required. The artifact path is exactly the concrete path in Run context. Delegate repository exploration to codebase-explorer, complete visualize-change, and write the exact run artifact first.
Put the complete readable plan in summary. The workflow creates one draft and appends its pln_ ID.
Do not approve, materialize, revise, archive, create missions, run commands or tests, make commits,
retry, or hand off work.`;

export const SCOUT_ROSTER_ENTRY: AgentRosterEntry = AgentRosterEntrySchema.parse({
  name: "scout",
  opencodeAgent: "scout",
  purpose: "Inspect a repository and report relevant findings without changing it",
  model: "github-copilot/gpt-5.6-luna",
  systemPrompt: `You are the read-only scout for Software Factory. Inspect the repository to answer the request, prioritizing accurate, concise evidence. You may use only the tools listed by the workflow. The write boundary is post-run enforced by the workflow; it is not a preventative tool restriction, so do not claim that tools themselves prevent writes. ${RESULT_INSTRUCTIONS}`,
  userPromptTemplate: `Request:\n{{request}}\n\nRun context:\n{{runContext}}\n\n{{resultInstructions}}`,
  // Read tools are the intended capability; post-run boundary enforcement remains authoritative.
  allowedTools: ["read", "glob", "grep"],
  writeBoundary: [],
});

export const PLANNER_ROSTER_ENTRY: AgentRosterEntry = AgentRosterEntrySchema.parse({
  name: "planner",
  opencodeAgent: "plan-mission",
  purpose: "Explore a repository and create exactly one draft mission plan",
  model: "github-copilot/gpt-5.6-terra",
  systemPrompt: `You are the planner for Software Factory. Explore first, then load visualize-change and write only the exact run architecture HTML artifact. Return the complete plan in result.plan and its one matching declaration in result.artifacts. Factory validates and persists exactly one draft. Do not approve, materialize, revise, archive, create missions, run commands or tests, commit, or write other files. ${PLANNER_RESULT_INSTRUCTIONS}`,
  userPromptTemplate: `Request:\n{{request}}\n\nRun context:\n{{runContext}}\n\nExplore first, load visualize-change, write the exact expectedArtifactPath, then return the complete plan, notes, and one artifact declaration.`,
  allowedTools: ["task", "skill", "read", "glob", "grep", "edit"],
  writeBoundary: [".factory/architecture"],
});

export const BUILTIN_ROSTER: readonly AgentRosterEntry[] = Object.freeze([
  SCOUT_ROSTER_ENTRY,
  PLANNER_ROSTER_ENTRY,
]);

export type RunPromptContext = Readonly<Record<string, unknown>>;
export type RenderedAgentPrompts = Readonly<{
  agent: AgentRosterEntry;
  systemPrompt: string;
  userPrompt: string;
}>;

export function getRosterEntry(name: string): AgentRosterEntry | undefined {
  return BUILTIN_ROSTER.find((entry) => entry.name === name);
}

export function lookupRoster(name: string): AgentRosterEntry {
  const entry = getRosterEntry(name);
  if (!entry) throw new Error(`Unknown agent: ${name}`);
  return entry;
}

function safeContext(context: RunPromptContext): string {
  // Normalize recursively with sorted keys so insertion order cannot affect prompts.
  const seen = new WeakSet<object>();
  const normalize = (value: unknown, inArray = false): unknown => {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function" || typeof value === "symbol" || value === undefined)
      return inArray ? null : undefined;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => normalize(item, true));
    const result: Record<string, unknown> = {};
    const objectValue = value as Record<string, unknown>;
    for (const key of Object.keys(objectValue).sort()) {
      const normalized = normalize(objectValue[key]);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  };
  return JSON.stringify(normalize(context), null, 2);
}

function renderTemplate(template: string, values: Record<string, string>): string {
  for (const match of template.matchAll(/\{\{([^}]*)\}\}/g)) {
    const key = match[1];
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !(key in values))
      throw new Error(`Unresolved prompt template token: {{${key}}}`);
  }
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, key: string) => values[key] ?? "");
}

export function renderAgentPrompts(
  agentName: string,
  request: string,
  context: RunPromptContext = {},
): RenderedAgentPrompts {
  const agent = lookupRoster(agentName);
  const values = {
    request: request.trim(),
    runContext: safeContext(context),
    resultInstructions: RESULT_INSTRUCTIONS,
  };
  const userPrompt = renderTemplate(agent.userPromptTemplate, values);
  return { agent, systemPrompt: agent.systemPrompt, userPrompt };
}

export { RESULT_INSTRUCTIONS };
