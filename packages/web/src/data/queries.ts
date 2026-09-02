import {
  LaunchRequestSchema,
  LaunchResponseSchema,
  DeleteResponseSchema,
  DeletePlanResponseSchema,
  SessionsPageSchema,
  TracePageSchema,
  type Plan,
  type Run,
  type TraceEventApi,
  type TraceSummary,
} from "@software-factory/contracts";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { api, apiSchema } from "./api";
import { mapPlansResponse } from "./plans";

export type SessionsPage = { runs: Run[]; nextCursor?: number };
export type TracePage = {
  runId: string;
  events: TraceEventApi[];
  nextCursor?: number;
  hasMore: boolean;
  summary: TraceSummary;
  publicRun?: Run;
};
export type LaunchAgent = "scout" | "planner";

export const planQuery = () =>
  useQuery({
    queryKey: ["plans"],
    queryFn: async () => mapPlansResponse(await api<unknown>("/api/plans")),
  });

export function useDeletePlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiSchema(`/api/plans/${encodeURIComponent(id)}`, DeletePlanResponseSchema, {
        method: "DELETE",
      }),
    onSuccess: (_, id) => {
      client.setQueryData<Plan[]>(["plans"], (plans) => plans?.filter((plan) => plan.id !== id));
      void client.invalidateQueries({ queryKey: ["plans"] });
    },
  });
}
export const sessionQueryKey = ["sessions"] as const;

function updateSessions(client: ReturnType<typeof useQueryClient>, run: Run) {
  client.setQueryData<InfiniteData<SessionsPage>>(sessionQueryKey, (data) =>
    data
      ? {
          ...data,
          pages: [
            {
              ...data.pages[0],
              runs: [run, ...data.pages[0].runs.filter((item) => item.id !== run.id)],
            },
            ...data.pages.slice(1),
          ],
        }
      : { pages: [{ runs: [run] }], pageParams: [undefined] },
  );
}

export function useSessions() {
  return useInfiniteQuery({
    queryKey: sessionQueryKey,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiSchema(
        `/api/sessions?limit=30${pageParam !== undefined ? `&before=${pageParam}` : ""}`,
        SessionsPageSchema,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor,
    select: (data) => ({
      ...data,
      runs: Array.from(
        new Map(data.pages.flatMap((page) => page.runs).map((run) => [run.id, run])).values(),
      ),
    }),
  });
}
export function useTrace(id: string) {
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ["trace", id],
    enabled: !!id,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiSchema(
        `/api/sessions/${encodeURIComponent(id)}/trace?limit=500${pageParam !== undefined ? `&after=${pageParam}` : ""}`,
        TracePageSchema,
        { signal },
      ),
    getNextPageParam: (page) => (page.hasMore ? page.nextCursor : undefined),
    select: (data) => ({
      ...data,
      events: data.pages
        .flatMap((page) => page.events)
        .reduce<TraceEventApi[]>((events, event) => {
          if (event.id === undefined || !events.some((existing) => existing.id === event.id))
            events.push(event);
          return events;
        }, []),
      latest: data.pages[data.pages.length - 1],
    }),
  });
  useEffect(() => {
    const run = query.data?.latest?.publicRun;
    if (run) updateSessions(client, run);
  }, [client, query.data]);
  return query;
}
export function useLaunch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { request: string; agentName: LaunchAgent }) =>
      apiSchema("/api/sessions", LaunchResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(LaunchRequestSchema.parse(input)),
      }),
    onSuccess: (response) => {
      updateSessions(client, response.run);
      void client.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}
export function useDelete() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiSchema(`/api/sessions/${encodeURIComponent(id)}`, DeleteResponseSchema, {
        method: "DELETE",
      }),
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: ["trace", id] });
      client.setQueryData<InfiniteData<SessionsPage>>(sessionQueryKey, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                runs: page.runs.filter((run) => run.id !== id),
              })),
            }
          : data,
      );
      void client.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}
export function useSse(selected?: string) {
  const client = useQueryClient();
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    let source: EventSource | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      stopped = false;
    const connect = () => {
      const next = new EventSource("/api/events");
      source = next;
      next.addEventListener("update", () => {
        void client.invalidateQueries({ queryKey: sessionQueryKey });
        void client.invalidateQueries({ queryKey: ["plans"] });
        if (selectedRef.current)
          void client.invalidateQueries({ queryKey: ["trace", selectedRef.current] });
      });
      next.onerror = () => {
        next.close();
        if (!stopped && source === next && !retry)
          retry = setTimeout(() => {
            retry = undefined;
            connect();
          }, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, [client]);
}
