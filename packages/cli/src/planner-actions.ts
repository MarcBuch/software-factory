import { join } from "node:path";

import { createDraftPlan } from "./plans";
import { type AgentResult } from "./workflow";

export type PlannerActionContext = {
  root: string;
  runId: string;
  result: AgentResult;
  outcome: { events: readonly any[] };
  initialArchitectureState: Readonly<Record<string, string>>;
  architectureState: (root: string) => Promise<Readonly<Record<string, string>>>;
  validateArchitectureArtifact: (root: string, path: string) => Promise<void>;
  architectureMutated: (
    before: Readonly<Record<string, string>>,
    after: Readonly<Record<string, string>>,
    runFile: string,
  ) => boolean;
  delegatedExplorer: (result: { events: readonly any[] }) => boolean;
  completedVisualization: (result: { events: readonly any[] }) => boolean;
  initialFactoryState: { plans: { content?: string }; missions: { content?: string } };
  factoryState: () => Promise<{ plans: { content?: string }; missions: { content?: string } }>;
  restoreFactoryState: (state: any, expected: any) => Promise<void>;
  onDraft: (id: string) => void;
};

/** The planner policy is expressed as typed workflow actions, not orchestration. */
export function plannerActions(context: PlannerActionContext) {
  // This is an explicit handoff between actions.  It deliberately replaces
  // the old sampling watcher: a sampled observation cannot prove that a
  // writer did (or did not) race a planner boundary.
  let expectedFactoryState = context.initialFactoryState;
  const fingerprint = (state: { plans: { content?: string }; missions: { content?: string } }) =>
    JSON.stringify([state.plans.content ?? null, state.missions.content ?? null]);
  const assertExpected = async (expected = expectedFactoryState) => {
    const current = await context.factoryState();
    if (fingerprint(current) !== fingerprint(expected))
      throw Error("Factory state restoration failed: concurrent planner state mutation detected");
    return current;
  };
  const restoreInitial = async (observed: any) => {
    if (fingerprint(observed) === fingerprint(context.initialFactoryState)) return;
    try {
      await context.restoreFactoryState(context.initialFactoryState, observed);
    } catch (error) {
      throw Error(
        `Factory state restoration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    expectedFactoryState = context.initialFactoryState;
  };
  const evidence = async () => {
    // Capture the post-agent state before yielding to the test barrier.  This
    // ordering is part of the planner safety contract: the barrier only lets a
    // concurrent writer race with the already captured observation.
    const postState = await context.factoryState();
    // Changes made by the planner are owned by this run and are restored.  A
    // change after this snapshot is external and must be left untouched.
    expectedFactoryState = postState;
    const barrier = process.env.FACTORY_TEST_PLANNER_POST_STATE_BARRIER;
    if (barrier) {
      await Bun.write(barrier, "captured\n");
      while (!(await Bun.file(`${barrier}.release`).exists())) await Bun.sleep(10);
    }
    await assertExpected(postState);
    await restoreInitial(postState);
    if (!context.delegatedExplorer(context.outcome))
      throw Error("Planner must delegate to codebase-explorer");
    if (!context.completedVisualization(context.outcome))
      throw Error("Planner must complete the visualize-change skill");
    if (!context.result.plan) throw Error("Planner must return a complete plan input");
  };
  const artifact = async () => {
    await assertExpected();
    const result = context.result;
    const path = join(".factory", "architecture", `${context.runId}.html`);
    const declarations = result.artifacts.filter((item) => item.kind === "architecture");
    if (
      result.artifacts.length !== 1 ||
      declarations.length !== 1 ||
      declarations[0]!.path !== path
    )
      throw Error("Planner must declare exactly one matching architecture artifact");
    const external = result.plan?.externalArtifacts ?? [];
    if (
      external.some((item) => item.path === path) ||
      new Set(external.map((item) => item.path)).size !== external.length
    )
      throw Error("Planner must not duplicate the architecture artifact in plan.externalArtifacts");
    const after = await context.architectureState(context.root);
    if (
      context.architectureMutated(context.initialArchitectureState, after, `${context.runId}.html`)
    )
      throw Error("Planner may only create the current run architecture artifact");
    await context.validateArchitectureArtifact(context.root, path);
  };
  const draft = async () => {
    await assertExpected();
    const barrier = process.env.FACTORY_TEST_PLANNER_BEFORE_DRAFT_BARRIER;
    const beforeDraftState = await context.factoryState();
    expectedFactoryState = beforeDraftState;
    if (barrier) {
      await Bun.write(barrier, "ready\n");
      while (!(await Bun.file(`${barrier}.release`).exists())) await Bun.sleep(10);
    }
    await assertExpected();
    if (!context.result.plan) throw Error("Planner must return a complete plan input");
    const path = join(context.root, ".factory", "plans.jsonl");
    const artifact = context.result.artifacts[0]!;
    const plan = await createDraftPlan(
      {
        ...context.result.plan,
        externalArtifacts: [
          ...(context.result.plan.externalArtifacts ?? []),
          {
            path: join(".factory", "architecture", `${context.runId}.html`),
            label: artifact.description,
          },
        ],
      },
      path,
      context.root,
    );
    context.onDraft(plan.id);
    const persisted = await context.factoryState();
    if (persisted.missions.content !== context.initialFactoryState.missions.content)
      throw Error("Planner draft creation changed mission state");
    expectedFactoryState = persisted;
  };
  return {
    "persist-planner-evidence": evidence,
    "validate-architecture-artifact": artifact,
    "persist-draft-plan": draft,
  };
}
