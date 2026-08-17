import { PlanSchema, type Plan } from "@software-factory/contracts";

export type {
  ExternalPlanArtifact,
  Plan,
  PlanStatus,
  VerificationMode,
} from "@software-factory/contracts";
export type PlanRisk = Plan["risks"][number];
export type PlanAlternative = Plan["alternatives"][number];

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
