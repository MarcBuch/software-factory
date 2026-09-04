import { createFileRoute, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAppHeader } from "@/components/app-shell";
import { List } from "@/components/runs/run-list";
import { agentsQuery } from "@/data/queries";
import { useWorkflow } from "@/workflow/workflow-context";

export const Route = createFileRoute("/runs")({
  component: () => {
    const w = useWorkflow();
    const agents = agentsQuery();
    const { setSelected } = w;
    const navigate = useNavigate();
    const isDetail = useMatches().some((match) => match.routeId === "/runs/$runId");
    useAppHeader(
      "Session traces",
      "Inspect agent execution, tool calls, and resource usage in real time.",
    );
    useEffect(() => {
      if (!isDetail) setSelected(undefined);
    }, [isDetail, setSelected]);
    if (isDetail) return <Outlet />;
    return (
      <List
        runs={w.runs}
        onSelect={(id) => {
          void navigate({ to: "/runs/$runId", params: { runId: id } });
        }}
        onMore={() => w.cursor !== undefined && w.load(w.cursor)}
        hasMore={w.cursor !== undefined}
        launching={w.launching}
        onLaunch={w.launch}
        agents={agents.data?.agents ?? []}
        agentsLoading={agents.isLoading}
        agentsError={agents.error?.message}
      />
    );
  },
});
