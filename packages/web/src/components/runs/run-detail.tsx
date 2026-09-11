import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

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
import type { AgentTimeline, Event, Run, TraceSummary } from "@/workflow/workflow-context";

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

const MIN_BAR_WIDTH_PERCENT = 2;
type AgentBarGeometry = { left: number; width: number };

function agentBarGeometry(
  lifecycle: AgentTimeline[number],
  domain: { start: number; end: number },
  now: number,
): AgentBarGeometry {
  const started = Date.parse(lifecycle.startedAt);
  const finished = lifecycle.finishedAt ? Date.parse(lifecycle.finishedAt) : now;
  const start = Number.isFinite(started) ? started : domain.start;
  const end = Number.isFinite(finished) ? Math.max(start, finished) : start;
  const span = Math.max(1, domain.end - domain.start);
  const rawLeft = Math.min(100, Math.max(0, ((start - domain.start) / span) * 100));
  const actualWidth = Math.max(0, ((end - start) / span) * 100);
  const width = Math.min(100, Math.max(MIN_BAR_WIDTH_PERCENT, actualWidth));
  return {
    // A point at the end of the domain still needs a visible marker. Shift
    // that marker left rather than letting the width cap collapse to zero.
    left: Math.min(100 - width, rawLeft),
    width,
  };
}

function agentBarDomain(agents: AgentTimeline, now: number) {
  const starts = agents.map(({ startedAt }) => Date.parse(startedAt)).filter(Number.isFinite);
  const ends = agents
    .map(({ startedAt, finishedAt }) => {
      const start = Date.parse(startedAt);
      const end = finishedAt ? Date.parse(finishedAt) : now;
      return Number.isFinite(start) && Number.isFinite(end) ? Math.max(start, end) : undefined;
    })
    .filter((value): value is number => value !== undefined);
  const start = starts.length > 0 ? Math.min(...starts) : 0;
  const end = ends.length > 0 ? Math.max(...ends) : start + 1;
  return { start, end: end > start ? end : start + 1 };
}
export function Unavailable({ onBack }: { onBack: () => void }) {
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">SESSION TRACE</p>
        <h1>Run unavailable</h1>
        <p className="muted">This run was not found or has been deleted.</p>
        <Button variant="outline" onClick={onBack}>
          All sessions
        </Button>
      </div>
    </section>
  );
}
export function Detail({
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
  agents: AgentTimeline;
  onBack: () => void;
  onMore: () => void;
  hasMore: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [agent, setAgent] = useState<string>();
  const now = Date.now();
  const barDomain = agentBarDomain(agents, now);
  useEffect(
    () => setAgent((a) => (a && agents.some(({ name }) => name === a) ? a : agents[0]?.name)),
    [run.id, agents],
  );
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
          <div
            className="gantt"
            tabIndex={0}
            role="region"
            aria-label="Agent timeline"
            aria-describedby="gantt-instructions"
          >
            <p id="gantt-instructions" className="gantt-instructions">
              Use horizontal scrolling to view the complete agent timeline.
            </p>
            {agents.length === 0 && (
              <p className="muted agent-empty">No agents were recorded for this session.</p>
            )}
            {agents.map((lifecycle) => {
              const { name: a, startedAt, finishedAt } = lifecycle;
              const eventCount = trace.filter((e) => e.agentName === a).length;
              const bar = agentBarGeometry(lifecycle, barDomain, now);
              return (
                <Button
                  variant={a === agent ? "secondary" : "ghost"}
                  className={`agent ${a === agent ? "chosen" : ""}`}
                  key={a}
                  onClick={() => setAgent(a)}
                >
                  <span>{a}</span>
                  <div className="bar" aria-hidden="true">
                    <i
                      className={finishedAt ? "bar-completed" : "bar-active"}
                      data-agent={a}
                      data-start-percent={bar.left.toFixed(2)}
                      data-width-percent={bar.width.toFixed(2)}
                      style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                    />
                  </div>
                  <small className="agent-status">
                    {eventCount} events · {finishedAt ? "finished" : "running"}
                  </small>
                  <small className="agent-dates">
                    {date(startedAt)}
                    {finishedAt ? ` – ${date(finishedAt)}` : ""}
                  </small>
                </Button>
              );
            })}
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
                {typeof e.result?.summary === "string" && <p>{e.result.summary}</p>}
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
          {selected.length === 0 && (
            <p className="muted event-empty">
              {agent
                ? "No events recorded for this agent."
                : "No events recorded for this session."}
            </p>
          )}
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
