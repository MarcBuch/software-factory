import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

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
  usage?: { input: number; output: number; total: number };
  cost?: { amount: number; currency: string };
  result?: { summary: string };
  message?: string;
  phase?: string;
};
type Page = { runs: Run[]; nextCursor?: number };
type TracePage = { runId: string; events: Event[]; nextCursor?: number; hasMore: boolean };
const api = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
  const r = await fetch(path, { signal });
  if (!r.ok) throw Error(await r.text());
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
    [error, setError] = useState("");
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
      setError("");
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
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(String(e));
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
      return;
    }
    cancelTraceRequest();
    setTraceCursor(undefined);
    loadTrace(selected);
  }, [selected]);
  const run = runs.find((x) => x.id === selected);
  const agents = useMemo(
    () => Array.from(new Set(trace.map((e) => e.agentName).filter(Boolean) as string[])),
    [trace],
  );
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="mark">◈</span>
          <div>
            <strong>WORKFLOW</strong>
            <small>SESSION TRACE</small>
          </div>
        </div>
        <div className="live">
          <i /> LIVE MONITOR
        </div>
      </header>
      <main>
        {error && <div className="error">{error}</div>}
        {selected && run ? (
          <Detail
            run={run}
            trace={trace}
            agents={agents}
            onBack={() => setSelected(undefined)}
            onMore={() => loadTrace(selected, traceCursor)}
            hasMore={hasMore}
          />
        ) : (
          <List
            runs={runs}
            onSelect={setSelected}
            onMore={() => cursor && load(cursor)}
            hasMore={!!cursor}
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
}: {
  runs: Run[];
  onSelect: (id: string) => void;
  onMore: () => void;
  hasMore: boolean;
}) {
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
      <div className="section-title">
        <h2>Recent sessions</h2>
        <span>REQUESTS FIRST · NEWEST</span>
      </div>
      <div className="cards">
        {runs.map((r) => (
          <button className="card" key={r.id} onClick={() => onSelect(r.id)}>
            <div className="card-top">
              <span className={`pill ${r.status}`}>{r.status}</span>
              <time>{date(r.startedAt)}</time>
            </div>
            <h3>{String((r.metadata as { request?: string })?.request || r.id)}</h3>
            <code>{r.id}</code>
            <div className="card-foot">
              <span>{duration(r.startedAt, r.finishedAt)}</span>
              <span>
                View trace <b>↗</b>
              </span>
            </div>
          </button>
        ))}
        {!runs.length && <div className="empty">No sessions recorded yet.</div>}
      </div>
      {hasMore && (
        <button className="more" onClick={onMore}>
          Load more sessions
        </button>
      )}
    </>
  );
}
function Detail({
  run,
  trace,
  agents,
  onBack,
  onMore,
  hasMore,
}: {
  run: Run;
  trace: Event[];
  agents: string[];
  onBack: () => void;
  onMore: () => void;
  hasMore: boolean;
}) {
  const [agent, setAgent] = useState<string>();
  useEffect(() => {
    setAgent((current) => (current && agents.includes(current) ? current : agents[0]));
  }, [run.id, agents]);
  const selected = trace.filter((e) => !agent || e.agentName === agent);
  const usage = selected.reduce(
    (a, e) => ({
      input: a.input + (e.usage?.input || 0),
      output: a.output + (e.usage?.output || 0),
      total: a.total + (e.usage?.total || 0),
      cost: a.cost + (e.cost?.amount || 0),
    }),
    { input: 0, output: 0, total: 0, cost: 0 },
  );
  return (
    <>
      <button className="back" onClick={onBack}>
        ← All sessions
      </button>
      <section className="detail-head">
        <div>
          <p className="eyebrow">SESSION TRACE</p>
          <h1>{String((run.metadata as { request?: string })?.request || run.id)}</h1>
          <code>{run.id}</code>
        </div>
        <span className={`pill ${run.status}`}>{run.status}</span>
      </section>
      <div className="metrics">
        <Metric label="DURATION" value={duration(run.startedAt, run.finishedAt)} />
        <Metric label="TOKENS" value={usage.total.toLocaleString()} />
        <Metric label="COST" value={`${usage.cost.toFixed(4)} USD`} />
        <Metric label="EVENTS" value={trace.length.toString()} />
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Agent timeline</h2>
          <span>{agents.length} agents</span>
        </div>
        <div className="gantt">
          {agents.map((a, i) => (
            <button
              className={`agent ${a === agent ? "chosen" : ""}`}
              key={a}
              onClick={() => setAgent(a)}
            >
              <span>{a}</span>
              <div className="bar">
                <i style={{ left: `${i * 7}%`, width: `${Math.max(18, 75 - i * 8)}%` }} />
              </div>
              <small>{trace.filter((e) => e.agentName === a).length} events</small>
            </button>
          ))}
        </div>
      </section>
      <section className="panel events">
        <div className="panel-head">
          <h2>{agent || "All"} events</h2>
          <span>CHRONOLOGICAL</span>
        </div>
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
                  {e.usage.input} in · {e.usage.output} out{" "}
                  {e.cost ? ` · ${e.cost.amount} ${e.cost.currency}` : ""}
                </small>
              )}
            </div>
          </article>
        ))}
        {hasMore && (
          <button className="more" onClick={onMore}>
            Load more events
          </button>
        )}
      </section>
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
    <App />
  </StrictMode>,
);
