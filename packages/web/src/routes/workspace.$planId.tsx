import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PlanDetail } from "@/components/plans/plan-detail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { planQuery, useDeletePlan } from "@/data/queries";

function PlanRoute() {
  const { planId } = Route.useParams();
  const navigate = useNavigate();
  const query = planQuery();
  const remove = useDeletePlan();
  const back = () => void navigate({ to: "/workspace", replace: true });
  if (query.isPending)
    return (
      <section aria-label="Loading plan">
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Status is the appropriate live-region semantics for this announcement. */}
        <p role="status" aria-live="polite" className="sr-only">
          Loading plan
        </p>
        <Skeleton className="h-96" />
      </section>
    );
  if (query.isError)
    return (
      <State
        title="Plans could not be loaded"
        message="The plans API returned an error."
        onBack={back}
      />
    );
  const plan = query.data?.find((item) => item.id === planId);
  if (!plan)
    return (
      <State
        title="Plan unavailable"
        message="This plan revision could not be found."
        onBack={back}
      />
    );
  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={back}>
        Back to workspace
      </Button>
      <PlanDetail
        plan={plan}
        deleting={remove.isPending}
        error={remove.error?.message}
        onDelete={() =>
          remove.mutate(plan.id, {
            onSuccess: () => void navigate({ to: "/workspace", replace: true }),
          })
        }
      />
    </div>
  );
}
function State({ title, message, onBack }: { title: string; message: string; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={onBack}>
        Back to workspace
      </Button>
      <div role="alert" className="rounded-lg border p-8 text-center">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
export const Route = createFileRoute("/workspace/$planId")({ component: PlanRoute });
