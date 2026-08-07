import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { withFactoryLock } from "./storage";
const exec = promisify(execFile);

const iso = z.string().datetime({ offset: true });
const text = z.string().trim().min(1);
const planId = z.string().regex(/^pln_[A-Za-z0-9]+$/);

export const PlanStatus = z.enum(["draft", "approved", "superseded", "archived"]);

export const AlternativeSchema = z.object({ name: text, rejectedBecause: text }).strict();
export const RiskSchema = z.object({ description: text, mitigation: text }).strict();
export const RichSectionSchema = z
  .object({
    context: text,
    intent: text,
    approach: text,
    executionDesign: text,
    implementationDetails: text,
    alternatives: z.array(AlternativeSchema),
    risks: z.array(RiskSchema),
    acceptance: z.array(text),
  })
  .strict();

export const PlanStepSchema = z
  .object({
    key: text,
    milestoneKey: text,
    title: text,
    type: z.enum(["implementation", "verification"]),
    risk: z.enum(["low", "medium", "high"]),
    verification: text,
    executionNotes: text.optional(),
    inputs: z.array(text).optional(),
    invariants: z.array(text).optional(),
    outcomes: z.array(text).optional(),
    dependsOn: z.array(text),
  })
  .strict();

/** The only fields accepted from plan authors (storage/lifecycle fields are internal). */
export const PlanInputSchema = z
  .object({
    missionTitle: text,
    verificationMode: z.enum(["fast", "standard", "exhaustive"]),
    sections: RichSectionSchema,
    milestones: z.array(z.object({ key: text, title: text }).strict()),
    steps: z.array(PlanStepSchema),
  })
  .strict();
export type PlanInput = z.infer<typeof PlanInputSchema>;
export const PLAN_INPUT_EXAMPLE: PlanInput = {
  missionTitle: "Ship the feature",
  verificationMode: "standard",
  sections: {
    context: "Context",
    intent: "Intent",
    approach: "Approach",
    executionDesign: "Design",
    implementationDetails: "Details",
    alternatives: [],
    risks: [],
    acceptance: ["Verified"],
  },
  milestones: [{ key: "build", title: "Build" }],
  steps: [
    {
      key: "implement",
      milestoneKey: "build",
      title: "Implement",
      type: "implementation",
      risk: "medium",
      verification: "Run tests",
      dependsOn: [],
    },
  ],
};

const approval = <T extends z.ZodObject<any>>(schema: T) =>
  schema.superRefine((value: any, ctx) => {
    const hasApproval = value.approvedAt !== undefined;
    if ((value.status === "approved" || value.status === "superseded") && !hasApproval)
      ctx.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: "approvedAt is required for approved or superseded records",
      });
    if ((value.status === "draft" || value.status === "archived") && hasApproval)
      ctx.addIssue({
        code: "custom",
        path: ["approvedAt"],
        message: "approvedAt is only valid for approved or superseded records",
      });
    if (value.updatedAt < value.createdAt)
      ctx.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must be >= createdAt",
      });
  });

export const PlanRevisionSchema = approval(
  z
    .object({
      id: planId,
      missionTitle: text,
      verificationMode: z.enum(["fast", "standard", "exhaustive"]),
      milestones: z.array(z.object({ key: text, title: text }).strict()),
      revision: z.number().int().min(1),
      status: PlanStatus,
      sections: RichSectionSchema,
      steps: z.array(PlanStepSchema),
      createdAt: iso,
      updatedAt: iso,
      approvedAt: iso.optional(),
    })
    .strict(),
);

// A plan revision is the durable plan record. The alias keeps the public model
// convenient while revisions remain explicit for lifecycle commands.
export const PlanSchema = PlanRevisionSchema;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

export async function createDraftPlan(input: PlanInput, file: string): Promise<Plan> {
  return withFactoryLock(async () => {
    const plans = await loadPlans(file, []);
    const now = new Date().toISOString();
    const plan = PlanSchema.parse({
      ...PlanInputSchema.parse(input),
      id: `pln_${crypto.randomUUID().replaceAll("-", "")}`,
      revision: 1,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    validatePlansAgainstMissions([...plans, plan], []);
    await savePlansUnlocked([...plans, plan], file);
    return plan;
  });
}

export type MissionReference = {
  id: string;
  milestones: Array<{ id: string; tasks: Array<{ id: string }> }>;
};

export function resolveDependencies(
  keys: string[],
  taskIds: ReadonlyMap<string, string>,
): string[] {
  return keys.map((key) => {
    const id = taskIds.get(key);
    if (!id) throw Error(`Dependency task not found: ${key}`);
    return id;
  });
}

/**
 * Validates plan/mission relationships without owning either store. Revisions
 * for a plan are deliberately contiguous (1..N), making gaps unambiguous.
 */
export function validatePlansAgainstMissions(plans: Plan[], _missions: MissionReference[]): Plan[] {
  const groups = new Map<string, Plan[]>();
  for (const plan of plans) {
    PlanSchema.parse(plan);
    const milestoneKeys = new Set(plan.milestones.map((m) => m.key));
    if (milestoneKeys.size !== plan.milestones.length)
      throw Error(`Duplicate milestone key in plan ${plan.id}`);
    const taskKeys = new Set(plan.steps.map((s) => s.key));
    if (taskKeys.size !== plan.steps.length) throw Error(`Duplicate task key in plan ${plan.id}`);
    for (const step of plan.steps) {
      if (!milestoneKeys.has(step.milestoneKey))
        throw Error(`Unknown milestone key: ${step.milestoneKey}`);
      if (new Set(step.dependsOn).size !== step.dependsOn.length)
        throw Error(`Duplicate dependency in plan ${plan.id}`);
      for (const dep of step.dependsOn)
        if (!taskKeys.has(dep))
          throw Error(`Dependency is not represented in plan ${plan.id}: ${dep}`);
    }
    const graph = new Map(plan.steps.map((s) => [s.key, s.dependsOn]));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (key: string) => {
      if (visiting.has(key)) throw Error(`Cyclic plan dependency involving task: ${key}`);
      if (visited.has(key)) return;
      visiting.add(key);
      for (const dep of graph.get(key) ?? []) visit(dep);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of graph.keys()) visit(key);
    (groups.get(plan.id) ?? groups.set(plan.id, []).get(plan.id)!).push(plan);
  }
  for (const [id, group] of groups) {
    const ordered = [...group].sort((a, b) => a.revision - b.revision);
    ordered.forEach((p, i) => {
      if (p.revision !== i + 1) throw Error(`Plan revisions must be contiguous for ${id}`);
    });
    for (let i = 1; i < ordered.length; i++)
      if (ordered[i].createdAt < ordered[i - 1].createdAt)
        throw Error(`Revision timestamps must be chronological for ${id}`);
    if (ordered.filter((p) => p.status === "approved").length > 1)
      throw Error(`Only one revision may be approved for ${id}`);
    if (ordered.slice(0, -1).some((p) => p.status === "draft"))
      throw Error(`Prior revisions must be superseded or archived for ${id}`);
    if (ordered.slice(0, -1).some((p) => p.status === "approved"))
      throw Error(`Only latest revision may be approved for ${id}`);
  }
  return plans;
}

export const PlansMetadataSchema = z
  .object({ type: z.literal("plans-metadata"), schemaVersion: z.literal(1) })
  .strict();

async function projectRoot() {
  try {
    return (
      await exec("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
    ).stdout.trim();
  } catch {
    throw Error("factory must be run inside a Git worktree");
  }
}

export async function plansPath() {
  return join(await projectRoot(), ".factory", "plans.jsonl");
}

export async function loadPlans(
  file: string | undefined,
  missions: MissionReference[],
): Promise<Plan[]> {
  const plans = await loadPlanRecords(file);
  return validatePlansAgainstMissions(plans, missions);
}

// Archive needs to recover a stale draft that prevents normal lifecycle validation.
export async function loadPlanRecords(file: string | undefined): Promise<Plan[]> {
  file ??= await plansPath();
  if (!existsSync(file)) return [];
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  if (!lines.length) throw Error("Invalid plan storage: missing metadata");
  PlansMetadataSchema.parse(JSON.parse(lines[0]));
  return lines.slice(1).map((line) => PlanSchema.parse(JSON.parse(line)));
}

export async function savePlansUnlocked(plans: Plan[], file: string) {
  const directory = join(file, "..");
  await mkdir(directory, { recursive: true });
  const data =
    [
      JSON.stringify({ type: "plans-metadata", schemaVersion: 1 }),
      ...plans.map((plan) => JSON.stringify(PlanSchema.parse(plan))),
    ].join("\n") + "\n";
  const temporary = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function savePlans(plans: Plan[], missions: MissionReference[], file?: string) {
  file ??= await plansPath();
  return withFactoryLock(() => {
    validatePlansAgainstMissions(plans, missions);
    return savePlansUnlocked(plans, file!);
  });
}

export async function ensurePlansMetadata() {
  const file = await plansPath();
  await withFactoryLock(() => ensurePlansMetadataUnlocked(file));
}

export async function ensurePlansMetadataUnlocked(file: string) {
  if (!existsSync(file)) await savePlansUnlocked([], file);
}

export async function appendPlan(plan: Plan, missions: MissionReference[], file?: string) {
  file ??= await plansPath();
  return withFactoryLock(async () => {
    const plans = await loadPlans(file, missions);
    plans.push(PlanSchema.parse(plan));
    validatePlansAgainstMissions(plans, missions);
    await savePlansUnlocked(plans, file!);
  });
}
