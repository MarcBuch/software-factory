import { createFileRoute, Outlet, useMatches, useNavigate } from "@tanstack/react-router";

import { useAppHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Plan } from "@/data/plans";
import { planQuery } from "@/data/queries";

const date = (value: string) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );

const statusVariant = (status: Plan["status"]) =>
  status === "approved" ? "default" : status === "draft" ? "secondary" : "outline";

function Workspace() {
  const isDetail = useMatches().some((match) => match.routeId === "/workspace/$planId");
  useAppHeader(
    "Workspace",
    "Durable plan revisions, milestones, and execution intent in one place.",
  );
  const navigate = useNavigate();
  const plansQuery = planQuery();
  if (isDetail) return <Outlet />;
  const plans = plansQuery.data ?? [];
  const state = plansQuery.isPending
    ? "loading"
    : plansQuery.isError
      ? "error"
      : plans.length === 0
        ? "empty"
        : "populated";
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
            message="The plans API returned an error. Try again when the plans source is available."
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
              <Card key={plan.id}>
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
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void navigate({ to: "/workspace/$planId", params: { planId: plan.id } })
                      }
                    >
                      View plan
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
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

export const Route = createFileRoute("/workspace")({
  component: Workspace,
});
