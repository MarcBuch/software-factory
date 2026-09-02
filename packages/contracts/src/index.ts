import { z } from "zod";

const text = z.string().trim().min(1);
const iso = z.string().datetime({ offset: true });
const planId = z.string().regex(/^pln_[A-Za-z0-9]+$/);

export const PlanStatusSchema = z.enum(["draft", "approved", "superseded", "archived"]);
export const PlanStatus = PlanStatusSchema;
export const VerificationModeSchema = z.enum(["fast", "standard", "exhaustive"]);
export const AlternativeSchema = z.object({ name: text, rejectedBecause: text }).strict();
export const RiskSchema = z.object({ description: text, mitigation: text }).strict();
export const ExternalPlanArtifactSchema = z
  .object({
    path: z
      .string()
      .refine(
        (path) =>
          !path.includes("\\") &&
          !path.startsWith("/") &&
          !path.startsWith("./") &&
          !path.split("/").some((part) => part === ".." || part === "") &&
          /\.(?:html|md|mdx)$/.test(path),
        "Artifact must be a repository-relative .html, .md, or .mdx path",
      ),
    label: text.optional(),
  })
  .strict();

export const TaskStatusSchema = z.enum(["open", "in_progress", "closed"]);
/** Implementation and verification are the only task types; test writing/running is verification. */
export const TaskTypeSchema = z.enum(["implementation", "verification"]);
export const TaskSchema = z
  .object({
    id: z.string().regex(/^tsk_[A-Za-z0-9]+$/),
    title: text,
    type: TaskTypeSchema,
    risk: z.enum(["low", "medium", "high"]),
    verification: text,
    status: TaskStatusSchema,
    closureReason: text.optional(),
    planStepKey: text.optional(),
    dependsOn: z.array(z.string().regex(/^tsk_[A-Za-z0-9]+$/)).optional(),
    createdAt: iso,
    updatedAt: iso,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt)
      context.addIssue({ code: "custom", message: "updatedAt must be >= createdAt" });
    if (value.status === "closed" && !value.closureReason)
      context.addIssue({
        code: "custom",
        path: ["closureReason"],
        message: "Closed tasks require a closure reason",
      });
    if (value.status !== "closed" && value.closureReason !== undefined)
      context.addIssue({
        code: "custom",
        path: ["closureReason"],
        message: "Only closed tasks may have a closure reason",
      });
  });
export const MilestoneSchema = z
  .object({
    id: z.string().regex(/^mil_[A-Za-z0-9]+$/),
    title: text,
    createdAt: iso,
    updatedAt: iso,
    tasks: z.array(TaskSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt)
      context.addIssue({ code: "custom", message: "updatedAt must be >= createdAt" });
  });
export const MissionSchema = z
  .object({
    id: z.string().regex(/^mis_[A-Za-z0-9]+$/),
    title: text,
    verificationMode: VerificationModeSchema,
    verificationStrategy: text,
    risks: z.array(RiskSchema),
    createdAt: iso,
    updatedAt: iso,
    milestones: z.array(MilestoneSchema),
    sourcePlan: z
      .object({ planId: z.string(), revision: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt)
      context.addIssue({ code: "custom", message: "updatedAt must be >= createdAt" });
  });
export const PlanInputSchema = z
  .object({
    missionTitle: text,
    intent: text,
    changePlan: text,
    changePlanSteps: z.array(text).min(1).optional(),
    externalArtifacts: z.array(ExternalPlanArtifactSchema).optional(),
    risks: z.array(RiskSchema),
    alternatives: z.array(AlternativeSchema),
    acceptanceCriteria: z.array(text),
    verificationStrategy: text,
    verificationMode: VerificationModeSchema,
  })
  .strict();

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
      intent: text,
      changePlan: text,
      changePlanSteps: z.array(text).min(1).optional(),
      externalArtifacts: z.array(ExternalPlanArtifactSchema).optional(),
      risks: z.array(RiskSchema),
      alternatives: z.array(AlternativeSchema),
      acceptanceCriteria: z.array(text),
      verificationStrategy: text,
      verificationMode: VerificationModeSchema,
      revision: z.number().int().min(1),
      status: PlanStatusSchema,
      createdAt: iso,
      updatedAt: iso,
      approvedAt: iso.optional(),
    })
    .strict(),
);
export const PlanSchema = PlanRevisionSchema;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;
export type PlanInput = z.infer<typeof PlanInputSchema>;
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type VerificationMode = z.infer<typeof VerificationModeSchema>;
export type ExternalPlanArtifact = z.infer<typeof ExternalPlanArtifactSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type Mission = z.infer<typeof MissionSchema>;

export const RunFailureSchema = z
  .object({
    code: text,
    message: text,
    failureCode: text.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const RunStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export const RunSchema = z
  .object({
    id: text,
    status: RunStatusSchema,
    startedAt: iso.optional(),
    finishedAt: iso.optional(),
    failure: RunFailureSchema.optional(),
    metadata: z
      .object({ request: text.optional(), agentName: text.optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === "pending" && (run.startedAt || run.finishedAt || run.failure))
      context.addIssue({ code: "custom", message: "Pending runs cannot have lifecycle details" });
    if (run.status === "running" && (!run.startedAt || run.finishedAt || run.failure))
      context.addIssue({ code: "custom", message: "Running runs require startedAt only" });
    if (
      ["succeeded", "cancelled"].includes(run.status) &&
      (!run.startedAt || !run.finishedAt || run.failure)
    )
      context.addIssue({
        code: "custom",
        message: "Terminal runs require timestamps and no failure",
      });
    if (run.status === "failed" && (!run.startedAt || !run.finishedAt || !run.failure))
      context.addIssue({ code: "custom", message: "Failed runs require timestamps and failure" });
    if (run.startedAt && run.finishedAt && Date.parse(run.finishedAt) < Date.parse(run.startedAt))
      context.addIssue({ code: "custom", message: "finishedAt must be >= startedAt" });
  });

export const TokenUsageSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
    total: z.number().nonnegative(),
  })
  .strict()
  .superRefine((usage, context) => {
    const expected =
      usage.input +
      usage.output +
      (usage.reasoning ?? 0) +
      (usage.cacheRead ?? 0) +
      (usage.cacheWrite ?? 0);
    if (usage.total !== expected)
      context.addIssue({ code: "custom", message: "total must equal all token categories" });
  });
export const CostSchema = z.object({ amount: z.number().nonnegative(), currency: text }).strict();
const TraceBaseSchema = z.object({ runId: text, at: iso }).strict();
const TraceEventBodySchema = z.discriminatedUnion("type", [
  TraceBaseSchema.extend({ type: z.literal("run_started") }),
  TraceBaseSchema.extend({
    type: z.literal("run_finished"),
    status: z.enum(["succeeded", "failed", "cancelled"]),
  }),
  TraceBaseSchema.extend({ type: z.literal("agent_started"), agentName: text }),
  TraceBaseSchema.extend({
    type: z.literal("agent_finished"),
    agentName: text,
    result: z.object({ summary: text }).passthrough(),
  }),
  TraceBaseSchema.extend({
    type: z.literal("tool_call"),
    agentName: text,
    tool: text,
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    spanId: text.optional(),
    phase: z.enum(["start", "finish"]).optional(),
  }),
  TraceBaseSchema.extend({ type: z.literal("model_step"), agentName: text }),
  TraceBaseSchema.extend({
    type: z.literal("error"),
    message: text,
    code: text.optional(),
    agentName: text.optional(),
  }),
]);
export const TraceEventSchema = TraceEventBodySchema.and(
  z.object({ usage: TokenUsageSchema.optional(), cost: CostSchema.optional() }).strict(),
);
export const TraceSummarySchema = z
  .object({ usage: TokenUsageSchema, cost: z.number().nonnegative() })
  .strict();

export const SessionsPageSchema = z
  .object({ runs: z.array(RunSchema), nextCursor: z.number().int().optional() })
  .strict();
const TraceEventApiSchema = z.object({ id: z.number().int() }).and(
  z.preprocess((value) => {
    const { id: _id, ...event } = value as Record<string, unknown>;
    return { runId: "api", ...event };
  }, TraceEventSchema),
) as unknown as z.ZodType<TraceEventApi>;
export const TracePageSchema = z
  .object({
    runId: text,
    events: z.array(TraceEventApiSchema),
    nextCursor: z.number().int().optional(),
    hasMore: z.boolean(),
    summary: TraceSummarySchema,
    publicRun: RunSchema.optional(),
  })
  .strict();
export const LaunchRequestSchema = z
  .object({ request: text, agentName: z.enum(["scout", "planner"]) })
  .strict();
export const LaunchResponseSchema = z
  .object({ accepted: z.literal(true), run: RunSchema })
  .strict();
export const DeleteResponseSchema = z.object({ deleted: z.literal(true), runId: text }).strict();
export const DeletePlanResponseSchema = z
  .object({
    deleted: z.literal(true),
    planId: planId,
    revisionsDeleted: z.number().int().nonnegative(),
    missionsDeleted: z.number().int().nonnegative(),
  })
  .strict();

export type Run = z.infer<typeof RunSchema>;
export type DeletePlanResponse = z.infer<typeof DeletePlanResponseSchema>;
export type RunFailure = z.infer<typeof RunFailureSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type TraceSummary = z.infer<typeof TraceSummarySchema>;
export type SessionsPage = z.infer<typeof SessionsPageSchema>;
export type TracePage = z.infer<typeof TracePageSchema>;
export type TraceEventApi = Omit<TraceEvent, "runId"> & {
  id: number;
  agentName?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  result?: { summary: string };
  message?: string;
};
