import { ArrowLeft, Radio, Trash2 } from "lucide-react";
import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import "./styles.css";
import { createRoot } from "react-dom/client";

import { ModeToggle } from "@/components/mode-toggle";
import { ThemeProvider } from "@/components/theme-provider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

type Run = {
  id: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  metadata?: unknown;
  failure?: { message: string };
};
type Event = {
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
type TraceSummary = {
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
};
type LaunchResponse = { accepted: true; run: Run };
type LaunchAgent = "scout" | "planner";
const launchAgents: Readonly<
  Record<LaunchAgent, { label: string; detail: string; placeholder: string }>
> = {
  scout: {
    label: "Scout",
    detail: "READ-ONLY RESEARCH",
    placeholder: "What should the scout inspect?",
  },
  planner: {
    label: "Planner",
    detail: "RESEARCH + MISSION PLAN",
    placeholder: "What should the planner prepare?",
  },
};
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
const date = (v?: string) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const duration = (a?: string, b?: string) =>
  a ? `${Math.max(0, ((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000).toFixed(1)}s` : "—";
const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function App() {
  const [runs, setRuns] = useState<Run[]>([]),
    [cursor, setCursor] = useState<number>(),
    [selected, setSelected] = useState<string>(),
    [trace, setTrace] = useState<Event[]>([]),
    [traceCursor, setTraceCursor] = useState<number>(),
    [hasMore, setHasMore] = useState(false),
    [traceSummary, setTraceSummary] = useState<TraceSummary>(),
    [error, setError] = useState(""),
    [launching, setLaunching] = useState(false);
  const selectedRef = useRef<string | undefined>(undefined);
  const runsRef = useRef<Run[]>([]);
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
    runsRef.current = runs;
  }, [runs]);
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
      setSelected((s) =>
        s && (before || p.runs.some((r) => r.id === s) || runsRef.current.some((r) => r.id === s))
          ? s
          : undefined,
      );
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
    try {
      const p = await api<TracePage>(
        `/api/sessions/${encodeURIComponent(id)}/trace?limit=500${after !== undefined ? `&after=${after}` : ""}`,
        controller.signal,
      );
      if (generation !== request.generation || selectedRef.current !== id) return;
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
      if (e instanceof Error && (e as Error & { status?: number }).status === 404) {
        setRuns((current) => current.filter((run) => run.id !== id));
        setSelected((current) => (current === id ? undefined : current));
        return;
      }
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
      setTraceCursor(undefined);
      setTraceSummary(undefined);
      return;
    }
    cancelTraceRequest();
    setTraceCursor(undefined);
    setTraceSummary(undefined);
    loadTrace(selected);
  }, [selected]);
  const run = runs.find((x) => x.id === selected);
  const [deleting, setDeleting] = useState(false);
  const deleteSelected = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(selected)}`, undefined, "DELETE");
      setRuns((current) => current.filter((item) => item.id !== selected));
      setSelected(undefined);
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
      setSelected(response.run.id);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setLaunching(false);
    }
  };
  const agents = useMemo(
    () => Array.from(new Set(trace.map((e) => e.agentName).filter(Boolean) as string[])),
    [trace],
  );
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <Radio className="mark" size={20} />
          <div>
            <strong>WORKFLOW</strong>
            <small>SESSION TRACE</small>
          </div>
        </div>
        <div className="header-actions">
          <div className="live">
            <i /> LIVE MONITOR
          </div>
          <ModeToggle />
        </div>
      </header>
      <main>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {selected && run ? (
          <Detail
            run={run}
            trace={trace}
            traceSummary={traceSummary}
            agents={agents}
            onBack={() => setSelected(undefined)}
            onMore={() => loadTrace(selected, traceCursor)}
            hasMore={hasMore}
            deleting={deleting}
            onDelete={deleteSelected}
          />
        ) : (
          <List
            runs={runs}
            onSelect={setSelected}
            onMore={() => cursor && load(cursor)}
            hasMore={!!cursor}
            launching={launching}
            onLaunch={launch}
          />
        )}
      </main>
    </div>
  );
}
function List({
  runs,
  onSelect,
  onMore,
  hasMore,
  launching,
  onLaunch,
}: {
  runs: Run[];
  onSelect: (id: string) => void;
  onMore: () => void;
  hasMore: boolean;
  launching: boolean;
  onLaunch: (request: string, agentName: LaunchAgent) => Promise<void>;
}) {
  const [request, setRequest] = useState("");
  const [agentName, setAgentName] = useState<LaunchAgent>("scout");
  const agent = launchAgents[agentName];
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = request.trim();
    if (!value || launching) return;
    try {
      await onLaunch(value, agentName);
      setRequest("");
    } catch {
      /* The parent displays the server error and preserves the request for retry. */
    }
  };
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">OBSERVABILITY / WORKFLOWS</p>
          <h1>Session traces</h1>
          <p className="muted">
            Inspect agent execution, tool calls, and resource usage in real time.
          </p>
        </div>
        <div className="stat">
          <b>{runs.length}</b>
          <span>RECENT SESSIONS</span>
        </div>
      </section>
      <Card className="panel">
        <CardContent>
          <form onSubmit={submit} className="grid gap-3">
            <div className="panel-head">
              <div>
                <h2>Launch workflow</h2>
                <span>
                  {agent.label.toUpperCase()} · {agent.detail}
                </span>
              </div>
              <Button type="submit" disabled={launching || !request.trim()}>
                {launching ? "Launching…" : "Launch session"}
              </Button>
            </div>
            <label className="launch-agent">
              <span>Agent</span>
              <select
                value={agentName}
                onChange={(event) => setAgentName(event.target.value as LaunchAgent)}
                disabled={launching}
              >
                <option value="scout">Scout - inspect the repository</option>
                <option value="planner">Planner - prepare a mission plan</option>
              </select>
            </label>
            <Textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder={agent.placeholder}
              aria-label="Workflow request"
              disabled={launching}
            />
          </form>
        </CardContent>
      </Card>
      <div className="section-title">
        <h2>Recent sessions</h2>
        <span>REQUESTS FIRST · NEWEST</span>
      </div>
      <div className="cards">
        {runs.map((r) => (
          <Card className="card" key={r.id}>
            <CardContent>
              <button className="card-button" onClick={() => onSelect(r.id)}>
                <div className="card-top">
                  <Badge
                    variant={
                      r.status === "failed"
                        ? "destructive"
                        : r.status === "succeeded"
                          ? "default"
                          : "secondary"
                    }
                  >
                    {r.status}
                  </Badge>
                  <time>{date(r.startedAt)}</time>
                </div>
                <h3>{String((r.metadata as { request?: string })?.request || r.id)}</h3>
                <code>{r.id}</code>
                <Separator />
                <div className="card-foot">
                  <span>{duration(r.startedAt, r.finishedAt)}</span>
                  <span>
                    View trace <b>↗</b>
                  </span>
                </div>
              </button>
            </CardContent>
          </Card>
        ))}
        {!runs.length && <div className="empty">No sessions recorded yet.</div>}
      </div>
      {hasMore && (
        <Button className="more" variant="outline" onClick={onMore}>
          Load more sessions
        </Button>
      )}
    </>
  );
}
function Detail({
  run,
  trace,
  traceSummary,
  agents,
  onBack,
  onMore,
  hasMore,
  deleting,
  onDelete,
}: {
  run: Run;
  trace: Event[];
  traceSummary?: TraceSummary;
  agents: string[];
  onBack: () => void;
  onMore: () => void;
  hasMore: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [agent, setAgent] = useState<string>();
  useEffect(() => {
    setAgent((current) => (current && agents.includes(current) ? current : agents[0]));
  }, [run.id, agents]);
  const selected = trace.filter((e) => !agent || e.agentName === agent);
  const pageUsage = trace.reduce(
    (a, e) => ({
      input: a.input + (e.usage?.input || 0),
      output: a.output + (e.usage?.output || 0),
      reasoning: a.reasoning + (e.usage?.reasoning || 0),
      cacheRead: a.cacheRead + (e.usage?.cacheRead || 0),
      cacheWrite: a.cacheWrite + (e.usage?.cacheWrite || 0),
      total: a.total + (e.usage?.total || 0),
      cost: a.cost + (e.cost?.amount || 0),
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  );
  return (
    <>
      <Button className="back" variant="ghost" onClick={onBack}>
        <ArrowLeft /> All sessions
      </Button>
      <section className="detail-head">
        <div>
          <p className="eyebrow">SESSION TRACE</p>
          <h1>{String((run.metadata as { request?: string })?.request || run.id)}</h1>
          <code>{run.id}</code>
        </div>
        <div className="header-actions">
          <Badge
            variant={
              run.status === "failed"
                ? "destructive"
                : run.status === "succeeded"
                  ? "default"
                  : "secondary"
            }
          >
            {run.status}
          </Badge>
          {run.failure?.message && <p className="failure-message">{run.failure.message}</p>}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" disabled={deleting}>
                <Trash2 /> Delete session
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the session trace and its stored artifacts. This action
                  cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" disabled={deleting} onClick={onDelete}>
                  <Trash2 /> {deleting ? "Deleting…" : "Delete session"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </section>
      <div className="metrics">
        <Metric label="DURATION" value={duration(run.startedAt, run.finishedAt)} />
        <Metric
          label="TOKENS"
          value={(traceSummary?.usage.total ?? pageUsage.total).toLocaleString()}
        />
        <Metric label="COST" value={`${(traceSummary?.cost ?? pageUsage.cost).toFixed(4)} USD`} />
        <Metric label="EVENTS" value={trace.length.toString()} />
      </div>
      <Card className="panel">
        <CardContent>
          <div className="panel-head">
            <h2>Agent timeline</h2>
            <span>{agents.length} agents</span>
          </div>
          <Separator />
          <div className="gantt">
            {agents.map((a, i) => (
              <Button
                variant={a === agent ? "secondary" : "ghost"}
                className={`agent ${a === agent ? "chosen" : ""}`}
                key={a}
                onClick={() => setAgent(a)}
              >
                <span>{a}</span>
                <div className="bar">
                  <i style={{ left: `${i * 7}%`, width: `${Math.max(18, 75 - i * 8)}%` }} />
                </div>
                <small>{trace.filter((e) => e.agentName === a).length} events</small>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="panel events">
        <CardContent>
          <div className="panel-head">
            <h2>{agent || "All"} events</h2>
            <span>CHRONOLOGICAL</span>
          </div>
          <Separator />
          {selected.map((e, i) => (
            <article className="event" key={`${e.at}-${i}`}>
              <div className="dot" />
              <div className="event-main">
                <div className="event-title">
                  <b>{e.type.replaceAll("_", " ")}</b>
                  <time>{date(e.at)}</time>
                </div>
                {e.tool && <strong className="tool">{e.tool}</strong>}
                {e.message && <p>{e.message}</p>}
                {e.result?.summary && <p>{e.result.summary}</p>}
                {(e.input !== undefined || e.output !== undefined) && (
                  <div className="io">
                    <details>
                      <summary>Input</summary>
                      <pre>{json(e.input)}</pre>
                    </details>
                    <details>
                      <summary>Output</summary>
                      <pre>{json(e.output)}</pre>
                    </details>
                  </div>
                )}
                {e.usage && (
                  <small className="usage">
                    {e.usage.input} in · {e.usage.output} out · {e.usage.reasoning ?? 0} reasoning ·{" "}
                    {(e.usage.cacheRead ?? 0) + (e.usage.cacheWrite ?? 0)} cache{" "}
                    {e.cost ? ` · ${e.cost.amount} ${e.cost.currency}` : ""}
                  </small>
                )}
              </div>
            </article>
          ))}
          {hasMore && (
            <Button className="more" variant="outline" onClick={onMore}>
              Load more events
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
