import type {
  AgentRuntimeAdapter as BackendAdapter,
  BackendEvent,
  BackendInvocation,
  BackendProcess,
} from "./agent-runtime";
import { completeAgent, type CompletionOutcome } from "./completion";
import type { AgentRosterEntry, WorkflowStageDefinition } from "./workflow";

/** Provider-neutral seam for one agent stage. Planner policy belongs to the runner. */
export class AgentExecutor {
  constructor(private readonly adapter: BackendAdapter) {}

  execute(
    invocation: BackendInvocation,
    onEvent?: (event: BackendEvent, process: BackendProcess) => void | Promise<void>,
  ): Promise<CompletionOutcome> {
    return completeAgent(this.adapter, invocation, onEvent);
  }
}

export interface AgentExecutorLike {
  execute(
    invocation: BackendInvocation,
    onEvent?: (event: BackendEvent, process: BackendProcess) => void | Promise<void>,
  ): Promise<CompletionOutcome>;
}

export type AgentStage = Readonly<
  Extract<WorkflowStageDefinition, { kind: "agent" }> & {
    agentDefinition: AgentRosterEntry;
    invocation: BackendInvocation;
  }
>;

export type FactoryAction = (context: Readonly<Record<string, unknown>>) => Promise<void>;
