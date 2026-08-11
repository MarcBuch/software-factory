import { createFileRoute, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import {
  columnVisibilityFeature,
  flexRender,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";

import { useAppHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
          <PlansTable plans={plans} navigate={navigate} />
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

function PlansTable({
  plans,
  navigate,
}: {
  plans: Plan[];
  navigate: ReturnType<typeof useNavigate>;
}) {
  const features = tableFeatures({ columnVisibilityFeature });
  const columns: ColumnDef<typeof features, Plan>[] = [
    {
      accessorKey: "missionTitle",
      header: "Title",
      cell: ({ row }) => (
        <div className="min-w-48">
          <div className="font-medium">{row.original.missionTitle}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.id}</div>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>
      ),
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      cell: ({ row }) => date(row.original.updatedAt),
    },
    {
      id: "action",
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <Button
          aria-label={`View plan: ${row.original.missionTitle}`}
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({ to: "/workspace/$planId", params: { planId: row.original.id } })
          }
        >
          View plan
        </Button>
      ),
    },
  ];
  const table = useTable({
    features,
    data: plans,
    columns,
    getRowId: (plan) => plan.id,
  });

  return (
    // oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- Keyboard access is needed to scroll this wide table.
    <div
      role="region"
      tabIndex={0}
      className="m-0 overflow-x-auto rounded-lg border bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:bg-background"
      aria-label="Scrollable plan revisions"
    >
      <table className="w-full min-w-[900px] caption-bottom text-sm">
        <caption className="sr-only">Plan revisions</caption>
        <thead className="bg-muted/50">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="h-11 whitespace-nowrap px-4 text-left align-middle font-medium text-muted-foreground"
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-t transition-colors hover:bg-muted/50">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="whitespace-nowrap px-4 py-4 align-middle">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    // oxlint-enable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role
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
