import {
  CostSchema,
  RunFailureSchema,
  RunSchema,
  TokenUsageSchema,
  TraceEventSchema,
  AgentCapabilitySchema,
  type AgentCapability,
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
    version: z.number().int().positive().optional(),
    opencodeAgent: nonEmptyText.optional(),
    purpose: nonEmptyText,
    model: nonEmptyText,
    systemPrompt: nonEmptyText,
    userPromptTemplate: nonEmptyText,
    allowedTools: z.array(nonEmptyText).readonly(),
    writeBoundary: z.array(RepositoryRelativePathSchema).readonly(),
    capabilities: z.array(AgentCapabilitySchema).readonly().optional(),
  })
  .strict();
export type { AgentCapability };

export const EffectiveRunDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z
      .object({
        id: nonEmptyText,
        version: z.number().int().positive(),
        provenance: z.literal("builtin"),
      })
      .strict(),
    workflow: z
      .object({
        id: nonEmptyText,
        version: z.number().int().positive(),
        agent: nonEmptyText,
        provenance: z.literal("builtin"),
      })
      .strict(),
    runtime: z
      .object({
        id: nonEmptyText,
        adapterId: nonEmptyText,
        capabilities: z.array(AgentCapabilitySchema).readonly(),
        model: nonEmptyText.optional(),
        profile: z.record(z.string(), z.unknown()).readonly().optional(),
      })
      .strict(),
    completionContract: z.literal("factory-result-json-v1"),
    policy: z
      .object({
        capabilities: z.array(AgentCapabilitySchema).readonly(),
        writeBoundary: z.array(RepositoryRelativePathSchema).readonly(),
      })
      .strict(),
  })
  .strict();
export type EffectiveRunDefinition = z.infer<typeof EffectiveRunDefinitionSchema>;

export const ArtifactRecordSchema = z
  .object({ path: RepositoryRelativePathSchema, kind: nonEmptyText, description: nonEmptyText })
  .strict();

export const AgentResultSchema = z
  .object({
    status: z.enum(["success", "failure"]),
    summary: nonEmptyText,
    artifacts: z.array(ArtifactRecordSchema),
    notes: z.array(nonEmptyText),
    plan: PlanInputSchema.optional(),
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
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type BackendInvocation = z.infer<typeof BackendInvocationSchema>;
export type BackendResult = z.infer<typeof BackendResultSchema>;
