import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useAppHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { mockPlans, type MockPlan } from "@/data/mock-plans";

type WorkspaceState = "populated" | "loading" | "empty" | "error";

const workspaceState = (): WorkspaceState => {
  if (typeof window === "undefined") return "populated";
  const state = new URLSearchParams(window.location.search).get("state");
  return state === "loading" || state === "empty" || state === "error" ? state : "populated";
};

const date = (value: string) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );

const statusVariant = (status: MockPlan["status"]) =>
  status === "approved" ? "default" : status === "draft" ? "secondary" : "outline";

function Workspace() {
  useAppHeader(
    "Workspace",
    "Durable plan revisions, milestones, and execution intent in one place.",
  );
  const state = workspaceState();
  const plans = state === "populated" ? mockPlans : [];
  const [selectedId, setSelectedId] = useState(mockPlans[0].id);
  const selected = plans.find((plan) => plan.id === selectedId) ?? mockPlans[0];
  const lifecycle = ["approved", "draft", "superseded", "archived"] as const;

  if (state === "loading") return <WorkspaceLoading />;

  return (
    <div className="space-y-8">
      <section aria-labelledby="lifecycle-heading">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="lifecycle-heading" className="text-lg font-semibold">
            Lifecycle
          </h2>
          <span className="text-xs uppercase tracking-widest text-muted-foreground">
            Current inventory
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {lifecycle.map((status) => (
            <Card key={status} className="gap-3 py-4">
              <CardContent>
                <p className="text-xs uppercase tracking-widest text-muted-foreground">{status}</p>
                <p className="mt-2 text-2xl font-semibold">
                  {plans.filter((plan) => plan.status === status).length}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="plans-heading">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="plans-heading" className="text-lg font-semibold">
            Plan revisions
          </h2>
          <span className="text-xs uppercase tracking-widest text-muted-foreground">
            {plans.length} records
          </span>
        </div>
        {state === "error" ? (
          <StatePanel
            title="Plans could not be loaded"
            message="The mock plans source returned an error. Try again when the plans source is available."
            tone="error"
          />
        ) : state === "empty" ? (
          <StatePanel
            title="No plan revisions yet"
            message="When plans are created, their revisions will appear here."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {plans.map((plan) => (
              <Card
                key={plan.id}
                className={plan.id === selected.id ? "border-primary shadow-md" : ""}
              >
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle>{plan.missionTitle}</CardTitle>
                      <CardDescription className="mt-2 font-mono text-xs">
                        {plan.id}
                      </CardDescription>
                    </div>
                    <Badge variant={statusVariant(plan.status)}>{plan.status}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Revision</p>
                      <p className="font-medium">v{plan.revision}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Verification</p>
                      <p className="font-medium capitalize">{plan.verificationMode}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Scope</p>
                      <p className="font-medium">
                        {plan.milestones.length} milestones · {plan.steps.length} steps
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t pt-4 text-xs text-muted-foreground">
                    <span>Updated {date(plan.updatedAt)}</span>
                    <Button
                      variant={plan.id === selected.id ? "default" : "outline"}
                      size="sm"
                      onClick={() => setSelectedId(plan.id)}
                    >
                      {plan.id === selected.id ? "Selected" : "View plan"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {state === "populated" && (
        <section aria-labelledby="detail-heading" role="region">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">SELECTED PLAN / REVISION {selected.revision}</p>
              <h2 id="detail-heading" className="mt-2 text-2xl font-semibold">
                {selected.missionTitle}
              </h2>
            </div>
            <Badge variant={statusVariant(selected.status)}>{selected.status}</Badge>
          </div>
          <Card>
            <CardContent className="space-y-8 pt-6">
              <div className="grid gap-4 border-b pb-6 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Verification mode</p>
                  <p className="mt-1 font-medium capitalize">{selected.verificationMode}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="mt-1 font-medium">{date(selected.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Updated</p>
                  <p className="mt-1 font-medium">{date(selected.updatedAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Approved</p>
                  <p className="mt-1 font-medium">
                    {selected.approvedAt ? date(selected.approvedAt) : "Not approved"}
                  </p>
                </div>
              </div>
              <div className="grid gap-8 lg:grid-cols-[1fr_1.15fr]">
                <div className="space-y-6">
                  <DetailBlock title="Intent" text={selected.sections.intent} />
                  <DetailBlock title="Approach" text={selected.sections.approach} />
                  <DetailBlock title="Execution design" text={selected.sections.executionDesign} />
                  <DetailBlock
                    title="Implementation details"
                    text={selected.sections.implementationDetails}
                  />
                  <DetailBlock title="Context" text={selected.sections.context} />
                  <div>
                    <h3 className="mb-2 font-semibold">Alternatives considered</h3>
                    {selected.sections.alternatives.length > 0 ? (
                      <div className="space-y-3">
                        {selected.sections.alternatives.map((alternative) => (
                          <div key={alternative.name} className="rounded-lg border p-3 text-sm">
                            <p className="font-medium">{alternative.name}</p>
                            <p className="mt-1 text-muted-foreground">
                              Rejected because: {alternative.rejectedBecause}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">None recorded.</p>
                    )}
                  </div>
                </div>
                <div className="space-y-6">
                  <div>
                    <h3 className="mb-3 font-semibold">Milestones & typed steps</h3>
                    <div className="space-y-3">
                      {selected.milestones.map((milestone) => (
                        <div key={milestone.key} className="rounded-lg border p-4">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium">{milestone.title}</p>
                            <Badge variant="outline">{milestone.key}</Badge>
                          </div>
                          <div className="mt-3 space-y-2">
                            {selected.steps
                              .filter((step) => step.milestoneKey === milestone.key)
                              .map((step) => (
                                <div key={step.key} className="border-l-2 pl-3 text-sm">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span>{step.title}</span>
                                    <Badge variant="secondary">{step.type}</Badge>
                                    <Badge variant="outline">{step.risk} risk</Badge>
                                  </div>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {step.verification}
                                  </p>
                                  <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                                    {step.executionNotes && (
                                      <p>
                                        <span className="font-medium text-foreground">
                                          Execution notes:
                                        </span>{" "}
                                        {step.executionNotes}
                                      </p>
                                    )}
                                    <StepList label="Inputs" items={step.inputs} />
                                    <StepList label="Invariants" items={step.invariants} />
                                    <StepList label="Outcomes" items={step.outcomes} />
                                    <StepList label="Depends on" items={step.dependsOn} />
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3 className="mb-3 font-semibold">Risks</h3>
                    <div className="space-y-3">
                      {selected.sections.risks.map((risk) => (
                        <div key={risk.description} className="rounded-lg border p-3 text-sm">
                          <p>{risk.description}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Mitigation: {risk.mitigation}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3 className="mb-3 font-semibold">Acceptance</h3>
                    <ul className="list-disc space-y-2 pl-5 text-sm">
                      {selected.sections.acceptance.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

function WorkspaceLoading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading workspace">
      <div className="flex items-end justify-between border-b pb-8">
        <div className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <div className="space-y-2 text-right">
          <Skeleton className="ml-auto h-9 w-12" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <section aria-label="Loading plan summary">
        <div className="mb-4 flex items-center justify-between">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      </section>
      <section aria-label="Loading plan revisions">
        <Skeleton className="mb-4 h-6 w-36" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, index) => (
            <PlanCardSkeleton key={index} />
          ))}
        </div>
      </section>
      <section aria-label="Loading selected plan detail">
        <Skeleton className="mb-4 h-8 w-72" />
        <Card>
          <CardContent className="space-y-6 pt-6">
            <Skeleton className="h-16" />
            <Skeleton className="h-72" />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function PlanCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-3 w-40" />
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
        <div className="flex justify-between border-t pt-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}

function StatePanel({
  title,
  message,
  tone = "default",
}: {
  title: string;
  message: string;
  tone?: "default" | "error";
}) {
  return (
    <Card role={tone === "error" ? "alert" : undefined}>
      <CardContent className="py-12 text-center">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

function StepList({ label, items }: { label: string; items?: ReadonlyArray<string> }) {
  if (!items || items.length === 0) return null;

  return (
    <div>
      <span className="font-medium text-foreground">{label}:</span>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function DetailBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
    </div>
  );
}

export const Route = createFileRoute("/workspace")({
  component: Workspace,
});
