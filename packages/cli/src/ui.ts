import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

import { openWorkflowStorage, type PublicRun, type WorkflowStorage } from "./workflow-storage";

export type UiServerOptions = { port?: number; repositoryRoot: string; assetsDirectory?: string };

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const publicRun = (run: Awaited<ReturnType<WorkflowStorage["getRun"]>>): PublicRun | undefined => {
  if (!run) return undefined;
  const metadata =
    run.metadata && typeof run.metadata === "object"
      ? (run.metadata as Record<string, unknown>)
      : {};
  return {
    id: run.id,
    status: run.status,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.failure ? { failure: run.failure } : {}),
    metadata: {
      ...(typeof metadata.request === "string" ? { request: metadata.request } : {}),
      ...(typeof metadata.agentName === "string" ? { agentName: metadata.agentName } : {}),
    },
  };
};

function numberParam(value: string | null, fallback: number) {
  if (value === null || !/^[0-9]+$/.test(value)) return fallback;
  return Number(value);
}

function assetRoot(options: UiServerOptions) {
  return options.assetsDirectory ?? join(import.meta.dir, "..", "ui", "dist");
}

/** Creates the repository-local trace API. It deliberately binds to loopback only. */
export async function startUiServer(options: UiServerOptions) {
  const storage = await openWorkflowStorage(options.repositoryRoot);
  const root = assetRoot(options);
  const clients = new Map<(value: unknown) => void, string>();
  let timer: Timer | undefined;
  const poll = () => {
    const next = JSON.stringify(storage.changeToken());
    for (const [send, baseline] of clients) {
      if (next !== baseline) {
        send({ type: "changed" });
        clients.set(send, next);
      }
    }
  };
  timer = setInterval(poll, 500);

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port ?? 4173,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/api/health") return json({ ok: true });
        if (path === "/api/sessions" || path === "/api/runs") {
          const page = storage.listRuns({
            limit: numberParam(url.searchParams.get("limit"), 50),
            ...(url.searchParams.has("before")
              ? { before: numberParam(url.searchParams.get("before"), 0) }
              : {}),
          });
          return json({ ...page, runs: page.runs.map(publicRun).filter(Boolean) });
        }
        const deleteMatch = path.match(/^\/api\/(?:sessions|runs)\/([^/]+)$/);
        if (request.method === "DELETE" && deleteMatch) {
          const runId = decodeURIComponent(deleteMatch[1]!);
          try {
            await storage.deleteRun(runId);
            return json({ deleted: true, runId });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status = message.includes("not found")
              ? 404
              : message.includes("non-terminal")
                ? 409
                : 500;
            return json({ error: message }, status);
          }
        }
        const traceMatch = path.match(/^\/api\/(?:sessions|runs)\/([^/]+)\/trace$/);
        if (traceMatch) {
          const runId = decodeURIComponent(traceMatch[1]!);
          if (!storage.getRun(runId)) return json({ error: "session not found" }, 404);
          const page = storage.tracePage(runId, {
            ...(url.searchParams.has("after")
              ? { after: numberParam(url.searchParams.get("after"), 0) }
              : {}),
            limit: numberParam(url.searchParams.get("limit"), 100),
          });
          const summary = storage.trace(runId).reduce(
            (total, event) => ({
              usage: {
                input: total.usage.input + (event.usage?.input ?? 0),
                output: total.usage.output + (event.usage?.output ?? 0),
                reasoning: total.usage.reasoning + (event.usage?.reasoning ?? 0),
                cacheRead: total.usage.cacheRead + (event.usage?.cacheRead ?? 0),
                cacheWrite: total.usage.cacheWrite + (event.usage?.cacheWrite ?? 0),
                total: total.usage.total + (event.usage?.total ?? 0),
              },
              cost: total.cost + (event.cost?.amount ?? 0),
            }),
            {
              usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              cost: 0,
            },
          );
          return json({
            runId,
            events: page.events.map(({ runId: _runId, ...event }, index) => ({
              ...event,
              id: page.events[index]!.id,
            })),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            summary,
          });
        }
        if (path === "/api/events" || path === "/api/sessions/events") {
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const send = (value: unknown) =>
                controller.enqueue(
                  encoder.encode(`event: update\ndata: ${JSON.stringify(value)}\n\n`),
                );
              clients.set(send, JSON.stringify(storage.changeToken()));
              send({ type: "ready" });
              request.signal.addEventListener("abort", () => {
                clients.delete(send);
                try {
                  controller.close();
                } catch {}
              });
            },
            cancel() {
              /* client disconnected */
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        if (request.method === "GET" && existsSync(root)) {
          const requested = path === "/" ? "index.html" : path.slice(1);
          const file = normalize(join(root, requested));
          if (relative(root, file) && !relative(root, file).startsWith("..") && existsSync(file)) {
            const body = await readFile(file);
            const type = file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "text/html";
            return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
          }
        }
        return json({ error: "not found" }, 404);
      },
    });
  } catch (error) {
    if (timer) clearInterval(timer);
    clients.clear();
    storage.close();
    throw error;
  }
  return {
    server,
    url: new URL(`http://127.0.0.1:${server.port}`),
    close() {
      if (timer) clearInterval(timer);
      clients.clear();
      storage.close();
      server.stop();
    },
  };
}

export type UiServer = Awaited<ReturnType<typeof startUiServer>>;
