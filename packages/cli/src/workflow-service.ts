import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { AgentExecutor, type AgentExecutorLike } from "./agent-executor";
import type { AgentRuntimeAdapter, BackendProcess } from "./agent-runtime";
import { OpenCodeAdapter, type V2Client } from "./backend";
import type { CompletionOutcome } from "./completion";
import { captureGitBoundary, compareGitBoundary, restoreGitBoundary } from "./git-boundary";
import { plannerActions } from "./planner-actions";
import { lookupRegistry, lookupRoster, renderAgentPrompts } from "./roster";
import { recoverFactoryTransaction, replaceFactoryPair, withFactoryLock } from "./storage";
import { EffectiveRunDefinitionSchema, WorkflowInputSchema, type WorkflowInput } from "./workflow";
import { WorkflowRunner } from "./workflow-runner";
import { openWorkflowStorage, type RunRecord } from "./workflow-storage";

const exec = promisify(execFile);
export class WorkflowAlreadyRunning extends Error {
  constructor() {
    super("Workflow already running");
  }
}

export type WorkflowLaunch = {
  run: RunRecord;
  completion: Promise<RunRecord | undefined>;
};

export type WorkflowServiceOptions = {
  adapter?: AgentRuntimeAdapter;
  executorFactory?: (adapter: AgentRuntimeAdapter) => AgentExecutorLike;
  /** Runs after the repository lock is acquired and before a run is persisted. */
  beforeStart?: () => Promise<void>;
};

export function validateRuntimeRequirements(
  agent: ReturnType<typeof lookupRegistry>,
  adapter: Pick<AgentRuntimeAdapter, "capabilities" | "id">,
) {
  const required = agent.runtime.capabilities;
  const available = new Set(adapter.capabilities);
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length)
    throw new Error(
      `Adapter ${adapter.id ?? "unknown"} cannot run agent ${agent.agent.name}; missing capabilities: ${missing.join(", ")}`,
    );
}

type WorkflowOutcome = CompletionOutcome;
type WorkflowFailure = NonNullable<RunRecord["failure"]>;
type WorkflowLock = { release: () => Promise<void> };

const activeProcesses = new Map<string, BackendProcess>();

async function lockOwner(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as { pid: number; token: string };
  } catch {
    return undefined;
  }
}

async function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWorkflowLock(root: string, waitForExisting = false): Promise<WorkflowLock> {
  const file = join(root, ".factory", "workflow.lock");
  const token = crypto.randomUUID();
  await mkdir(join(file, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      return {
        async release() {
          await handle.close();
          if ((await lockOwner(file))?.token === token) await rm(file, { force: true });
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await lockOwner(file);
      if (!owner || (await processAlive(owner.pid))) {
        if (waitForExisting) {
          await Bun.sleep(10);
          attempt -= 1;
          continue;
        }
        throw new WorkflowAlreadyRunning();
      }
      try {
        const stale = `${file}.stale.${crypto.randomUUID()}`;
        await rename(file, stale);
        await rm(stale, { force: true });
      } catch (renameError: any) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new WorkflowAlreadyRunning();
}

async function processIdentity(pid: number, command: readonly string[]) {
  const { stdout } = await exec("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)]);
  const match = stdout.trim().match(/^(.{24})\s+(.*)$/s);
  if (!match) throw Error(`Unable to verify backend process ${pid}`);
  return JSON.stringify({
    pid,
    start: match[1].trim(),
    command: match[2].trim(),
    expected: command.join(" "),
  });
}

/** Stops a run owned by this server. Service runs are cancelled through the SDK;
 * persisted service records without a handle are treated as orphaned after restart.
 * Legacy embedded records retain the same conservative behavior. */
export async function stopWorkflow(
  repositoryRoot: string,
  runId: string,
  options?: { serviceClient?: V2Client },
) {
  const storage = await openWorkflowStorage(repositoryRoot);
  try {
    const run = storage.getRun(runId);
    if (!run) throw Error(`Run not found: ${runId}`);
    if (run.status !== "running") return run;
    const processRun = activeProcesses.get(`${resolve(repositoryRoot)}:${runId}`);
    const service =
      run.executionKind === "service" ||
      run.executionKind === "embedded" ||
      processRun?.executionKind === "service" ||
      processRun?.executionKind === "embedded";
    if (!service && processRun) {
      if (!run.childPid || run.childPid !== processRun.pid || !run.processIdentity)
        throw Error("Cannot safely stop unverifiable process");
      const current = await processIdentity(processRun.pid, processRun.command);
      if (current !== run.processIdentity) throw Error("Stale backend process identity");
      const cancellation = storage.requestCancellation(runId);
      if (!cancellation.accepted) return cancellation.run;
      processRun.cancel();
      await processRun.exit;
      return storage.finishRun(runId, "cancelled");
    }
    if (!service) throw Error("Cannot safely stop unverifiable process");
    // A service session outlives this UI process. On restart there is no local
    // BackendProcess, so use the authenticated client to verify and interrupt
    // exactly the persisted session; never attempt to resume its workflow.
    if (run.executionKind === "service" && !processRun) {
      if (!run.sessionId || !options?.serviceClient) {
        return storage.failRun(runId, {
          code: "BACKEND_FAILURE",
          message:
            "Cannot safely stop service session: persisted session or service is unavailable",
        });
      }
      const cancellation = storage.requestCancellation(runId);
      if (!cancellation.accepted) return cancellation.run;
      try {
        const active = await options.serviceClient.session.active();
        if (active && Object.prototype.hasOwnProperty.call(active, run.sessionId))
          await options.serviceClient.session.interrupt({ sessionID: run.sessionId });
        return storage.finishRun(runId, "cancelled");
      } catch (error) {
        return storage.failRun(runId, {
          code: "BACKEND_FAILURE",
          message: `Cannot safely stop service session ${run.sessionId}: ${errorMessage(error)}`,
        });
      }
    }
    const cancellation = storage.requestCancellation(runId);
    if (!cancellation.accepted) return cancellation.run;
    processRun?.cancel();
    if (processRun) await processRun.exit;
    return storage.finishRun(runId, "cancelled");
  } finally {
    storage.close();
  }
}

function workflowFailure(
  outcome: WorkflowOutcome,
  boundaryFailure?: string,
  restorationFailure?: string,
): WorkflowFailure | undefined {
  if (restorationFailure) return { code: "RESTORATION_FAILURE", message: restorationFailure };
  if (boundaryFailure) return { code: "BOUNDARY_VIOLATION", message: boundaryFailure };
  if (outcome.kind === "agent_failure")
    return { code: "AGENT_FAILURE", message: outcome.result.summary };
  if (outcome.kind === "invalid_output_exhausted")
    return { code: "INVALID_OUTPUT", message: outcome.reason };
  if (outcome.kind === "backend_failure") {
    return {
      code: "BACKEND_FAILURE",
      message: `Backend exited with ${outcome.exit.code ?? outcome.exit.signal ?? "unknown"}`,
    };
  }
  return undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function delegatedExplorer(outcome: WorkflowOutcome) {
  const starts = new Set<string>();
  const failed = new Set<string>();
  for (const event of outcome.events) {
    const normalized = event.normalized;
    // V2 currently emits the generic name "tool". It is still safe to
    // recognize it because the delegation identity is in the tool input,
    // not in the model's prose (or the generic tool name).
    if (
      normalized?.type !== "tool_call" ||
      !["task", "tool"].includes(normalized.tool) ||
      !normalized.spanId
    )
      continue;
    const input =
      normalized.input && typeof normalized.input === "object"
        ? (normalized.input as Record<string, unknown>)
        : undefined;
    const isExplorerInput =
      input?.subagent_type === "codebase-explorer" || input?.agent === "codebase-explorer";
    if (isExplorerInput) starts.add(normalized.spanId);
    if (normalized.phase !== "finish") continue;
    const output = normalized.output;
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      !["completed", "success"].includes(
        String((output as Record<string, unknown>).status ?? "").toLowerCase(),
      )
    ) {
      failed.add(normalized.spanId);
      continue;
    }
    const successfulStatus =
      output &&
      typeof output === "object" &&
      ["completed", "success"].includes(
        String((output as Record<string, unknown>).status ?? "").toLowerCase(),
      );
    // V2 successful subagent results are often text (or text content parts),
    // while failed results are error objects. A matching start call is the
    // evidence that ties that result to the requested explorer.
    const textualResult =
      typeof output === "string" ||
      (Array.isArray(output) &&
        output.some(
          (part) =>
            typeof part === "string" ||
            (part &&
              typeof part === "object" &&
              typeof (part as Record<string, unknown>).text === "string"),
        ));
    if (
      (successfulStatus || textualResult) &&
      starts.has(normalized.spanId) &&
      !failed.has(normalized.spanId)
    )
      return true;
  }
  return false;
}

export function completedVisualization(outcome: WorkflowOutcome) {
  const started = new Set<string>();
  const failed = new Set<string>();
  for (const event of outcome.events) {
    const normalized = event.normalized;
    if (normalized?.type !== "tool_call" || !normalized.spanId) continue;
    const input =
      normalized.input && typeof normalized.input === "object"
        ? (normalized.input as Record<string, unknown>)
        : undefined;
    const isVisualization =
      input?.name === "visualize-change" || input?.skill === "visualize-change";
    if (normalized.phase === "start") {
      if (isVisualization && ["skill", "tool"].includes(normalized.tool))
        started.add(normalized.spanId);
      continue;
    }
    if (normalized.phase !== "finish") continue;
    // V1 emits a completed tool_use as one event, carrying both its input and
    // output. Treat that event as the paired start/finish without accepting
    // completion text that was not tied to a requested skill call.
    if (isVisualization && ["skill", "tool"].includes(normalized.tool))
      started.add(normalized.spanId);
    // A failed or otherwise terminal call can never be rescued by a later
    // success event with the same id.
    const output = normalized.output;
    const status =
      output && typeof output === "object" && !Array.isArray(output)
        ? String((output as Record<string, unknown>).status ?? "").toLowerCase()
        : "";
    if (
      status === "failed" ||
      status === "failure" ||
      status === "denied" ||
      status === "error" ||
      (output !== undefined && typeof output === "object" && !Array.isArray(output) && !status)
    ) {
      failed.add(normalized.spanId);
      continue;
    }
    if (!started.has(normalized.spanId) || failed.has(normalized.spanId)) continue;
    const successfulStatus = ["completed", "success"].includes(status);
    const textualContent =
      typeof output === "string" ||
      (Array.isArray(output) &&
        output.some(
          (part) =>
            typeof part === "string" ||
            (part &&
              typeof part === "object" &&
              typeof (part as Record<string, unknown>).text === "string"),
        ));
    if (successfulStatus || textualContent) return true;
  }
  return false;
}

const MAX_ARCHITECTURE_BYTES = 1024 * 1024;
async function validateArchitectureArtifact(root: string, path: string) {
  const file = join(root, path);
  const factory = join(root, ".factory");
  const architecture = join(factory, "architecture");
  for (const directory of [factory, architecture]) {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("Architecture artifact has unsafe parent directory");
  }
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw Error("Architecture artifact must be a regular file");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw Error("Architecture artifact must be a regular file");
    const html = (await handle.readFile()).toString("utf8");
    await handle.close();
    if (Buffer.byteLength(html) > MAX_ARCHITECTURE_BYTES)
      throw Error("Architecture artifact is too large");
    if (
      !/^<!doctype html>/i.test(html) ||
      !/<html\b/i.test(html) ||
      !/<head\b/i.test(html) ||
      !/<body\b/i.test(html) ||
      !/<\/html>/i.test(html) ||
      !/<\/head>/i.test(html) ||
      !/<\/body>/i.test(html)
    )
      throw Error("Architecture artifact must be standalone HTML");
    if (
      /<\s*(?:script|iframe|object|embed|form|base|link|svg|math)\b|\bon[a-z]+\s*=|\b(?:src|srcset|action|formaction|poster|data)\s*=|\b(?:href)\s*=\s*["']\s*(?!#)|@import\b|url\s*\(/i.test(
        html,
      )
    )
      throw Error("Architecture artifact contains unsafe HTML");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

type ArchitectureState = Readonly<Record<string, string>>;
async function architectureState(root: string): Promise<ArchitectureState> {
  const directory = join(root, ".factory", "architecture");
  const parent = await lstat(join(root, ".factory")).catch(() => undefined);
  if (parent && (parent.isSymbolicLink() || !parent.isDirectory()))
    throw Error("Unsafe Factory architecture parent");
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return {};
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("Unsafe architecture directory");
  const state: Record<string, string> = {};
  const walk = async (current: string, prefix: string) => {
    for (const name of await readdir(current)) {
      const entry = join(current, name);
      const entryStat = await lstat(entry);
      const key = prefix ? `${prefix}/${name}` : name;
      if (entryStat.isSymbolicLink()) throw Error("Unsafe architecture entry");
      if (entryStat.isDirectory()) await walk(entry, key);
      else if (entryStat.isFile()) state[key] = (await readFile(entry)).toString("base64");
      else throw Error("Unsafe architecture entry");
    }
  };
  await walk(directory, "");
  return state;
}

function architectureMutated(before: ArchitectureState, after: ArchitectureState, runFile: string) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of names) {
    if (name === runFile && before[name] === undefined) continue;
    if (before[name] !== after[name]) return true;
  }
  return false;
}

type FactoryFile = Readonly<{ content?: string }>;
type FactoryState = Readonly<{ plans: FactoryFile; missions: FactoryFile }>;
export class FactoryStateConcurrencyConflict extends Error {
  constructor() {
    super("Factory plan or mission state changed concurrently; refusing to restore it");
    this.name = "FactoryStateConcurrencyConflict";
  }
}
async function factoryState(root: string): Promise<FactoryState> {
  return withFactoryLock(root, async () => {
    await recoverFactoryTransaction(root);
    return factoryStateUnlocked(root);
  });
}
async function factoryStateUnlocked(root: string): Promise<FactoryState> {
  const read = async (name: string): Promise<FactoryFile> => {
    const file = join(root, ".factory", name);
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return {};
    if (stat.isSymbolicLink()) throw Error(`Unsafe Factory state symlink: ${name}`);
    if (!stat.isFile()) throw Error(`Unsafe Factory state file: ${name}`);
    return { content: await readFile(file, "utf8") };
  };
  return { plans: await read("plans.jsonl"), missions: await read("missions.jsonl") };
}
export async function restoreFactoryState(
  root: string,
  state: FactoryState,
  expectedState: FactoryState = state,
) {
  await withFactoryLock(root, async () => {
    await recoverFactoryTransaction(root);
    const current = await factoryStateUnlocked(root);
    if (JSON.stringify(current) !== JSON.stringify(expectedState))
      throw new FactoryStateConcurrencyConflict();
    await replaceFactoryPair(
      root,
      state.plans.content ?? undefined,
      state.missions.content ?? undefined,
      current.plans.content ?? undefined,
      current.missions.content ?? undefined,
    );
    if (JSON.stringify(await factoryStateUnlocked(root)) !== JSON.stringify(state))
      throw Error("Factory state restoration failed");
  });
}

async function terminalFailure(
  storage: Awaited<ReturnType<typeof openWorkflowStorage>>,
  run: RunRecord,
  error: unknown,
) {
  const message = errorMessage(error);
  const failed = storage.failIfRunning(run.id, {
    code: message.includes("Git boundary violation")
      ? "BOUNDARY_VIOLATION"
      : message.includes("spawn") || message.includes("ENOENT")
        ? "BACKEND_FAILURE"
        : "WORKFLOW_FAILURE",
    message,
  });
  try {
    storage.clearAgentProcess(run.id);
  } catch {
    /* best effort */
  }
  return failed;
}

async function enforceGitBoundary(
  boundary: Awaited<ReturnType<typeof captureGitBoundary>>,
  boundaryOptions: Parameters<typeof compareGitBoundary>[1],
) {
  const comparison = await compareGitBoundary(boundary, boundaryOptions);
  if (comparison.equal) return { comparison, failure: undefined, restorationFailure: undefined };
  const failure = `Git boundary violation: ${JSON.stringify(comparison)}`;
  try {
    await restoreGitBoundary(boundary, boundaryOptions, boundaryOptions);
    return { comparison, failure, restorationFailure: undefined };
  } catch (error) {
    return { comparison, failure, restorationFailure: errorMessage(error) };
  }
}

export async function startWorkflow(
  repositoryRoot: string,
  input: WorkflowInput,
  options: WorkflowServiceOptions = {},
): Promise<WorkflowLaunch> {
  // Keep one filesystem identity throughout locking, storage, git boundaries,
  // and backend invocation. resolve() alone preserves macOS /var aliases.
  const root = await realpath(resolve(repositoryRoot));
  const parsed = WorkflowInputSchema.parse(input);
  const registry = lookupRegistry(parsed.agentName);
  const agent = registry.agent;
  let lock: WorkflowLock;
  const adapter: AgentRuntimeAdapter =
    options.adapter ?? new OpenCodeAdapter({ executable: process.env.FACTORY_OPENCODE_EXECUTABLE });
  validateRuntimeRequirements(registry, adapter);
  lock = await acquireWorkflowLock(root, adapter.supportsConcurrent === true);

  let storage: Awaited<ReturnType<typeof openWorkflowStorage>> | undefined;
  let run: RunRecord | undefined;
  let processStarted = false;
  try {
    await options.beforeStart?.();
    storage = await openWorkflowStorage(root);
    const allowPreExistingUntracked = registry.policy.allowPreExistingUntracked;
    const boundaryOptions = Object.freeze({
      repositoryRoot: root,
      runtimeDirectory: join(root, ".factory"),
      allowPreExistingUntracked,
      ...(process.env.FACTORY_TEST_RESTORE_FAILURE
        ? {
            restoreFailure: (step: string) => {
              if (step === process.env.FACTORY_TEST_RESTORE_FAILURE)
                throw Error(`Injected restoration failure: ${step}`);
            },
          }
        : {}),
    });
    const boundary = await captureGitBoundary(boundaryOptions);
    const initialFactoryState = await factoryState(root);
    const initialArchitectureState = await architectureState(root);
    const preliminary = renderAgentPrompts(agent.name, parsed.request, {});
    run = await storage.createRun({
      systemPrompt: preliminary.systemPrompt,
      userPrompt: preliminary.userPrompt,
      metadata: {
        agent: agent.name,
        agentName: agent.name,
        request: parsed.request,
      },
      stages: registry.workflow.stages,
    });
    const prompts = renderAgentPrompts(agent.name, parsed.request, {
      runId: run.id,
      storagePath: relative(root, run.files.directory),
      expectedArtifactPath: `.factory/architecture/${run.id}.html`,
    });
    await Bun.write(run.files.systemPrompt, prompts.systemPrompt);
    await Bun.write(run.files.userPrompt, prompts.userPrompt);
    await storage.writeDefinition(run.id, {
      schemaVersion: 1,
      agent: { id: agent.name, version: registry.workflow.version, provenance: "builtin" },
      workflow: registry.workflow,
      runtime: {
        ...registry.runtime,
        id: registry.runtime.id,
        adapterId: adapter.id,
        capabilities: adapter.capabilities,
      },
      policy: {
        capabilities: registry.runtime.capabilities,
        writeBoundary: agent.writeBoundary,
        allowPreExistingUntracked,
      },
      completionContract: registry.completionContract,
    });
    run = storage.startRun(run.id)!;
    processStarted = true;

    let processRun: BackendProcess;
    try {
      processRun = adapter.start({
        repositoryRoot: root,
        runId: run.id,
        agent: {
          id: agent.name,
          systemPrompt: prompts.systemPrompt,
          userPrompt: prompts.userPrompt,
          model: registry.runtime.model ?? agent.model,
          capabilities: registry.runtime.capabilities,
          writeBoundary: agent.writeBoundary,
          completionContract: registry.completionContract,
          adapterProfile: registry.runtime.profile,
        },
        prompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        model: registry.runtime.model ?? agent.model,
      });
    } catch (error) {
      // The backend may perform work synchronously while being started (this is
      // particularly relevant to embedded V2 adapters).  Enforce the same
      // post-run boundary even when startup fails before completeWorkflow owns
      // the process.
      let message = errorMessage(error);
      try {
        const comparison = await compareGitBoundary(boundary, boundaryOptions);
        if (!comparison.equal) {
          message = `BACKEND_FAILURE; Git boundary violation: ${JSON.stringify(comparison)}`;
          try {
            await restoreGitBoundary(boundary, boundaryOptions, boundaryOptions);
          } catch (restoreError) {
            message += `; Boundary restoration failed: ${errorMessage(restoreError)}`;
          }
        }
      } catch (boundaryError) {
        message += `; Git boundary check failed: ${errorMessage(boundaryError)}`;
      }
      const failed = storage.finishRun(run.id, "failed", {
        code: "BACKEND_FAILURE",
        message,
      });
      storage.close();
      await lock.release();
      return { run: failed ?? run, completion: Promise.resolve(failed) };
    }

    let identity: string | undefined;
    try {
      identity = await processIdentity(processRun.pid, processRun.command);
    } catch {
      /* process may have exited */
    }
    storage.setAgentProcess(run.id, {
      agentName: agent.name,
      ...(processRun.executionKind === "service" || processRun.executionKind === "embedded"
        ? { executionKind: processRun.executionKind }
        : {
            pid: processRun.pid,
            ...(identity ? { identity } : {}),
            executionKind: "subprocess" as const,
          }),
    });
    storage.appendTrace({
      runId: run.id,
      at: new Date().toISOString(),
      type: "agent_started",
      agentName: agent.name,
    });

    activeProcesses.set(`${root}:${run.id}`, processRun);
    // Keep the repository lock until completeWorkflow has finished its boundary
    // comparison and any restoration. Embedded sessions may share a host, but
    // mutating workflows in one repository must not overlap their snapshots.
    const completion = completeWorkflow({
      storage,
      run,
      processRun,
      agent,
      prompts,
      boundary,
      initialFactoryState,
      initialArchitectureState,
      root,
      lock,
      adapter,
      executorFactory: options.executorFactory,
      boundaryOptions,
    });
    return { run, completion };
  } catch (error) {
    if (storage && run && processStarted) {
      const failed = await terminalFailure(storage, run, error);
      storage.close();
      await lock.release();
      return { run: failed ?? run, completion: Promise.resolve(failed) };
    }
    storage?.close();
    await lock.release();
    throw error;
  }
}

async function completeWorkflow(args: {
  storage: Awaited<ReturnType<typeof openWorkflowStorage>>;
  run: RunRecord;
  processRun: BackendProcess;
  agent: ReturnType<typeof lookupRoster>;
  prompts: ReturnType<typeof renderAgentPrompts>;
  boundary: Awaited<ReturnType<typeof captureGitBoundary>>;
  initialFactoryState: FactoryState;
  initialArchitectureState: ArchitectureState;
  root: string;
  lock: WorkflowLock;
  adapter: AgentRuntimeAdapter;
  executorFactory?: (adapter: AgentRuntimeAdapter) => AgentExecutorLike;
  boundaryOptions: Parameters<typeof compareGitBoundary>[1];
}): Promise<RunRecord | undefined> {
  const {
    storage,
    run,
    processRun,
    agent,
    prompts,
    boundary,
    initialFactoryState,
    initialArchitectureState,
    root,
    lock,
    adapter,
    boundaryOptions,
  } = args;
  const currentArtifact = join(root, ".factory", "architecture", `${run.id}.html`);
  try {
    if (agent.name === "planner" && (await lstat(currentArtifact).catch(() => undefined)))
      throw Error("Planner architecture artifact must not pre-exist");
    // The definition is the immutable run snapshot.  Never re-read the live
    // registry after launch: registry edits must not change a run in flight.
    const definition = EffectiveRunDefinitionSchema.parse(
      JSON.parse(await Bun.file(run.files.definition).text()),
    );
    // The persisted definition is the immutable policy authority for every
    // completion, cancellation, and error path.
    const boundaryPolicy = boundaryOptions.allowPreExistingUntracked ?? false;
    const runtime = definition.runtime;
    const invocation = {
      repositoryRoot: root,
      allowPreExistingUntracked: boundaryPolicy,
      runId: run.id,
      agent: {
        id: agent.name,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        model: runtime.model ?? agent.model,
        capabilities: runtime.capabilities,
        writeBoundary: agent.writeBoundary,
        completionContract: definition.completionContract,
        adapterProfile: runtime.profile,
      },
      prompt: prompts.userPrompt,
      systemPrompt: prompts.systemPrompt,
      model: runtime.model ?? agent.model,
    };
    // The process was created during launch so ownership remains with this
    // workflow.  Inject a narrow adapter facade rather than erasing its type.
    const executor =
      args.executorFactory?.({
        id: adapter.id,
        capabilities: adapter.capabilities,
        supportsConcurrent: adapter.supportsConcurrent,
        start: () => processRun,
      }) ??
      new AgentExecutor({
        id: adapter.id,
        capabilities: adapter.capabilities,
        supportsConcurrent: adapter.supportsConcurrent,
        start: () => processRun,
      });
    let outcome: WorkflowOutcome | undefined;
    let result: any;
    const runner = new WorkflowRunner({
      // Legacy snapshots predate workflow stage definitions; retain their
      // historical registry fallback, while every current run uses its stored
      // immutable stage list.
      stages: definition.workflow.stages ?? lookupRegistry(agent.name).workflow.stages,
      actions:
        agent.name === "planner"
          ? plannerActions({
              root,
              runId: run.id,
              get result() {
                return result;
              },
              get outcome() {
                return outcome ?? { events: [] };
              },
              initialArchitectureState,
              architectureState,
              validateArchitectureArtifact,
              architectureMutated,
              delegatedExplorer: (value: any) => delegatedExplorer(value),
              completedVisualization: (value: any) => completedVisualization(value),
              initialFactoryState,
              factoryState: () => factoryState(root),
              restoreFactoryState: (state, expected) => {
                if (process.env.FACTORY_TEST_RESTORE_FAILURE)
                  return Promise.reject(
                    Error(
                      `Injected restoration failure: ${process.env.FACTORY_TEST_RESTORE_FAILURE}`,
                    ),
                  );
                return restoreFactoryState(root, state, expected);
              },
              onDraft: (id) => {
                result = {
                  ...result,
                  summary: `${result.summary}\n\nDraft plan: ${id}`,
                  notes: [...result.notes, `Created draft plan ${id}`],
                };
              },
            })
          : {},
      transition: (stage) => {
        const current = storage.getRun(run.id);
        if (current?.status === "running")
          storage.transitionStage(run.id, stage.id, stage.status, stage.failure);
      },
      isCancelled: () => storage.getRun(run.id)?.cancellationRequested === true,
      runAgent: async (stage) => {
        outcome = await executor.execute(
          { ...invocation, agent: { ...invocation.agent, id: stage.agent } },
          async (event, activeProcess) => {
            await storage.appendRaw(run.id, event);
            if (event.normalized) storage.appendTrace(event.normalized);
            let identity: string | undefined;
            try {
              identity = await processIdentity(activeProcess.pid, activeProcess.command);
            } catch {
              /* exited between event and ps */
            }
            storage.setAgentProcess(run.id, {
              agentName: agent.name,
              ...(activeProcess.executionKind === "service" ||
              activeProcess.executionKind === "embedded"
                ? { executionKind: activeProcess.executionKind }
                : {
                    pid: activeProcess.pid,
                    ...(identity ? { identity } : {}),
                    executionKind: "subprocess" as const,
                  }),
              // Storage keeps its legacy column for migration compatibility; the
              // backend seam itself remains provider-neutral.
              sessionId: event.executionId,
            });
          },
        );
        if (outcome && "result" in outcome) result = outcome.result;
        if (outcome.kind !== "success")
          throw Error(
            outcome.kind === "invalid_output_exhausted"
              ? outcome.reason
              : outcome.kind === "agent_failure"
                ? outcome.result.summary
                : "Backend failed before producing an agent result",
          );
        if (result?.status !== "success") throw Error(result?.summary ?? "Agent stage failed");
      },
    });
    await runner.run();
    const finalOutcome: WorkflowOutcome = outcome ?? {
      kind: "backend_failure",
      attempts: 1,
      exit: { code: null, signal: null, signalCode: null },
      events: [],
    };
    result =
      result ??
      ("result" in finalOutcome
        ? finalOutcome.result
        : {
            status: "failure" as const,
            summary:
              finalOutcome.kind === "invalid_output_exhausted"
                ? `Invalid agent output: ${finalOutcome.reason}`
                : "Backend failed before producing an agent result",
            artifacts: [],
            notes: [],
          });
    if ("result" in finalOutcome) await storage.writeResult(run.id, result);
    storage.appendTrace({
      runId: run.id,
      at: new Date().toISOString(),
      type: "agent_finished",
      agentName: agent.name,
      result,
    });

    const comparison = await compareGitBoundary(boundary, boundaryOptions);
    let boundaryFailure: string | undefined;
    let restorationFailure: string | undefined;
    if (!comparison.equal) {
      boundaryFailure = `Git boundary violation: ${JSON.stringify(comparison)}`;
      try {
        await restoreGitBoundary(boundary, boundaryOptions, boundaryOptions);
      } catch (error) {
        restorationFailure = errorMessage(error);
      }
    }
    const current = storage.getRun(run.id);
    if (current?.status !== "running") {
      // stopWorkflow can mark cancellation before this completion callback observes
      // the process exit. The callback still owns the snapshot and must restore it.
      await enforceGitBoundary(boundary, boundaryOptions);
      return current;
    }
    const failedStage = runner.stages.find((stage) => stage.status === "failed");
    const failure =
      workflowFailure(finalOutcome, boundaryFailure, restorationFailure) ??
      (failedStage
        ? {
            code: "WORKFLOW_FAILURE" as const,
            message: failedStage.failure ?? "Workflow stage failed",
          }
        : undefined);
    return storage.finishRun(
      run.id,
      !failure &&
        finalOutcome.kind === "success" &&
        !runner.stages.some((stage) => stage.status === "cancelled")
        ? "succeeded"
        : "failed",
      failure,
    );
  } catch (error) {
    let failure = errorMessage(error);
    try {
      const boundaryResult = await enforceGitBoundary(boundary, boundaryOptions);
      if (boundaryResult.failure) {
        failure = `${failure}; ${boundaryResult.failure}`;
        if (boundaryResult.restorationFailure)
          failure += `; Boundary restoration failed: ${boundaryResult.restorationFailure}`;
      }
    } catch (boundaryError) {
      failure += `; Git boundary check failed: ${errorMessage(boundaryError)}`;
    }
    await rm(currentArtifact, { force: true }).catch(() => undefined);
    return terminalFailure(storage, run, Error(failure));
  } finally {
    activeProcesses.delete(`${root}:${run.id}`);
    try {
      storage.clearAgentProcess(run.id);
    } catch {
      /* best effort */
    }
    storage.close();
    await lock.release();
  }
}

export function validateWorkflowInput(value: unknown): WorkflowInput {
  return WorkflowInputSchema.parse(value);
}
