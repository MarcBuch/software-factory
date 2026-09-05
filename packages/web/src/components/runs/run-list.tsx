import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { Run } from "@/workflow/workflow-context";
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
  workflows,
  workflowsLoading,
  workflowsError,
}: {
  runs: Run[];
  onSelect: (id: string) => void;
  onMore: () => void;
  hasMore: boolean;
  launching: boolean;
  onLaunch: (request: string, workflowId: string) => Promise<void>;
  workflows: Array<{
    id: string;
    description: string;
    label: string;
    detail: string;
    placeholder: string;
  }>;
  workflowsLoading: boolean;
  workflowsError?: string;
}) {
  const [request, setRequest] = useState("");
  const [workflowId, setWorkflowId] = useState("repository-scout");
  const available = workflowsLoading || workflowsError ? [] : workflows;
  const selected = available.find((item) => item.id === workflowId) ?? available[0];
  const workflow = selected;
  useEffect(() => {
    if (selected && selected.id !== workflowId) setWorkflowId(selected.id);
  }, [workflowId, selected]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = request.trim();
    if (!value || launching) return;
    if (!workflow) return;
    try {
      await onLaunch(value, workflowId);
      setRequest("");
    } catch {}
  };
  return (
    <>
      <Card className="panel">
        <CardContent>
          <form onSubmit={submit} className="grid gap-3">
            <div className="panel-head">
              <div>
                <h2>Launch workflow</h2>
                <span>
                  {workflow
                    ? `${workflow.label.toUpperCase()} · ${workflow.detail}`
                    : workflowsLoading
                      ? "Loading workflows…"
                      : workflowsError
                        ? "Workflows unavailable"
                        : "No workflows available"}
                </span>
              </div>
              <Button
                type="submit"
                disabled={
                  launching || !request.trim() || !selected || workflowsLoading || !!workflowsError
                }
              >
                {launching ? "Launching…" : "Launch session"}
              </Button>
            </div>
            <label className="launch-agent">
              <span>Workflow {workflowsLoading ? "(loading…)" : ""}</span>
              {workflowsError ? <small role="alert">{workflowsError}</small> : null}
              {!workflowsLoading && !workflowsError && !available.length ? (
                <small>No workflows available.</small>
              ) : null}
              <select
                value={workflowId}
                onChange={(e) => setWorkflowId(e.target.value)}
                disabled={launching || workflowsLoading || !!workflowsError || !available.length}
              >
                {available.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.id} - {item.description}
                  </option>
                ))}
              </select>
            </label>
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder={workflow?.placeholder ?? "Select an available workflow"}
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
                {r.stages?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1" aria-label="Workflow stages">
                    {[...r.stages]
                      .sort((a, b) => a.ordinal - b.ordinal)
                      .map((stage) => (
                        <Badge key={stage.id} variant="outline">
                          {stage.id}: {stage.status}
                        </Badge>
                      ))}
                  </div>
                ) : null}
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
