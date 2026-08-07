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
import type { Event, Run, TraceSummary } from "@/workflow/workflow-context";

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
  agents: string[];
  onBack: () => void;
  onMore: () => void;
  hasMore: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [agent, setAgent] = useState<string>();
  useEffect(() => setAgent((a) => (a && agents.includes(a) ? a : agents[0])), [run.id, agents]);
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
