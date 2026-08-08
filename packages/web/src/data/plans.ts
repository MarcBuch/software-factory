export type PlanStatus = "draft" | "approved" | "superseded" | "archived";
export type VerificationMode = "fast" | "standard" | "exhaustive";
export type PlanStepType = "implementation" | "verification";
export type PlanRisk = "low" | "medium" | "high";

export type PlanSection = {
  context: string;
  intent: string;
  approach: string;
  executionDesign: string;
  implementationDetails: string;
  alternatives: ReadonlyArray<{ name: string; rejectedBecause: string }>;
  risks: ReadonlyArray<{ description: string; mitigation: string }>;
  acceptance: ReadonlyArray<string>;
};

export type PlanStep = {
  key: string;
  milestoneKey: string;
  title: string;
  type: PlanStepType;
  risk: PlanRisk;
  verification: string;
  executionNotes?: string;
  inputs?: ReadonlyArray<string>;
  invariants?: ReadonlyArray<string>;
  outcomes?: ReadonlyArray<string>;
  dependsOn: ReadonlyArray<string>;
};

/** Web-owned representation of a current durable plan revision. */
export type Plan = {
  id: string;
  missionTitle: string;
  verificationMode: VerificationMode;
  milestones: ReadonlyArray<{ key: string; title: string }>;
  revision: number;
  status: PlanStatus;
  sections: PlanSection;
  steps: ReadonlyArray<PlanStep>;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export function mapPlansResponse(value: unknown): Plan[] {
  if (!Array.isArray(value)) throw new Error("Plans API returned an invalid response");
  return value.map((record, index) => mapPlan(record, index));
}

const statuses = new Set<PlanStatus>(["draft", "approved", "superseded", "archived"]);
const verificationModes = new Set<VerificationMode>(["fast", "standard", "exhaustive"]);
const stepTypes = new Set<PlanStepType>(["implementation", "verification"]);
const risks = new Set<PlanRisk>(["low", "medium", "high"]);

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Plans API returned an invalid ${path}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`Plans API returned an invalid ${path}`);
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Plans API returned an invalid ${path}`);
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || Number.isNaN(Date.parse(result)))
    throw new Error(`Plans API returned an invalid ${path}`);
  return result;
}

function strings(value: unknown, path: string): string[] {
  return list(value, path).map((entry, index) => string(entry, `${path}[${index}]`));
}

function mapPlan(value: unknown, index: number): Plan {
  const plan = object(value, `plan[${index}]`);
  const status = string(plan.status, `plan[${index}].status`) as PlanStatus;
  const verificationMode = string(
    plan.verificationMode,
    `plan[${index}].verificationMode`,
  ) as VerificationMode;
  if (!statuses.has(status) || !verificationModes.has(verificationMode))
    throw new Error(`Plans API returned an invalid plan[${index}] enum`);
  const sections = object(plan.sections, `plan[${index}].sections`);
  const section = {
    context: string(sections.context, "sections.context"),
    intent: string(sections.intent, "sections.intent"),
    approach: string(sections.approach, "sections.approach"),
    executionDesign: string(sections.executionDesign, "sections.executionDesign"),
    implementationDetails: string(sections.implementationDetails, "sections.implementationDetails"),
    alternatives: list(sections.alternatives, "sections.alternatives").map((entry) => {
      const item = object(entry, "sections.alternatives[]");
      return {
        name: string(item.name, "alternative.name"),
        rejectedBecause: string(item.rejectedBecause, "alternative.rejectedBecause"),
      };
    }),
    risks: list(sections.risks, "sections.risks").map((entry) => {
      const item = object(entry, "sections.risks[]");
      return {
        description: string(item.description, "risk.description"),
        mitigation: string(item.mitigation, "risk.mitigation"),
      };
    }),
    acceptance: strings(sections.acceptance, "sections.acceptance"),
  };
  const milestones = list(plan.milestones, `plan[${index}].milestones`).map((entry) => {
    const milestone = object(entry, "milestone");
    return {
      key: string(milestone.key, "milestone.key"),
      title: string(milestone.title, "milestone.title"),
    };
  });
  const steps = list(plan.steps, `plan[${index}].steps`).map((entry) => {
    const step = object(entry, "step");
    const type = string(step.type, "step.type") as PlanStepType;
    const risk = string(step.risk, "step.risk") as PlanRisk;
    if (!stepTypes.has(type) || !risks.has(risk))
      throw new Error("Plans API returned an invalid step enum");
    return {
      key: string(step.key, "step.key"),
      milestoneKey: string(step.milestoneKey, "step.milestoneKey"),
      title: string(step.title, "step.title"),
      type,
      risk,
      verification: string(step.verification, "step.verification"),
      ...(step.executionNotes === undefined
        ? {}
        : { executionNotes: string(step.executionNotes, "step.executionNotes") }),
      ...(step.inputs === undefined ? {} : { inputs: strings(step.inputs, "step.inputs") }),
      ...(step.invariants === undefined
        ? {}
        : { invariants: strings(step.invariants, "step.invariants") }),
      ...(step.outcomes === undefined ? {} : { outcomes: strings(step.outcomes, "step.outcomes") }),
      dependsOn: strings(step.dependsOn, "step.dependsOn"),
    };
  });
  const createdAt = timestamp(plan.createdAt, `plan[${index}].createdAt`);
  const updatedAt = timestamp(plan.updatedAt, `plan[${index}].updatedAt`);
  const approvedAt =
    plan.approvedAt === undefined
      ? undefined
      : timestamp(plan.approvedAt, `plan[${index}].approvedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new Error("Plans API returned invalid plan timestamps");
  if ((status === "approved" || status === "superseded") !== (approvedAt !== undefined))
    throw new Error("Plans API returned invalid plan approval state");
  return {
    id: string(plan.id, `plan[${index}].id`),
    missionTitle: string(plan.missionTitle, `plan[${index}].missionTitle`),
    verificationMode,
    milestones,
    revision:
      typeof plan.revision === "number" && Number.isInteger(plan.revision) && plan.revision >= 1
        ? plan.revision
        : (() => {
            throw new Error("Plans API returned an invalid revision");
          })(),
    status,
    sections: section,
    steps,
    createdAt,
    updatedAt,
    ...(approvedAt === undefined ? {} : { approvedAt }),
  };
}
