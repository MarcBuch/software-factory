import { createFileRoute, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { List } from "@/components/runs/run-list";
import { useWorkflow } from "@/workflow/workflow-context";

export const Route = createFileRoute("/runs")({
  component: () => {
    const w = useWorkflow();
    const navigate = useNavigate();
    const isDetail = useMatches().some((match) => match.routeId === "/runs/$runId");
    useEffect(() => {
      if (!isDetail) w.setSelected(undefined);
    }, [isDetail, w.setSelected]);
    if (isDetail) return <Outlet />;
    return (
      <List
        runs={w.runs}
        onSelect={(id) => {
          void navigate({ to: "/runs/$runId", params: { runId: id } });
        }}
        onMore={() => w.cursor && w.load(w.cursor)}
        hasMore={!!w.cursor}
        launching={w.launching}
        onLaunch={w.launch}
      />
    );
  },
});
