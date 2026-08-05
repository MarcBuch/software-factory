import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const timestamp = z.string().datetime({ offset: true });

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

export const AgentResultSchema = z
  .object({
    status: z.enum(["success", "failure"]),
    summary: nonEmptyText,
    artifacts: z.array(ArtifactRecordSchema),
    notes: z.array(nonEmptyText),
  })
  .strict();

export const RunFailureSchema = z
  .object({
    code: nonEmptyText,
    message: nonEmptyText,
    failureCode: nonEmptyText.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const RunSchema = z
  .object({
    id: nonEmptyText,
    status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    failure: RunFailureSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === "pending" && (run.startedAt || run.finishedAt || run.failure))
      context.addIssue({ code: "custom", message: "Pending runs cannot have lifecycle details" });
    if (run.status === "running" && (!run.startedAt || run.finishedAt || run.failure))
      context.addIssue({ code: "custom", message: "Running runs require startedAt only" });
    if (run.status === "succeeded" && (!run.startedAt || !run.finishedAt || run.failure))
      context.addIssue({
        code: "custom",
        message: "Succeeded runs require timestamps and no failure",
      });
    if (run.status === "failed" && (!run.startedAt || !run.finishedAt || !run.failure))
      context.addIssue({ code: "custom", message: "Failed runs require timestamps and failure" });
    if (run.status === "cancelled" && (!run.startedAt || !run.finishedAt || run.failure))
      context.addIssue({
        code: "custom",
        message: "Cancelled runs require timestamps and no failure",
      });
    if (run.startedAt && run.finishedAt && Date.parse(run.finishedAt) < Date.parse(run.startedAt))
      context.addIssue({ code: "custom", message: "finishedAt must be >= startedAt" });
  });

export const TokenUsageSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    total: z.number().nonnegative(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.total !== usage.input + usage.output)
      context.addIssue({ code: "custom", message: "total must equal input + output" });
  });
export const CostSchema = z
  .object({ amount: z.number().nonnegative(), currency: nonEmptyText })
  .strict();

const TraceBase = z.object({ runId: nonEmptyText, at: timestamp }).strict();
const terminalRunStatus = z.enum(["succeeded", "failed", "cancelled"]);
const TraceEvent = z.discriminatedUnion("type", [
  TraceBase.extend({ type: z.literal("run_started") }),
  TraceBase.extend({ type: z.literal("run_finished"), status: terminalRunStatus }),
  TraceBase.extend({ type: z.literal("agent_started"), agentName: nonEmptyText }),
  TraceBase.extend({
    type: z.literal("agent_finished"),
    agentName: nonEmptyText,
    result: AgentResultSchema,
  }),
  TraceBase.extend({
    type: z.literal("tool_call"),
    agentName: nonEmptyText,
    tool: nonEmptyText,
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  }),
  TraceBase.extend({
    type: z.literal("error"),
    message: nonEmptyText,
    code: nonEmptyText.optional(),
    agentName: nonEmptyText.optional(),
  }),
]);
export const TraceEventSchema = TraceEvent.and(
  z.object({ usage: TokenUsageSchema.optional(), cost: CostSchema.optional() }).strict(),
);

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
export type Run = z.infer<typeof RunSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type BackendInvocation = z.infer<typeof BackendInvocationSchema>;
export type BackendResult = z.infer<typeof BackendResultSchema>;
