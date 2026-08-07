import { createRootRoute, Outlet } from "@tanstack/react-router";

import { App } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { WorkflowProvider } from "@/workflow/workflow-context";

export const Route = createRootRoute({
  component: () => (
    <ThemeProvider>
      <WorkflowProvider>
        <App>
          <Outlet />
        </App>
      </WorkflowProvider>
    </ThemeProvider>
  ),
});
