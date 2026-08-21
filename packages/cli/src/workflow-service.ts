import { execFile } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  lstat,
  unlink,
  readdir,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { OpenCodeAdapter, type BackendAdapter, type BackendProcess } from "./backend";
import { completeAgent } from "./completion";
import { captureGitBoundary, compareGitBoundary, restoreGitBoundary } from "./git-boundary";
import { createDraftPlan } from "./plans";
import { lookupRoster, renderAgentPrompts } from "./roster";
import { WorkflowInputSchema, type WorkflowInput } from "./workflow";
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
  adapter?: BackendAdapter;
};

type WorkflowOutcome = Awaited<ReturnType<typeof completeAgent>>;
type WorkflowFailure = NonNullable<RunRecord["failure"]>;
type WorkflowLock = { release: () => Promise<void> };

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

async function acquireWorkflowLock(root: string): Promise<WorkflowLock> {
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
      if (!owner || (await processAlive(owner.pid))) throw new WorkflowAlreadyRunning();
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

function delegatedExplorer(outcome: WorkflowOutcome) {
  const starts = new Set<string>();
  for (const event of outcome.events) {
    const normalized = event.normalized;
    if (normalized?.type !== "tool_call" || normalized.tool !== "task" || !normalized.spanId)
      continue;
    if (
      normalized.phase === "start" &&
      normalized.input &&
      typeof normalized.input === "object" &&
      (normalized.input as Record<string, unknown>).subagent_type === "codebase-explorer"
    )
      starts.add(normalized.spanId);
    if (
      normalized.phase === "finish" &&
      normalized.output &&
      typeof normalized.output === "object" &&
      ["completed", "success"].includes(
        String((normalized.output as Record<string, unknown>).status ?? "").toLowerCase(),
      ) &&
      (starts.has(normalized.spanId) ||
        (normalized.input &&
          typeof normalized.input === "object" &&
          (normalized.input as Record<string, unknown>).subagent_type === "codebase-explorer"))
    )
      return true;
  }
  return false;
}

function completedVisualization(outcome: WorkflowOutcome) {
  for (const event of outcome.events) {
    const normalized = event.normalized;
    if (
      normalized?.type !== "tool_call" ||
      normalized.tool !== "skill" ||
      normalized.phase !== "finish" ||
      !normalized.input ||
      typeof normalized.input !== "object" ||
      (normalized.input as Record<string, unknown>).name !== "visualize-change" ||
      !normalized.output ||
      typeof normalized.output !== "object"
    )
      continue;
    if (
      ["completed", "success"].includes(
        String((normalized.output as Record<string, unknown>).status ?? "").toLowerCase(),
      )
    )
      return true;
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
async function factoryState(root: string): Promise<FactoryState> {
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
async function restoreFactoryState(root: string, state: FactoryState) {
  for (const [name, content] of Object.entries(state)) {
    const file = join(root, ".factory", `${name}.jsonl`);
    const stat = await lstat(file).catch(() => undefined);
    if (stat?.isSymbolicLink()) await unlink(file);
    if (content.content === undefined) await rm(file, { force: true });
    else await writeFile(file, content.content, { mode: 0o600 });
  }
  if (JSON.stringify(await factoryState(root)) !== JSON.stringify(state))
    throw Error("Factory state restoration failed");
}

async function terminalFailure(
  storage: Awaited<ReturnType<typeof openWorkflowStorage>>,
  run: RunRecord,
  error: unknown,
) {
  const message = errorMessage(error);
  const failed = storage.failIfRunning(run.id, {
    code:
      message.includes("spawn") || message.includes("ENOENT")
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

export async function startWorkflow(
  repositoryRoot: string,
  input: WorkflowInput,
  options: WorkflowServiceOptions = {},
): Promise<WorkflowLaunch> {
  const root = resolve(repositoryRoot);
  const parsed = WorkflowInputSchema.parse(input);
  const agent = lookupRoster(parsed.agentName);
  const lock = await acquireWorkflowLock(root);

  let storage: Awaited<ReturnType<typeof openWorkflowStorage>> | undefined;
  let run: RunRecord | undefined;
  let processStarted = false;
  try {
    storage = await openWorkflowStorage(root);
    const boundary = await captureGitBoundary({ repositoryRoot: root });
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
    });
    const prompts = renderAgentPrompts(agent.name, parsed.request, {
      runId: run.id,
      storagePath: relative(root, run.files.directory),
      expectedArtifactPath: `.factory/architecture/${run.id}.html`,
    });
    await Bun.write(run.files.systemPrompt, prompts.systemPrompt);
    await Bun.write(run.files.userPrompt, prompts.userPrompt);
    run = storage.startRun(run.id)!;
    processStarted = true;

    let processRun: BackendProcess;
    try {
      const adapter =
        options.adapter ??
        new OpenCodeAdapter({
          executable: process.env.FACTORY_OPENCODE_EXECUTABLE,
        });
      processRun = adapter.start({
        repositoryRoot: root,
        runId: run.id,
        agent,
        prompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        model: agent.model,
        tools: agent.allowedTools,
      });
    } catch (error) {
      const failed = storage.finishRun(run.id, "failed", {
        code: "BACKEND_FAILURE",
        message: errorMessage(error),
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
      pid: processRun.pid,
      ...(identity ? { identity } : {}),
    });
    storage.appendTrace({
      runId: run.id,
      at: new Date().toISOString(),
      type: "agent_started",
      agentName: agent.name,
    });

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
  } = args;
  let draftPersisted = false;
  const currentArtifact = join(root, ".factory", "architecture", `${run.id}.html`);
  try {
    if (agent.name === "planner" && (await lstat(currentArtifact).catch(() => undefined)))
      throw Error("Planner architecture artifact must not pre-exist");
    const invocation = {
      repositoryRoot: root,
      runId: run.id,
      agent,
      prompt: prompts.userPrompt,
      systemPrompt: prompts.systemPrompt,
      model: agent.model,
      tools: agent.allowedTools,
    };
    const outcome = await completeAgent(
      { start: () => processRun } as any,
      invocation,
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
          pid: activeProcess.pid,
          ...(identity ? { identity } : {}),
          sessionId: event.sessionId,
        });
      },
    );
    let result =
      "result" in outcome
        ? outcome.result
        : {
            status: "failure" as const,
            summary:
              outcome.kind === "invalid_output_exhausted"
                ? `Invalid agent output: ${outcome.reason}`
                : "Backend failed before producing an agent result",
            artifacts: [],
            notes: [],
          };
    if (
      agent.name === "planner" &&
      JSON.stringify(await factoryState(root)) !== JSON.stringify(initialFactoryState)
    ) {
      await restoreFactoryState(root, initialFactoryState);
      throw Error("Planner may not mutate Factory plan or mission state");
    }
    if (agent.name === "planner" && outcome.kind === "success") {
      if (!delegatedExplorer(outcome)) throw Error("Planner must delegate to codebase-explorer");
      if (!completedVisualization(outcome))
        throw Error("Planner must complete the visualize-change skill");
      if (!result.plan) throw Error("Planner must return a complete plan input");
      const artifactPath = join(".factory", "architecture", `${run.id}.html`);
      const declarations = result.artifacts.filter((artifact) => artifact.kind === "architecture");
      if (
        result.artifacts.length !== 1 ||
        declarations.length !== 1 ||
        declarations[0].path !== artifactPath
      )
        throw Error("Planner must declare exactly one matching architecture artifact");
      const externalArtifacts = result.plan.externalArtifacts ?? [];
      if (
        externalArtifacts.some((artifact) => artifact.path === artifactPath) ||
        new Set(externalArtifacts.map((artifact) => artifact.path)).size !==
          externalArtifacts.length
      )
        throw Error(
          "Planner must not duplicate the architecture artifact in plan.externalArtifacts",
        );
      const afterArchitectureState = await architectureState(root);
      if (architectureMutated(initialArchitectureState, afterArchitectureState, `${run.id}.html`))
        throw Error("Planner may only create the current run architecture artifact");
      await validateArchitectureArtifact(root, artifactPath);
      const planInput = {
        ...result.plan,
        externalArtifacts: [
          ...(result.plan.externalArtifacts ?? []),
          { path: artifactPath, label: declarations[0].description },
        ],
      };
      let plan;
      plan = await createDraftPlan(planInput, join(root, ".factory", "plans.jsonl"), root);
      draftPersisted = true;
      if ((await factoryState(root)).missions.content !== initialFactoryState.missions.content)
        throw Error("Planner draft creation changed mission state");
      result = {
        ...result,
        summary: `${result.summary}\n\nDraft plan: ${plan.id}`,
        notes: [...result.notes, `Created draft plan ${plan.id}`],
      };
    }
    if ("result" in outcome) await storage.writeResult(run.id, result);
    storage.appendTrace({
      runId: run.id,
      at: new Date().toISOString(),
      type: "agent_finished",
      agentName: agent.name,
      result,
    });

    const comparison = await compareGitBoundary(boundary, {
      repositoryRoot: root,
    });
    let boundaryFailure: string | undefined;
    let restorationFailure: string | undefined;
    if (!comparison.equal) {
      boundaryFailure = `Git boundary violation: ${JSON.stringify(comparison)}`;
      try {
        await restoreGitBoundary(boundary, {
          repositoryRoot: root,
          runtimeDirectory: join(root, ".factory"),
          ...(process.env.FACTORY_TEST_RESTORE_FAILURE
            ? {
                restoreFailure: (step) => {
                  if (step === process.env.FACTORY_TEST_RESTORE_FAILURE)
                    throw Error(`Injected restoration failure: ${step}`);
                },
              }
            : {}),
        });
      } catch (error) {
        restorationFailure = errorMessage(error);
      }
    }
    const current = storage.getRun(run.id);
    if (current?.status !== "running") return current;
    const failure = workflowFailure(outcome, boundaryFailure, restorationFailure);
    return storage.finishRun(
      run.id,
      !failure && outcome.kind === "success" ? "succeeded" : "failed",
      failure,
    );
  } catch (error) {
    if (agent.name === "planner") {
      await restoreFactoryState(root, initialFactoryState).catch(() => undefined);
      await rm(currentArtifact, { force: true }).catch(() => undefined);
    } else if (!draftPersisted) await rm(currentArtifact, { force: true }).catch(() => undefined);
    return terminalFailure(storage, run, error);
  } finally {
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
