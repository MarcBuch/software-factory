import {
  CostSchema,
  RunFailureSchema,
  RunSchema,
  TokenUsageSchema,
  TraceEventSchema,
} from "@software-factory/contracts";
import { z } from "zod";

import { PlanInputSchema } from "./plans";

export { CostSchema, RunFailureSchema, RunSchema, TokenUsageSchema, TraceEventSchema };

const nonEmptyText = z.string().trim().min(1);

/** A path that cannot escape the repository root (paths are normalized to `/`). */
export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.includes("\0") &&
      !path.includes("\\") &&
      !path.startsWith("/") &&
      !/^(?:[A-Za-z]:|\\\\)/.test(path) &&
      !path.startsWith("./") &&
      !path.split("/").some((part) => part === ".." || part === ""),
    "Path must be a safe repository-relative path",
  );

export const WorkflowInputSchema = z
  .object({ request: nonEmptyText, agentName: nonEmptyText })
  .strict();

export const AgentRosterEntrySchema = z
  .object({
    name: nonEmptyText,
    opencodeAgent: nonEmptyText.optional(),
    purpose: nonEmptyText,
    model: nonEmptyText,
    systemPrompt: nonEmptyText,
    userPromptTemplate: nonEmptyText,
    allowedTools: z.array(nonEmptyText).readonly(),
    writeBoundary: z.array(RepositoryRelativePathSchema).readonly(),
  })
  .strict();

export const ArtifactRecordSchema = z
  .object({ path: RepositoryRelativePathSchema, kind: nonEmptyText, description: nonEmptyText })
  .strict();

const tone = z.enum(["legacy", "new", "client", "test", "neutral"]);
const titledDetail = z.object({ title: nonEmptyText, detail: nonEmptyText }).strict();
const titledItems = z.object({ title: nonEmptyText, items: z.array(nonEmptyText) }).strict();

export const ArchitectureSectionsSchema = z
  .object({
    lede: nonEmptyText,
    statusTags: z.array(z.object({ label: nonEmptyText, tone }).strict()),
    currentComposition: z
      .object({
        summary: nonEmptyText,
        groups: z.array(
          z
            .object({
              title: nonEmptyText,
              tone,
              items: z.array(
                z
                  .object({
                    title: nonEmptyText,
                    detail: nonEmptyText,
                    code: nonEmptyText.optional(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict(),
    targetLayers: z.array(titledDetail.extend({ code: nonEmptyText.optional(), tone }).strict()),
    seams: z.array(titledDetail),
    dataModelChanges: z
      .object({
        summary: nonEmptyText,
        requestLabel: nonEmptyText.optional(),
        requestExample: nonEmptyText.optional(),
        responseLabel: nonEmptyText.optional(),
        responseExample: nonEmptyText.optional(),
        stages: z.array(
          z
            .object({
              stage: nonEmptyText,
              responsibility: nonEmptyText,
              preserves: nonEmptyText,
            })
            .strict(),
        ),
        compatibility: z
          .object({
            decision: nonEmptyText,
            legacyTitle: nonEmptyText,
            legacyItems: z.array(nonEmptyText),
            targetTitle: nonEmptyText,
            targetItems: z.array(nonEmptyText),
          })
          .strict()
          .optional(),
      })
      .strict(),
    validation: z
      .object({
        groups: z.array(titledItems),
        parityRows: z.array(
          z
            .object({ area: nonEmptyText, comparison: nonEmptyText, handling: nonEmptyText })
            .strict(),
        ),
      })
      .strict(),
    resultingRequestFlow: nonEmptyText,
  })
  .strict();

export const AgentResultSchema = z
  .object({
    status: z.enum(["success", "failure"]),
    summary: nonEmptyText,
    artifacts: z.array(ArtifactRecordSchema),
    notes: z.array(nonEmptyText),
    plan: PlanInputSchema.optional(),
    architecture: ArchitectureSectionsSchema.optional(),
  })
  .strict();

export const BackendInvocationSchema = z
  .object({
    agent: AgentRosterEntrySchema,
    prompt: nonEmptyText,
    tools: z.array(nonEmptyText),
  })
  .strict();
export const BackendResultSchema = z
  .object({
    result: AgentResultSchema,
    usage: TokenUsageSchema.optional(),
    cost: CostSchema.optional(),
  })
  .strict();

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
export type AgentRosterEntry = z.infer<typeof AgentRosterEntrySchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type ArchitectureSections = z.infer<typeof ArchitectureSectionsSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type BackendInvocation = z.infer<typeof BackendInvocationSchema>;
export type BackendResult = z.infer<typeof BackendResultSchema>;
