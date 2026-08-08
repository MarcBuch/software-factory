export type PlanStatus = "draft" | "approved" | "superseded" | "archived";
export type VerificationMode = "fast" | "standard" | "exhaustive";
export type PlanStepType = "implementation" | "verification";
export type PlanRisk = "low" | "medium" | "high";

export type PlanSection = {
  context: string;
  intent: string;
  approach: string;
  executionDesign: string;
  implementationDetails: string;
  alternatives: ReadonlyArray<{
    name: string;
    rejectedBecause: string;
  }>;
  risks: ReadonlyArray<{
    description: string;
    mitigation: string;
  }>;
  acceptance: ReadonlyArray<string>;
};

export type PlanStep = {
  key: string;
  milestoneKey: string;
  title: string;
  type: PlanStepType;
  risk: PlanRisk;
  verification: string;
  executionNotes?: string;
  inputs?: ReadonlyArray<string>;
  invariants?: ReadonlyArray<string>;
  outcomes?: ReadonlyArray<string>;
  dependsOn: ReadonlyArray<string>;
};

export type MockPlan = {
  id: string;
  missionTitle: string;
  verificationMode: VerificationMode;
  milestones: ReadonlyArray<{ key: string; title: string }>;
  revision: number;
  status: PlanStatus;
  sections: PlanSection;
  steps: ReadonlyArray<PlanStep>;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
};

export const mockPlans: ReadonlyArray<MockPlan> = [
  {
    id: "pln_workspaceindex20260801",
    missionTitle: "Workspace Plan Index",
    verificationMode: "standard",
    milestones: [
      { key: "m1", title: "Implement Variation A With Mock Plans" },
      { key: "m2", title: "Connect The Plans API" },
    ],
    revision: 1,
    status: "approved",
    sections: {
      context: "The Workspace route needs a durable-plan view before repository integration.",
      intent: "Make plan lifecycle and execution detail easy to scan in the Workspace.",
      approach:
        "Build the view against realistic plan records, then replace the source with the read-only API.",
      executionDesign:
        "Render summary cards, plan selection, and milestone steps from the durable record.",
      implementationDetails:
        "Keep the mock source isolated in the web package and preserve plan schema semantics.",
      alternatives: [
        {
          name: "Build the API first",
          rejectedBecause: "The UI needs realistic data to establish its states and mapping first.",
        },
      ],
      risks: [
        {
          description: "Mock records could drift from persisted plan records.",
          mitigation:
            "Mirror the durable PlanRevision fields and lifecycle rules in this typed fixture.",
        },
      ],
      acceptance: [
        "Plan lifecycle, milestones, steps, risks, and acceptance criteria are visible to the future UI.",
        "The mock record can be replaced by validated repository data without changing the UI model.",
      ],
    },
    steps: [
      {
        key: "m1t1",
        milestoneKey: "m1",
        title: "Define schema-accurate mock plan records",
        type: "implementation",
        risk: "low",
        verification:
          "Validate lifecycle states, revisions, milestones, steps, risks, and acceptance criteria.",
        inputs: ["Existing durable plan types and lifecycle rules"],
        invariants: ["Mock records use only valid plan statuses and step types."],
        outcomes: ["Reusable mock plan data for the Workspace UI."],
        dependsOn: [],
      },
      {
        key: "m1t2",
        milestoneKey: "m1",
        title: "Build Variation A Workspace layout",
        type: "implementation",
        risk: "medium",
        verification: "Confirm cards and detail views map directly to the plan record.",
        dependsOn: ["m1t1"],
      },
      {
        key: "m2t1",
        milestoneKey: "m2",
        title: "Add read-only plans API endpoint",
        type: "implementation",
        risk: "medium",
        verification: "Return validated current plan revisions without changing storage.",
        dependsOn: [],
      },
    ],
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-02T14:30:00.000Z",
    approvedAt: "2026-08-02T14:30:00.000Z",
  },
  {
    id: "pln_observability20260803",
    missionTitle: "Improve Workflow Observability",
    verificationMode: "exhaustive",
    milestones: [{ key: "m1", title: "Instrument Workflow Runs" }],
    revision: 1,
    status: "draft",
    sections: {
      context: "Workflow runs need clearer timing and outcome signals for operators.",
      intent: "Give operators enough structured detail to diagnose slow or failed runs.",
      approach:
        "Add event timing, outcome metadata, and verification around the workflow boundary.",
      executionDesign:
        "Instrument the run lifecycle first, then verify representative success and failure paths.",
      implementationDetails:
        "Keep telemetry fields explicit and avoid changing workflow execution semantics.",
      alternatives: [],
      risks: [
        {
          description: "Instrumentation may expose sensitive run details.",
          mitigation:
            "Record lifecycle metadata only and review payload boundaries during verification.",
        },
      ],
      acceptance: [
        "Successful and failed runs expose actionable lifecycle timing.",
        "Telemetry does not alter workflow outcomes.",
      ],
    },
    steps: [
      {
        key: "m1t1",
        milestoneKey: "m1",
        title: "Instrument workflow lifecycle events",
        type: "implementation",
        risk: "high",
        verification: "Exercise start, progress, completion, and failure event paths.",
        executionNotes: "Prefer stable event names and preserve existing run identifiers.",
        inputs: ["Workflow event boundaries"],
        invariants: ["Instrumentation remains read-only with respect to workflow state."],
        outcomes: ["Structured lifecycle events for each workflow run."],
        dependsOn: [],
      },
      {
        key: "m1t2",
        milestoneKey: "m1",
        title: "Verify observability coverage",
        type: "verification",
        risk: "medium",
        verification:
          "Confirm representative success and failure runs include complete timing data.",
        dependsOn: ["m1t1"],
      },
    ],
    createdAt: "2026-08-03T11:15:00.000Z",
    updatedAt: "2026-08-03T11:15:00.000Z",
  },
];
