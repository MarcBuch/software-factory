import type { FactoryAction } from "./agent-executor";
import type { WorkflowStageDefinition } from "./workflow";

export type RunnerStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
export type RunnerStage = WorkflowStageDefinition & {
  ordinal: number;
  status: RunnerStatus;
  failure?: string;
};
export type WorkflowRunnerOptions = Readonly<{
  stages: readonly WorkflowStageDefinition[];
  actions?: Readonly<Record<string, FactoryAction>>;
  runAgent: (stage: Extract<WorkflowStageDefinition, { kind: "agent" }>) => Promise<void>;
  transition?: (stage: RunnerStage) => Promise<void> | void;
  isCancelled?: () => boolean;
}>;

/** Executes the deliberately small, ordered workflow language. */
export class WorkflowRunner {
  readonly stages: RunnerStage[];
  constructor(private readonly options: WorkflowRunnerOptions) {
    if (new Set(options.stages.map((stage) => stage.id)).size !== options.stages.length)
      throw new Error("Workflow stages must have unique ids");
    this.stages = options.stages.map((stage, ordinal) => ({
      ...stage,
      ordinal,
      status: "pending",
    }));
  }

  async run(context: Readonly<Record<string, unknown>> = {}) {
    for (const stage of this.stages) {
      if (this.options.isCancelled?.()) {
        await this.finishRemaining("cancelled");
        break;
      }
      stage.status = "running";
      await this.options.transition?.(stage);
      try {
        if (stage.kind === "agent") await this.options.runAgent(stage);
        else {
          const action = this.options.actions?.[stage.action];
          if (!action) throw new Error(`Untrusted or unknown workflow action: ${stage.action}`);
          await action(context);
        }
        stage.status = "succeeded";
      } catch (error) {
        stage.status = this.options.isCancelled?.() ? "cancelled" : "failed";
        stage.failure = error instanceof Error ? error.message : String(error);
        await this.options.transition?.(stage);
        await this.finishRemaining("skipped");
        break;
      }
      await this.options.transition?.(stage);
    }
    return this.stages;
  }

  private async finishRemaining(status: "cancelled" | "skipped") {
    for (const stage of this.stages) {
      if (stage.status !== "pending") continue;
      stage.status = status;
      await this.options.transition?.(stage);
    }
  }
}
