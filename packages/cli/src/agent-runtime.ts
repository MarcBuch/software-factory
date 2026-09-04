import type { TraceEvent } from "@software-factory/contracts";
import type { AgentCapability } from "@software-factory/contracts";

/** Harness-neutral execution seam. Concrete providers remain adapter-owned. */
export type RuntimeCapability = AgentCapability;

/** Provider-neutral input. Registry policy is resolved before this crosses an adapter boundary. */
export type EffectiveRuntimeInput = Readonly<{
  id?: string;
  systemPrompt: string;
  userPrompt?: string;
  model?: string;
  capabilities?: readonly RuntimeCapability[];
  writeBoundary?: readonly string[];
  completionContract?: "factory-result-json-v1";
  /** Opaque provider binding interpreted only by the selected adapter. */
  adapterProfile?: Readonly<Record<string, unknown>>;
  /** Legacy neutral display name retained for injected adapters. */
  name?: string;
}>;

export type BackendInvocation = Readonly<{
  repositoryRoot: string;
  runId: string;
  agent: EffectiveRuntimeInput;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  tools?: readonly string[];
}>;
export type BackendEvent = Readonly<{
  stream: "stdout" | "stderr";
  raw: string;
  parsed?: unknown;
  normalized?: TraceEvent;
  /** Provider-neutral execution identity; adapters translate provider IDs here. */
  executionId?: string;
}>;
export type BackendExit = Readonly<{
  code: number | null;
  signal: string | null;
  signalCode: string | null;
  /** Provider-neutral execution identity; adapters translate provider IDs here. */
  executionId?: string;
}>;
export interface BackendProcess extends AsyncIterable<BackendEvent> {
  readonly executionKind?: "subprocess" | "service" | "embedded";
  readonly pid: number;
  readonly command: readonly string[];
  readonly exit: Promise<BackendExit>;
  kill(signal?: number | NodeJS.Signals): void;
  cancel(): void;
  continue(prompt: string): BackendProcess;
}

export type RuntimeAdapterProfile = Readonly<{
  id: string;
  capabilities: readonly RuntimeCapability[];
  model?: string;
  binding?: Readonly<Record<string, unknown>>;
}>;

export interface AgentRuntimeAdapter {
  readonly id: string;
  readonly capabilities: readonly RuntimeCapability[];
  readonly supportsConcurrent?: boolean;
  start(invocation: BackendInvocation): BackendProcess;
}
