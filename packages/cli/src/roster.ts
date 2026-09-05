import type { AgentCapability } from "@software-factory/contracts";

import { AgentResultSchema, AgentRosterEntrySchema, type AgentRosterEntry } from "./workflow";
import type { WorkflowStageDefinition } from "./workflow";

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
For a successful result, plan and exactly one architecture artifact declaration are required; notes are also required. The artifact path is exactly the concrete path in Run context. Repository exploration and visualize-change are recommended guidance; write the exact run artifact first.
Put the complete readable plan in summary. The workflow creates one draft and appends its pln_ ID.
Do not approve, materialize, revise, archive, create missions, run commands or tests, make commits,
retry, or hand off work.`;

const scoutDefinition: AgentRosterEntry = AgentRosterEntrySchema.parse({
  name: "scout",
  version: 1,
  opencodeAgent: "scout",
  purpose: "Inspect a repository and report relevant findings without changing it",
  model: "github-copilot/gpt-5.6-luna",
  systemPrompt: `You are the read-only scout for Software Factory. Inspect the repository to answer the request, prioritizing accurate, concise evidence. You may use only the tools listed by the workflow. The write boundary is post-run enforced by the workflow; it is not a preventative tool restriction, so do not claim that tools themselves prevent writes. ${RESULT_INSTRUCTIONS}`,
  userPromptTemplate: `Request:\n{{request}}\n\nRun context:\n{{runContext}}\n\n{{resultInstructions}}`,
  // Read tools are the intended capability; post-run boundary enforcement remains authoritative.
  allowedTools: ["read", "glob", "grep"],
  writeBoundary: [],
  capabilities: ["repository.read"],
});

const plannerDefinition: AgentRosterEntry = AgentRosterEntrySchema.parse({
  name: "planner",
  version: 1,
  opencodeAgent: "plan-mission",
  purpose: "Explore a repository and create exactly one draft mission plan",
  model: "github-copilot/gpt-5.6-terra",
  systemPrompt: `You are the planner for Software Factory. Explore with codebase-explorer and use visualize-change as helpful, then write only the exact run architecture HTML artifact. These are recommended guidance, not success requirements. Return the complete plan in result.plan and its one matching declaration in result.artifacts. Factory validates and persists exactly one draft. Do not approve, materialize, revise, archive, create missions, run commands or tests, commit, or write other files. ${PLANNER_RESULT_INSTRUCTIONS}`,
  userPromptTemplate: `Request:\n{{request}}\n\nRun context:\n{{runContext}}\n\nWrite the exact expectedArtifactPath, then return the complete plan, notes, and one artifact declaration.`,
  allowedTools: ["task", "skill", "read", "glob", "grep", "edit"],
  writeBoundary: [".factory/architecture"],
  capabilities: ["repository.read", "repository.write", "workflow.delegate", "workflow.skill"],
});

export type BuiltinRegistryEntry = Readonly<{
  agent: AgentRosterEntry;
  workflow: {
    id: string;
    version: number;
    agent: string;
    provenance: "builtin";
    stages: readonly WorkflowStageDefinition[];
  };
  runtime: {
    id: string;
    capabilities: readonly AgentCapability[];
    model?: string;
    profile?: Readonly<Record<string, unknown>>;
  };
  completionContract: "factory-result-json-v1";
  policy: { allowPreExistingUntracked: boolean };
  ui: { label: string; description: string; placeholder: string; detail: string };
}>;

export const BUILTIN_REGISTRY: readonly BuiltinRegistryEntry[] = Object.freeze([
  {
    agent: scoutDefinition,
    workflow: {
      id: "repository-scout",
      version: 1,
      agent: "scout",
      provenance: "builtin",
      stages: [{ id: "scout", kind: "agent", agent: "scout", label: "Repository scout" }],
    },
    runtime: {
      id: "opencode",
      capabilities: scoutDefinition.capabilities ?? ["repository.read"],
      model: scoutDefinition.model,
      profile: { opencodeAgent: scoutDefinition.opencodeAgent },
    },
    completionContract: "factory-result-json-v1",
    policy: { allowPreExistingUntracked: true },
    ui: {
      label: "Scout",
      description: scoutDefinition.purpose,
      placeholder: "What should the scout inspect?",
      detail: "READ-ONLY RESEARCH",
    },
  },
  {
    agent: plannerDefinition,
    workflow: {
      id: "mission-planner",
      version: 1,
      agent: "planner",
      provenance: "builtin",
      stages: [
        { id: "planner", kind: "agent", agent: "planner", label: "Mission planner" },
        {
          id: "planner-evidence",
          kind: "action",
          action: "persist-planner-evidence",
          label: "Persist planner evidence",
        },
        {
          id: "planner-artifact",
          kind: "action",
          action: "validate-architecture-artifact",
          label: "Validate architecture artifact",
        },
        {
          id: "planner-draft",
          kind: "action",
          action: "persist-draft-plan",
          label: "Persist draft plan",
        },
      ],
    },
    runtime: {
      id: "opencode",
      capabilities: plannerDefinition.capabilities ?? [
        "repository.read",
        "repository.write",
        "workflow.delegate",
        "workflow.skill",
      ],
      model: plannerDefinition.model,
      profile: { opencodeAgent: plannerDefinition.opencodeAgent },
    },
    completionContract: "factory-result-json-v1",
    policy: { allowPreExistingUntracked: false },
    ui: {
      label: "Planner",
      description: plannerDefinition.purpose,
      placeholder: "What should the planner prepare?",
      detail: "RESEARCH + MISSION PLAN",
    },
  },
]);

/** Compatibility views; the registry above is the only production authority. */
export const BUILTIN_ROSTER: readonly AgentRosterEntry[] = Object.freeze(
  BUILTIN_REGISTRY.map((entry) => entry.agent),
);
const rosterEntry = (name: string): AgentRosterEntry => {
  const entry = BUILTIN_ROSTER.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Missing builtin roster entry: ${name}`);
  return entry;
};
export const SCOUT_ROSTER_ENTRY = rosterEntry("scout");
export const PLANNER_ROSTER_ENTRY = rosterEntry("planner");
export const BUILTIN_WORKFLOWS = Object.freeze(
  Object.fromEntries(BUILTIN_REGISTRY.map((entry) => [entry.agent.name, entry.workflow])) as {
    scout: BuiltinRegistryEntry["workflow"];
    planner: BuiltinRegistryEntry["workflow"];
  },
);

export type RunPromptContext = Readonly<Record<string, unknown>>;
export type RenderedAgentPrompts = Readonly<{
  agent: AgentRosterEntry;
  systemPrompt: string;
  userPrompt: string;
}>;

export function getRosterEntry(name: string): AgentRosterEntry | undefined {
  return BUILTIN_REGISTRY.find((entry) => entry.agent.name === name)?.agent;
}

export function lookupRegistry(name: string): BuiltinRegistryEntry {
  const entry = BUILTIN_REGISTRY.find((candidate) => candidate.agent.name === name);
  if (!entry) throw new Error(`Unknown agent: ${name}`);
  return entry;
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
