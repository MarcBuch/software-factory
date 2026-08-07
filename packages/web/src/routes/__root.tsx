import { createRootRoute, Outlet } from "@tanstack/react-router";

import { ThemeProvider } from "@/components/theme-provider";
import { App, WorkflowProvider } from "@/main";

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
