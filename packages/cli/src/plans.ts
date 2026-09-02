import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  PlanInputSchema,
  PlanSchema,
  PlanStatus,
  AlternativeSchema,
  RiskSchema,
  type Plan,
  type PlanInput,
} from "@software-factory/contracts";
import { z } from "zod";

import { withFactoryLock } from "./storage";
const exec = promisify(execFile);

export { AlternativeSchema, PlanInputSchema, PlanSchema, PlanStatus, RiskSchema };
export type { Plan, PlanRevision, PlanInput } from "@software-factory/contracts";

export const PLAN_INPUT_EXAMPLE: PlanInput = {
  missionTitle: "Ship the feature",
  intent: "Intent",
  changePlan: "Change plan",
  changePlanSteps: ["First step", "Second step"],
  risks: [{ description: "A dependency may change", mitigation: "Pin and verify it" }],
  alternatives: [{ name: "Alternative approach", rejectedBecause: "Less suitable here" }],
  acceptanceCriteria: ["Verified"],
  verificationStrategy: "Run tests",
  verificationMode: "standard",
};

export const PlanRevisionSchema = PlanSchema;

/** Artifact paths are repository-relative, but their existence is a storage boundary concern. */
export async function validatePlanArtifacts(plan: Plan, repositoryRoot: string) {
  const root = await realpath(repositoryRoot);
  for (const artifact of plan.externalArtifacts ?? []) {
    try {
      const candidate = await realpath(resolve(root, artifact.path));
      const relativePath = relative(root, candidate);
      if (relativePath === ".." || relativePath.startsWith("../"))
        throw Error("outside repository");
      if (!(await stat(candidate)).isFile()) throw Error("not a file");
    } catch {
      throw Error(`External plan artifact is missing or outside the repository: ${artifact.path}`);
    }
  }
}

export async function createDraftPlan(
  input: PlanInput,
  file: string,
  repositoryRoot?: string,
): Promise<Plan> {
  return withFactoryLock(repositoryRoot ?? (await projectRoot()), async () => {
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
    if (repositoryRoot) await validatePlanArtifacts(plan, repositoryRoot);
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

/** Remove a plan and every mission materialized from any of its revisions. */
export function deletePlanCascade<T extends { sourcePlan?: { planId: string } }>(
  plans: Plan[],
  missions: T[],
  planId: string,
): { plans: Plan[]; missions: T[] } {
  if (!plans.some((plan) => plan.id === planId)) throw Error(`Plan not found: ${planId}`);
  return {
    plans: plans.filter((plan) => plan.id !== planId),
    missions: missions.filter((mission) => mission.sourcePlan?.planId !== planId),
  };
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
  return lines.slice(1).map((line) => PlanSchema.parse(normalizeLegacyPlan(JSON.parse(line))));
}

function normalizeLegacyPlan(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, any>;
  if (!record.sections) return record;
  const { sections: _sections, milestones: _milestones, steps: _steps, ...current } = record;
  return {
    ...current,
    intent: record.intent ?? _sections.intent,
    changePlan: record.changePlan ?? _sections.approach,
    risks: record.risks ?? _sections.risks,
    alternatives: record.alternatives ?? _sections.alternatives,
    acceptanceCriteria: record.acceptanceCriteria ?? _sections.acceptance,
    verificationStrategy: record.verificationStrategy ?? "Verify the implementation",
  };
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
  return withFactoryLock(await projectRoot(), () => {
    validatePlansAgainstMissions(plans, missions);
    return savePlansUnlocked(plans, file!);
  });
}

export async function ensurePlansMetadata() {
  const file = await plansPath();
  await withFactoryLock(await projectRoot(), () => ensurePlansMetadataUnlocked(file));
}

export async function ensurePlansMetadataUnlocked(file: string) {
  if (!existsSync(file)) await savePlansUnlocked([], file);
}

export async function appendPlan(plan: Plan, missions: MissionReference[], file?: string) {
  file ??= await plansPath();
  return withFactoryLock(await projectRoot(), async () => {
    const plans = await loadPlans(file, missions);
    plans.push(PlanSchema.parse(plan));
    validatePlansAgainstMissions(plans, missions);
    await savePlansUnlocked(plans, file!);
  });
}
