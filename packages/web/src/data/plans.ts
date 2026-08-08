import { PlanSchema, type Plan } from "@software-factory/contracts";

export type { Plan, PlanStatus, VerificationMode } from "@software-factory/contracts";
export type PlanStepType = Plan["steps"][number]["type"];
export type PlanRisk = Plan["steps"][number]["risk"];

export type PlanSection = Plan["sections"];
export type PlanStep = Plan["steps"][number];

export function mapPlansResponse(value: unknown): Plan[] {
  if (!Array.isArray(value)) throw new Error("Plans API returned an invalid response");
  return value.map((record, index) => {
    try {
      return PlanSchema.parse(record);
    } catch {
      throw new Error(`Plans API returned an invalid plan[${index}]`);
    }
  });
}
