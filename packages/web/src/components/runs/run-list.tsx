import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { LaunchAgent, Run } from "@/workflow/workflow-context";
export const launchAgents = {
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
} as const;
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
export function List({
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
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = request.trim();
    if (!value || launching) return;
    try {
      await onLaunch(value, agentName);
      setRequest("");
    } catch {}
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
                onChange={(e) => setAgentName(e.target.value as LaunchAgent)}
                disabled={launching}
              >
                <option value="scout">Scout - inspect the repository</option>
                <option value="planner">Planner - prepare a mission plan</option>
              </select>
            </label>
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
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
