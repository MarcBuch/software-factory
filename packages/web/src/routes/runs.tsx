import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/runs")({
  component: () => (
    <>
      <h1>Runs</h1>
      <Outlet />
    </>
  ),
});
