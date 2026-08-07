import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type Run = {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  metadata?: unknown;
  failure?: { message: string };
};
export type Event = {
  id?: number;
  type: string;
  at: string;
  agentName?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  usage?: {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total: number;
  };
  cost?: { amount: number; currency: string };
  result?: { summary: string };
  message?: string;
  phase?: string;
};
type Page = { runs: Run[]; nextCursor?: number };
export type TraceSummary = {
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
};
type TracePage = {
  runId: string;
  events: Event[];
  nextCursor?: number;
  hasMore: boolean;
  summary: TraceSummary;
  publicRun?: Run;
};
type LaunchResponse = { accepted: true; run: Run };
export type LaunchAgent = "scout" | "planner";
function responseError(text: string) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && typeof value.error === "string") return value.error;
  } catch {
    /* Use the original response when it is not JSON. */
  }
  return text;
}
const api = async <T,>(path: string, signal?: AbortSignal, method = "GET"): Promise<T> => {
  const r = await fetch(path, { signal, method });
  if (!r.ok) {
    const error = Error(responseError(await r.text())) as Error & { status: number };
    error.status = r.status;
    throw error;
  }
  return r.json();
};
const apiJson = async <T,>(path: string, body: unknown): Promise<T> => {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const error = Error(responseError(await r.text())) as Error & { status: number };
    error.status = r.status;
    throw error;
  }
  return r.json();
};
type WorkflowState = {
  runs: Run[];
  cursor?: number;
  trace: Event[];
  traceRunId?: string;
  traceCursor?: number;
  hasMore: boolean;
  traceSummary?: TraceSummary;
  error: string;
  launching: boolean;
  deleting: boolean;
  unavailable: boolean;
  selected?: string;
  run?: Run;
  load: (before?: number) => void;
  loadTrace: (id: string, after?: number) => void;
  launch: (request: string, agentName: LaunchAgent) => Promise<void>;
  deleteSelected: () => Promise<void>;
  setSelected: (id?: string) => void;
};
const WorkflowContext = createContext<WorkflowState | undefined>(undefined);
export const useWorkflow = () => {
  const value = useContext(WorkflowContext);
  if (!value) throw new Error("useWorkflow must be used within WorkflowProvider");
  return value;
};

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]),
    [cursor, setCursor] = useState<number>(),
    [selected, setSelected] = useState<string | undefined>(),
    [trace, setTrace] = useState<Event[]>([]),
    [traceRunId, setTraceRunId] = useState<string>(),
    [traceCursor, setTraceCursor] = useState<number>(),
    [hasMore, setHasMore] = useState(false),
    [traceSummary, setTraceSummary] = useState<TraceSummary>(),
    [error, setError] = useState(""),
    [launching, setLaunching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const selectedRef = useRef<string | undefined>(undefined);
  const traceCursorRef = useRef<number | undefined>(undefined);
  const listRequest = useRef<{
    generation: number;
    controller?: AbortController;
    inFlight: boolean;
    queued: boolean;
    queuedBefore?: number;
  }>({
    generation: 0,
    inFlight: false,
    queued: false,
  });
  const traceRequest = useRef<{
    generation: number;
    controller?: AbortController;
    inFlight: boolean;
    queued?: string;
  }>({
    generation: 0,
    inFlight: false,
  });
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    traceCursorRef.current = traceCursor;
  }, [traceCursor]);
  const load = async (before?: number) => {
    const request = listRequest.current;
    if (request.inFlight) {
      request.queued = true;
      request.queuedBefore = before;
      return;
    }
    request.inFlight = true;
    const generation = ++request.generation;
    request.controller?.abort();
    const controller = new AbortController();
    request.controller = controller;
    try {
      const p = await api<Page>(
        `/api/sessions?limit=30${before ? `&before=${before}` : ""}`,
        controller.signal,
      );
      if (generation !== request.generation) return;
      setRuns((x) => {
        if (before)
          return Array.from(new Map([...x, ...p.runs].map((run) => [run.id, run])).values());
        const current = selectedRef.current && x.find((run) => run.id === selectedRef.current);
        return current && !p.runs.some((run) => run.id === current.id)
          ? [current, ...p.runs]
          : p.runs;
      });
      setCursor(p.nextCursor);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(String(e));
    } finally {
      if (generation === request.generation) {
        request.inFlight = false;
        if (request.queued) {
          const queued = request.queuedBefore;
          request.queued = false;
          request.queuedBefore = undefined;
          void load(queued);
        }
      }
    }
  };
  const loadTrace = async (id: string, after?: number) => {
    const request = traceRequest.current;
    if (request.inFlight) {
      request.queued = id;
      return;
    }
    request.inFlight = true;
    const generation = ++request.generation;
    request.controller?.abort();
    const controller = new AbortController();
    request.controller = controller;
    setUnavailable(false);
    try {
      const p = await api<TracePage>(
        `/api/sessions/${encodeURIComponent(id)}/trace?limit=500${after !== undefined ? `&after=${after}` : ""}`,
        controller.signal,
      );
      if (generation !== request.generation || selectedRef.current !== id) return;
      if (p.publicRun)
        setRuns((current) => [p.publicRun!, ...current.filter((run) => run.id !== id)]);
      setTraceRunId(id);
      setUnavailable(false);
      setTraceSummary(p.summary);
      setTrace((x) =>
        after !== undefined
          ? [
              ...x,
              ...p.events.filter(
                (event) =>
                  event.id === undefined || !x.some((existing) => existing.id === event.id),
              ),
            ]
          : p.events,
      );
      if (p.nextCursor !== undefined) setTraceCursor(p.nextCursor);
      setHasMore(p.hasMore);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (
        e instanceof Error &&
        (e as Error & { status?: number }).status === 404 &&
        generation === request.generation &&
        selectedRef.current === id
      ) {
        setUnavailable(true);
        setTraceRunId(id);
        return;
      }
      if (generation === request.generation && selectedRef.current === id)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.controller === controller) {
        request.inFlight = false;
        request.controller = undefined;
        if (generation === request.generation) {
          const queued = request.queued;
          request.queued = undefined;
          if (queued && selectedRef.current === queued)
            void loadTrace(queued, traceCursorRef.current);
        }
      }
    }
  };
  useEffect(() => {
    load();
    let es: EventSource | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const connect = () => {
      es = new EventSource("/api/events");
      es.addEventListener("update", () => {
        load();
        const id = selectedRef.current,
          after = traceCursorRef.current;
        if (id) loadTrace(id, after);
      });
      es.onerror = () => {
        es?.close();
        if (!stopped) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
  useEffect(() => {
    const cancelTraceRequest = () => {
      const request = traceRequest.current;
      request.generation++;
      request.controller?.abort();
      request.controller = undefined;
      request.inFlight = false;
      request.queued = undefined;
    };
    if (!selected) {
      cancelTraceRequest();
      setTrace([]);
      setTraceRunId(undefined);
      setTraceCursor(undefined);
      setTraceSummary(undefined);
      setHasMore(false);
      return;
    }
    cancelTraceRequest();
    setTrace([]);
    setTraceRunId(undefined);
    setTraceCursor(undefined);
    setTraceSummary(undefined);
    setHasMore(false);
    loadTrace(selected);
  }, [selected]);
  const [deleting, setDeleting] = useState(false);
  const deleteSelected = async () => {
    const id = selected;
    if (!id) return;
    setDeleting(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, undefined, "DELETE");
      setRuns((current) => current.filter((item) => item.id !== id));
      if (selectedRef.current === id) void navigate({ to: "/runs", replace: true });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };
  const launch = async (request: string, agentName: LaunchAgent) => {
    setLaunching(true);
    try {
      const response = await apiJson<LaunchResponse>("/api/sessions", {
        request,
        agentName,
      });
      setRuns((current) => [response.run, ...current.filter((run) => run.id !== response.run.id)]);
      void navigate({ to: "/runs/$runId", params: { runId: response.run.id } });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setLaunching(false);
    }
  };
  return (
    <WorkflowContext.Provider
      value={{
        runs,
        cursor,
        trace,
        traceRunId,
        traceCursor,
        hasMore,
        traceSummary,
        error,
        launching,
        deleting,
        unavailable,
        selected,
        run: runs.find((x) => x.id === selected),
        load,
        loadTrace,
        launch,
        deleteSelected,
        setSelected: (id) => {
          selectedRef.current = id;
          setUnavailable(false);
          setSelected(id);
        },
      }}
    >
      {children}
    </WorkflowContext.Provider>
  );
}
