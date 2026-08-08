import type { Run, TraceEventApi, TraceSummary } from "@software-factory/contracts";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useState, type ReactNode } from "react";

import { ApiError } from "@/data/api";
import {
  useDelete,
  useLaunch,
  useSessions,
  useSse,
  useTrace,
  type LaunchAgent,
} from "@/data/queries";
export type { LaunchAgent } from "@/data/queries";

export type Event = TraceEventApi;
export type { Run, TraceSummary };
type State = {
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
  launch: (request: string, agent: LaunchAgent) => Promise<void>;
  deleteSelected: () => Promise<void>;
  setSelected: (id?: string) => void;
};
const Context = createContext<State | undefined>(undefined);
export const useWorkflow = () => {
  const value = useContext(Context);
  if (!value) throw new Error("useWorkflow must be used within WorkflowProvider");
  return value;
};
export function WorkflowProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string>();
  const sessions = useSessions();
  const traceQuery = useTrace(selected ?? "");
  const launch = useLaunch();
  const remove = useDelete();
  useSse(selected);
  const runs = sessions.data?.runs ?? [];
  const latest = traceQuery.data?.latest;
  return (
    <Context.Provider
      value={{
        runs,
        cursor: sessions.hasNextPage
          ? sessions.data?.pages[sessions.data.pages.length - 1]?.nextCursor
          : undefined,
        trace: traceQuery.data?.events ?? [],
        traceRunId: selected,
        traceCursor: latest?.nextCursor,
        hasMore: !!traceQuery.hasNextPage,
        traceSummary: latest?.summary,
        error: (sessions.error ?? traceQuery.error)?.message ?? "",
        launching: launch.isPending,
        deleting: remove.isPending,
        unavailable: traceQuery.error instanceof ApiError && traceQuery.error.status === 404,
        selected,
        run: runs.find((run) => run.id === selected) ?? latest?.publicRun,
        load: (before) =>
          before !== undefined ? void sessions.fetchNextPage() : void sessions.refetch(),
        loadTrace: (id, after) => {
          if (id === selected)
            after !== undefined ? void traceQuery.fetchNextPage() : void traceQuery.refetch();
        },
        launch: async (request, agentName) => {
          const response = await launch.mutateAsync({ request, agentName });
          void navigate({ to: "/runs/$runId", params: { runId: response.run.id } });
        },
        deleteSelected: async () => {
          if (selected) {
            await remove.mutateAsync(selected);
            void navigate({ to: "/runs", replace: true });
          }
        },
        setSelected,
      }}
    >
      {children}
    </Context.Provider>
  );
}
