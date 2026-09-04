import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

import { AgentsResponseSchema, DeletePlanResponseSchema } from "@software-factory/contracts";

import { ensureV2AgentAvailable, OpenCodeAdapter, V2OpenCodeAdapter } from "./backend";
import {
  defaultLifecycleDiagnostic,
  errorDetails,
  type LifecycleDiagnosticSink,
} from "./lifecycle-diagnostics";
import { deletePlanCascadeAtomic, loadPlans } from "./plans";
import { BUILTIN_REGISTRY, lookupRegistry, lookupRoster } from "./roster";
import { recoverFactoryTransaction, withFactoryLock } from "./storage";
import { UiHostManager, type UiHostFactory } from "./ui-host-manager";
import {
  startWorkflow,
  stopWorkflow,
  validateWorkflowInput,
  WorkflowAlreadyRunning,
  type WorkflowLaunch,
} from "./workflow-service";
import { openWorkflowStorage, type PublicRun, type WorkflowStorage } from "./workflow-storage";

export type UiServerOptions = {
  port?: number;
  repositoryRoot: string;
  /** Backend used by UI-launched workflows. The UI intentionally defaults to V2. */
  backend?: UiBackend;
  assetsDirectory?: string;
  /** Test seam for the shared service client. Production creates one manager per server. */
  hostManager?: UiHostManager;
  hostFactory?: UiHostFactory;
  launch?: (
    root: string,
    input: ReturnType<typeof validateWorkflowInput>,
  ) => Promise<WorkflowLaunch>;
  onDiagnostic?: LifecycleDiagnosticSink;
  /** Cancellation grace before unresolved SDK work is abandoned. */
  shutdownGraceMs?: number;
};

const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;

async function settleWithin(promise: Promise<unknown>, timeoutMs: number) {
  let timer: Timer | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const UiBackendValues = ["v1-cli", "v2-client"] as const;
export type UiBackend = (typeof UiBackendValues)[number];

const V2_SDK_REJECTION = 'The "v2-sdk" UI backend is no longer supported; use "v2-client" instead.';

export function parseUiBackend(value: string | undefined): UiBackend {
  const backend = value ?? "v2-client";
  if (backend === "v2-sdk") throw Error(V2_SDK_REJECTION);
  if ((UiBackendValues as readonly string[]).includes(backend)) return backend as UiBackend;
  throw Error(`Invalid UI backend: ${backend}. Expected v1-cli or v2-client`);
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assetRoot(options: UiServerOptions) {
  return options.assetsDirectory ?? join(import.meta.dir, "..", "ui", "dist");
}

/** Creates the repository-local trace API. It deliberately binds to loopback only. */
export async function startUiServer(options: UiServerOptions) {
  // Resolve once so every service request uses the same identity (notably on
  // macOS, where /var and /private/var are aliases).
  const repositoryRoot = await realpath(options.repositoryRoot);
  const backend = parseUiBackend(options.backend);
  (options.onDiagnostic ?? defaultLifecycleDiagnostic)({ event: "backend_selected", backend });
  const storage = await openWorkflowStorage(repositoryRoot);
  // Keep the existing launch seam intact for UI tests and callers that provide their
  // own workflow implementation. The normal UI path owns one shared V2 service client.
  const hostManager =
    backend === "v2-client"
      ? (options.hostManager ??
        (options.launch
          ? undefined
          : new UiHostManager({
              factory: options.hostFactory,
              options: {
                config: { directory: repositoryRoot, project: true },
              },
              onDiagnostic: options.onDiagnostic,
              shutdownGraceMs: options.shutdownGraceMs,
            })))
      : undefined;
  const adapter =
    backend === "v1-cli"
      ? new OpenCodeAdapter()
      : hostManager
        ? new V2OpenCodeAdapter({ hostManager, onDiagnostic: options.onDiagnostic })
        : undefined;
  const root = assetRoot(options);
  const stopRun = async (runId: string) => {
    const diagnostic = options.onDiagnostic ?? defaultLifecycleDiagnostic;
    diagnostic({ event: "restart_stop", backend, runId, state: "started" });
    let serviceClient;
    if (hostManager) {
      try {
        serviceClient = await hostManager.withHost(async (client) => client);
      } catch {
        // Let stopWorkflow persist the conservative orphan failure rather than
        // leaving a restarted service run deceptively marked as running.
      }
    }
    try {
      const result = await stopWorkflow(
        repositoryRoot,
        runId,
        serviceClient ? { serviceClient } : undefined,
      );
      diagnostic({ event: "restart_stop", backend, runId, state: "stopped" });
      return result;
    } catch (error) {
      diagnostic({
        event: "restart_stop",
        backend,
        runId,
        state: "failed",
        ...errorDetails(error),
      });
      throw error;
    }
  };
  const clients = new Map<(value: unknown) => void, string>();
  const completions = new Set<Promise<unknown>>();
  // A set is sufficient for shutdown, but deletion must identify the exact
  // workflow whose cancellation it requested. Keep a settled status per run so
  // rejected completion promises are observed without allowing them to escape.
  const ownedCompletions = new Map<string, Promise<{ ok: true } | { ok: false; error: unknown }>>();
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
        if (request.method === "GET" && path === "/api/agents")
          return json(
            AgentsResponseSchema.parse({
              agents: BUILTIN_REGISTRY.map((entry) => ({
                id: entry.agent.name,
                version: entry.workflow.version,
                purpose: entry.agent.purpose,
                model: entry.agent.model,
                capabilities: entry.agent.capabilities,
                writeBoundary: entry.agent.writeBoundary,
                ...entry.ui,
              })),
            }),
          );
        if (request.method === "GET" && path === "/api/plans") {
          const plans = await withFactoryLock(repositoryRoot, async () => {
            await recoverFactoryTransaction(repositoryRoot);
            return loadPlans(join(repositoryRoot, ".factory", "plans.jsonl"), []);
          });
          const latest = new Map<string, (typeof plans)[number]>();
          for (const plan of plans) {
            const current = latest.get(plan.id);
            if (!current || plan.revision > current.revision) latest.set(plan.id, plan);
          }
          return json([...latest.values()]);
        }
        const deletePlanMatch = path.match(/^\/api\/plans\/([^/]+)$/);
        if (request.method === "DELETE" && deletePlanMatch) {
          const planId = decodeURIComponent(deletePlanMatch[1]!);
          try {
            const result = await deletePlanCascadeAtomic({
              repositoryRoot,
              planFile: join(repositoryRoot, ".factory", "plans.jsonl"),
              missionFile: join(repositoryRoot, ".factory", "missions.jsonl"),
              planId,
            });
            return json(
              DeletePlanResponseSchema.parse({
                deleted: true,
                planId,
                revisionsDeleted: result.revisionsDeleted,
                missionsDeleted: result.missionsDeleted,
              }),
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return json({ error: message }, /not found/i.test(message) ? 404 : 500);
          }
        }
        if (path === "/api/sessions" && request.method === "POST") {
          let input: ReturnType<typeof validateWorkflowInput>;
          try {
            input = validateWorkflowInput(await request.json());
            lookupRegistry(input.agentName);
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
          try {
            const launch = options.launch
              ? await options.launch(repositoryRoot, input)
              : await startWorkflow(repositoryRoot, input, {
                  adapter: adapter!,
                  ...(backend === "v2-client" && hostManager
                    ? {
                        beforeStart: () =>
                          hostManager.withHost((client) =>
                            ensureV2AgentAvailable(
                              client,
                              repositoryRoot,
                              lookupRoster(input.agentName).opencodeAgent,
                              options.onDiagnostic,
                            ),
                          ),
                      }
                    : {}),
                });
            const completion = launch.completion.catch(() => undefined);
            completions.add(completion);
            void completion.finally(() => completions.delete(completion)).catch(() => undefined);
            const ownedCompletion = launch.completion.then(
              () => ({ ok: true as const }),
              (error) => ({ ok: false as const, error }),
            );
            ownedCompletions.set(launch.run.id, ownedCompletion);
            // Keep the settled outcome until deletion has made its decision.
            // Otherwise a rejection just before DELETE looks like an orphan.
            void ownedCompletion.catch(() => undefined);
            if (launch.run.status !== "running")
              return json(
                {
                  accepted: false,
                  run: publicRun(launch.run),
                  error: launch.run.failure?.message ?? "Workflow failed to start",
                },
                500,
              );
            return json({ accepted: true, run: publicRun(launch.run) }, 202);
          } catch (error) {
            if (
              error instanceof WorkflowAlreadyRunning ||
              (error instanceof Error && error.message === "Workflow already running")
            )
              return json({ error: "Workflow already running" }, 409);
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
        }
        if (request.method === "GET" && (path === "/api/sessions" || path === "/api/runs")) {
          const page = storage.listRuns({
            limit: numberParam(url.searchParams.get("limit"), 50),
            ...(url.searchParams.has("before")
              ? { before: numberParam(url.searchParams.get("before"), 0) }
              : {}),
          });
          return json({
            ...page,
            runs: page.runs.map(publicRun).filter(Boolean),
          });
        }
        const deleteMatch = path.match(/^\/api\/(?:sessions|runs)\/([^/]+)$/);
        if (request.method === "DELETE" && deleteMatch) {
          const runId = decodeURIComponent(deleteMatch[1]!);
          try {
            const run = storage.getRun(runId);
            if (
              run?.status === "running" &&
              (run.executionKind === "service" || run.executionKind === "embedded")
            ) {
              const ownedCompletion = ownedCompletions.get(runId);
              const stopped = await stopRun(runId);
              if (stopped?.status === "failed")
                return json(
                  { error: stopped.failure?.message ?? "Unable to safely stop workflow" },
                  409,
                );
              // A restarted service has no local completion callback to own
              // boundary restoration and artifact cleanup. Stopping its SDK
              // session is safe, but deleting its evidence is not.
              if (!ownedCompletion)
                return json(
                  { error: `Workflow completion unavailable after service restart: ${runId}` },
                  409,
                );
            }
            const completion = ownedCompletions.get(runId);
            if (completion) {
              const settled = await Promise.race([
                completion.then((result) => ({ kind: "settled" as const, result })),
                Bun.sleep(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS).then(() => ({
                  kind: "timeout" as const,
                })),
              ]);
              if (settled.kind === "timeout")
                return json({ error: `Workflow completion timed out: ${runId}` }, 409);
              if (!settled.result.ok)
                return json(
                  { error: `Workflow completion failed: ${errorMessage(settled.result.error)}` },
                  409,
                );
            }
            await storage.deleteRun(runId);
            ownedCompletions.delete(runId);
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
          const run = storage.getRun(runId);
          if (!run) return json({ error: "session not found" }, 404);
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
              usage: {
                input: 0,
                output: 0,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
              cost: 0,
            },
          );
          return json({
            runId,
            events: page.events.map((event) => ({ ...event, id: event.id })),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            summary,
            publicRun: publicRun(run),
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
            return new Response(body, {
              headers: { "content-type": `${type}; charset=utf-8` },
            });
          }
          // Client-side routes are extensionless, while missing assets must remain 404s.
          if (path !== "/api" && !path.startsWith("/api/") && !path.includes(".")) {
            const index = join(root, "index.html");
            if (existsSync(index)) {
              return new Response(await readFile(index), {
                headers: { "content-type": "text/html; charset=utf-8" },
              });
            }
          }
        }
        return json({ error: "not found" }, 404);
      },
    });
  } catch (error) {
    if (timer) clearInterval(timer);
    clients.clear();
    storage.close();
    await hostManager?.close();
    throw error;
  }
  return {
    server,
    url: new URL(`http://127.0.0.1:${server.port}`),
    async close() {
      const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      if (timer) clearInterval(timer);
      clients.clear();
      // Cancel owned embedded sessions before closing the shared host. Otherwise
      // the host disappears while SDK prompts remain active and their runs leak.
      const active = storage
        .listRuns({ limit: 200 })
        .runs.filter(
          (run) =>
            run.status === "running" &&
            (run.executionKind === "service" || run.executionKind === "embedded"),
        );
      // Cancellation is deliberately bounded: SDK create/prompt/wait/list
      // calls can ignore abort and otherwise hold the server forever.
      await settleWithin(Promise.allSettled(active.map((run) => stopRun(run.id))), shutdownGraceMs);
      await settleWithin(Promise.allSettled(completions), shutdownGraceMs);
      server.stop();
      await hostManager?.close();
      storage.close();
    },
  };
}

export type UiServer = Awaited<ReturnType<typeof startUiServer>>;
