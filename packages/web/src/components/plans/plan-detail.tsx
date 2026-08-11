import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { Plan } from "@/data/plans";

const date = (value: string) =>
  new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );
const statusVariant = (status: Plan["status"]) =>
  status === "approved" ? "default" : status === "draft" ? "secondary" : "outline";

export function PlanDetail({ plan }: { plan: Plan }) {
  return (
    <section aria-labelledby="detail-heading">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">PLAN / REVISION {plan.revision}</p>
          <h2 id="detail-heading" className="mt-2 text-2xl font-semibold">
            {plan.missionTitle}
          </h2>
        </div>
        <Badge variant={statusVariant(plan.status)}>{plan.status}</Badge>
      </div>
      <Card>
        <CardContent className="space-y-8 pt-6">
          <div className="grid gap-4 border-b pb-6 text-sm sm:grid-cols-4">
            <Info label="Verification mode" value={plan.verificationMode} capitalize />
            <Info label="Created" value={date(plan.createdAt)} />
            <Info label="Updated" value={date(plan.updatedAt)} />
            <Info
              label="Approved"
              value={plan.approvedAt ? date(plan.approvedAt) : "Not approved"}
            />
          </div>
          <div className="grid gap-8 lg:grid-cols-[1fr_1.15fr]">
            <div className="space-y-6">
              <DetailBlock title="Intent" text={plan.sections.intent} />
              <DetailBlock title="Approach" text={plan.sections.approach} />
              <DetailBlock title="Execution design" text={plan.sections.executionDesign} />
              <DetailBlock
                title="Implementation details"
                text={plan.sections.implementationDetails}
              />
              <DetailBlock title="Context" text={plan.sections.context} />
              <div>
                <h3 className="mb-2 font-semibold">Alternatives considered</h3>
                {plan.sections.alternatives.length ? (
                  <div className="space-y-3">
                    {plan.sections.alternatives.map((item) => (
                      <div key={item.name} className="rounded-lg border p-3 text-sm">
                        <p className="font-medium">{item.name}</p>
                        <p className="mt-1 text-muted-foreground">
                          Rejected because: {item.rejectedBecause}
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
                  {plan.milestones.map((milestone) => (
                    <div key={milestone.key} className="rounded-lg border p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium">{milestone.title}</p>
                        <Badge variant="outline">{milestone.key}</Badge>
                      </div>
                      <div className="mt-3 space-y-2">
                        {plan.steps
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
              <List title="Risks">
                {plan.sections.risks.map((risk) => (
                  <div key={risk.description} className="rounded-lg border p-3 text-sm">
                    <p>{risk.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Mitigation: {risk.mitigation}
                    </p>
                  </div>
                ))}
              </List>
              <List title="Acceptance">
                <ul className="list-disc space-y-2 pl-5 text-sm">
                  {plan.sections.acceptance.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </List>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
function Info({
  label,
  value,
  capitalize,
}: {
  label: string;
  value: string;
  capitalize?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-medium ${capitalize ? "capitalize" : ""}`}>{value}</p>
    </div>
  );
}
function List({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 font-semibold">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function StepList({ label, items }: { label: string; items?: ReadonlyArray<string> }) {
  return items?.length ? (
    <div>
      <span className="font-medium text-foreground">{label}:</span>
      <ul className="mt-1 list-disc space-y-1 pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  ) : null;
}
function DetailBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
    </div>
  );
}
