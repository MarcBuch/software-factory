import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/workspace")({
  component: () => (
    <section className="hero">
      <div>
        <p className="eyebrow">WORKSPACE</p>
        <h1>Workspace</h1>
        <p className="muted">Coming soon.</p>
      </div>
    </section>
  ),
});
