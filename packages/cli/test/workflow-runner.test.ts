import { expect, test } from "bun:test";

import type { FactoryAction } from "../src/agent-executor";
import type { WorkflowStageDefinition } from "../src/workflow";
import { WorkflowRunner, type RunnerStage, type RunnerStatus } from "../src/workflow-runner";

const source: WorkflowStageDefinition[] = [
  { id: "agent", kind: "agent", agent: "scout", label: "Scout" },
  { id: "first", kind: "action", action: "first", label: "First" },
  { id: "second", kind: "action", action: "second", label: "Second" },
];

test("runs ordered stages and persists terminal outcomes", async () => {
  const cases = [
    {
      fail: false,
      cancel: false,
      unknown: false,
      statuses: ["succeeded", "succeeded", "succeeded"],
    },
    { fail: true, cancel: false, unknown: false, statuses: ["succeeded", "failed", "skipped"] },
    {
      fail: false,
      cancel: true,
      unknown: false,
      statuses: ["succeeded", "cancelled", "cancelled"],
    },
    { fail: false, cancel: false, unknown: true, statuses: ["succeeded", "failed", "skipped"] },
  ] as const;
  for (const scenario of cases) {
    const calls: string[] = [];
    const persisted: string[][] = [];
    let checks = 0;
    let runner!: WorkflowRunner;
    const actions: Record<string, FactoryAction> = scenario.unknown
      ? {}
      : {
          first: async () => {
            calls.push("action:first");
            if (scenario.fail) throw new Error("nope");
          },
          second: async () => {
            calls.push("action:second");
          },
        };
    const stages = source.map((stage) => ({ ...stage }));
    runner = new WorkflowRunner({
      stages,
      actions,
      runAgent: async (stage) => {
        calls.push(`agent:${stage.agent}`);
      },
      isCancelled: () => ++checks > (scenario.cancel ? 1 : 99),
      transition: (stage: RunnerStage) => {
        persisted.push(runner.stages.map((entry) => `${entry.id}:${entry.status}`));
        void stage;
      },
    });
    stages[0] = { id: "agent", kind: "agent", agent: "mutated", label: "Mutated" };
    const result = await runner.run();
    expect(result.map((stage) => stage.status)).toEqual([...scenario.statuses] as RunnerStatus[]);
    expect(calls).toEqual(
      scenario.cancel || scenario.unknown
        ? ["agent:scout"]
        : scenario.fail
          ? ["agent:scout", "action:first"]
          : ["agent:scout", "action:first", "action:second"],
    );
    expect(persisted.length).toBeGreaterThan(0);
    expect((result[0] as Extract<RunnerStage, { kind: "agent" }>).agent).toBe("scout");
  }
});
