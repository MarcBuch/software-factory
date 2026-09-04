export type LifecycleDiagnostic = Readonly<{
  event: string;
  backend: "v1-cli" | "v2-client";
  runId?: string;
  sessionId?: string;
  errorClass?: string;
  errorCode?: string;
  droppedEvents?: number;
  state?: "started" | "succeeded" | "failed" | "timed_out" | "requested" | "stopped";
}>;

export type LifecycleDiagnosticSink = (diagnostic: LifecycleDiagnostic) => void;

export function errorDetails(
  error: unknown,
): Pick<LifecycleDiagnostic, "errorClass" | "errorCode"> {
  const value = error as { name?: unknown; code?: unknown } | null;
  return {
    errorClass:
      error instanceof Error
        ? error.name
        : typeof value?.name === "string"
          ? value.name
          : "UnknownError",
    ...(typeof value?.code === "string" || typeof value?.code === "number"
      ? { errorCode: String(value.code) }
      : {}),
  };
}

export function defaultLifecycleDiagnostic(diagnostic: LifecycleDiagnostic): void {
  console.error(`[factory] ${JSON.stringify(diagnostic)}`);
}
