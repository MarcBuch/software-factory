import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/runs/$runId")({
  component: () => <p>Run detail</p>,
});
