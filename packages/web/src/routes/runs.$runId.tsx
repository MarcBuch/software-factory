import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { Detail, Unavailable } from "@/components/runs/run-detail";
import { useWorkflow } from "@/workflow/workflow-context";

export const Route = createFileRoute("/runs/$runId")({
  component: () => {
    const { runId } = Route.useParams();
    const w = useWorkflow();
    const navigate = useNavigate();
    useEffect(() => w.setSelected(runId), [runId]);
    const agents = Array.from(new Set(w.trace.map((e) => e.agentName).filter(Boolean) as string[]));
    if (w.selected !== runId) return <p className="muted">Loading session…</p>;
    if (w.traceRunId !== runId) return <p className="muted">Loading session…</p>;
    if (w.unavailable) return <Unavailable onBack={() => void navigate({ to: "/runs" })} />;
    if (!w.run) return <p className="muted">Loading session…</p>;
    return (
      <Detail
        run={w.run}
        trace={w.trace}
        traceSummary={w.traceSummary}
        agents={agents}
        onBack={() => void navigate({ to: "/runs" })}
        onMore={() => w.loadTrace(runId, w.traceCursor)}
        hasMore={w.hasMore}
        deleting={w.deleting}
        onDelete={w.deleteSelected}
      />
    );
  },
});
