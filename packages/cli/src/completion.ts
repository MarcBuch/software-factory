import type { BackendAdapter, BackendEvent, BackendInvocation, BackendProcess } from "./backend";
import { FACTORY_RESULT_END, FACTORY_RESULT_START, FactoryFinalResultSchema } from "./roster";
import type { AgentResult } from "./workflow";

/** The only wire format accepted from an agent's final assistant response. */
export const FINAL_JSON_START = FACTORY_RESULT_START;
export const FINAL_JSON_END = FACTORY_RESULT_END;

export type CompletionOutcome =
  | {
      kind: "success";
      result: AgentResult;
      attempts: 1 | 2;
      events: readonly BackendEvent[];
    }
  | {
      kind: "agent_failure";
      result: AgentResult;
      attempts: 1 | 2;
      events: readonly BackendEvent[];
    }
  | {
      kind: "invalid_output_exhausted";
      attempts: 2;
      reason: string;
      events: readonly BackendEvent[];
    }
  | {
      kind: "backend_failure";
      attempts: 1 | 2;
      exit: Awaited<BackendProcess["exit"]>;
      events: readonly BackendEvent[];
    };

type Parsed = { ok: true; result: AgentResult } | { ok: false; reason: string };

function rejectedExit(_error: unknown): Awaited<BackendProcess["exit"]> {
  return { code: null, signal: null, signalCode: null };
}

function assistantText(event: BackendEvent): string | undefined {
  // Diagnostics are deliberately never eligible to complete a run.
  if (event.stream !== "stdout") return undefined;
  let value = event.parsed;
  if (value === undefined) {
    try {
      value = JSON.parse(event.raw);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (object.type === "text") {
    const part = object.part;
    return part &&
      typeof part === "object" &&
      typeof (part as Record<string, unknown>).text === "string"
      ? (part as Record<string, string>).text
      : undefined;
  }
  const role = object.role ?? (object.message as Record<string, unknown> | undefined)?.role;
  if (role !== "assistant") return undefined;
  const content =
    object.content ??
    object.text ??
    (object.message as Record<string, unknown> | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part &&
              typeof part === "object" &&
              typeof (part as Record<string, unknown>).text === "string"
            ? (part as Record<string, string>).text
            : "",
      )
      .join("");
  }
  return undefined;
}

/** Extracts exactly one sentinel pair from assistant events and validates its result schema. */
export function parseFinalAssistantResult(events: readonly BackendEvent[]): Parsed {
  const text = events
    .map(assistantText)
    .filter((part): part is string => part !== undefined)
    .join("");
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const starts = lines.filter((line) => line === FINAL_JSON_START).length;
  const ends = lines.filter((line) => line === FINAL_JSON_END).length;
  if (starts !== 1 || ends !== 1)
    return {
      ok: false,
      reason:
        starts === 0 ? "missing sentinel-delimited JSON" : "ambiguous sentinel-delimited JSON",
    };
  const start = lines.indexOf(FINAL_JSON_START);
  const end = lines.indexOf(FINAL_JSON_END);
  if (start < 0 || end <= start) return { ok: false, reason: "ambiguous sentinel-delimited JSON" };
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, reason: "malformed JSON" };
  }
  const result = FactoryFinalResultSchema.safeParse(value);
  return result.success
    ? { ok: true, result: result.data }
    : {
        ok: false,
        reason: `schema-invalid result: ${result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
          .join("; ")}`,
      };
}

async function runProcess(
  process: BackendProcess,
): Promise<{ events: BackendEvent[]; exit: Awaited<BackendProcess["exit"]> }> {
  const events: BackendEvent[] = [];
  for await (const event of process) events.push(event);
  return { events, exit: await process.exit };
}

const correctionPrompt = `The previous response was invalid. Reply with valid JSON only, between exactly one line containing ${FINAL_JSON_START} and one line containing ${FINAL_JSON_END}. The JSON must be a direct agent result matching the roster schema; do not wrap it.`;

/** Runs once, then performs at most one correction in the original process' session. */
export async function completeAgent(
  adapter: BackendAdapter,
  invocation: BackendInvocation,
  onEvent?: (event: BackendEvent, process: BackendProcess) => void | Promise<void>,
): Promise<CompletionOutcome> {
  let process: BackendProcess;
  try {
    process = adapter.start(invocation);
  } catch (error) {
    return {
      kind: "backend_failure",
      attempts: 1,
      exit: { code: null, signal: null, signalCode: null },
      events: [{ stream: "stderr", raw: String(error) }],
    };
  }
  let first: Awaited<ReturnType<typeof runProcess>>;
  try {
    first = await runProcessStreaming(process, onEvent);
  } catch (error) {
    return { kind: "backend_failure", attempts: 1, exit: rejectedExit(error), events: [] };
  }
  if (first.exit.code !== 0)
    return { kind: "backend_failure", attempts: 1, exit: first.exit, events: first.events };
  const parsed = parseFinalAssistantResult(first.events);
  if (parsed.ok)
    return {
      kind: parsed.result.status === "success" ? "success" : "agent_failure",
      result: parsed.result,
      attempts: 1,
      events: first.events,
    };

  let correction: BackendProcess;
  try {
    correction = process.continue(correctionPrompt);
  } catch (error) {
    return {
      kind: "backend_failure",
      attempts: 1,
      exit: { code: null, signal: null, signalCode: null },
      events: first.events.concat({ stream: "stderr", raw: String(error) }),
    };
  }
  let second: Awaited<ReturnType<typeof runProcess>>;
  try {
    second = await runProcessStreaming(correction, onEvent);
  } catch (error) {
    return {
      kind: "backend_failure",
      attempts: 2,
      exit: rejectedExit(error),
      events: first.events,
    };
  }
  const events = first.events.concat(second.events);
  if (second.exit.code !== 0)
    return { kind: "backend_failure", attempts: 2, exit: second.exit, events };
  const reparsed = parseFinalAssistantResult(second.events);
  if (!reparsed.ok)
    return { kind: "invalid_output_exhausted", attempts: 2, reason: reparsed.reason, events };
  return {
    kind: reparsed.result.status === "success" ? "success" : "agent_failure",
    result: reparsed.result,
    attempts: 2,
    events,
  };
}

async function runProcessStreaming(
  process: BackendProcess,
  onEvent?: (event: BackendEvent, process: BackendProcess) => void | Promise<void>,
) {
  const events: BackendEvent[] = [];
  for await (const event of process) {
    events.push(event);
    await onEvent?.(event, process);
  }
  return { events, exit: await process.exit };
}

export const orchestrateCompletion = completeAgent;
