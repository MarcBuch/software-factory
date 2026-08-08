import { Link } from "@tanstack/react-router";
import { FolderKanban, Radio, Workflow } from "lucide-react";
import type { ReactNode } from "react";

import { ModeToggle } from "@/components/mode-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useWorkflow } from "@/workflow/workflow-context";
function Navigation() {
  const { isMobile, setOpenMobile } = useSidebar();
  const close = () => isMobile && setOpenMobile(false);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Workspace">
          <Link
            to="/workspace"
            activeOptions={{ exact: true }}
            activeProps={{ "data-active": true }}
            onClick={close}
          >
            <FolderKanban />
            <span>Workspace</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Runs">
          <Link to="/runs" activeProps={{ "data-active": true }} onClick={close}>
            <Workflow />
            <span>Runs</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
export function App({ children }: { children: ReactNode }) {
  const { error } = useWorkflow();
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <div className="flex h-full flex-col">
          <div className="p-2">
            <div className="brand min-w-0 overflow-hidden px-2 py-2">
              <Radio className="mark" size={20} />
              <div className="min-w-0 whitespace-nowrap group-data-[collapsible=icon]:hidden">
                <strong>WORKFLOW</strong>
                <small>SESSION TRACE</small>
              </div>
            </div>
          </div>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <Navigation />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarTrigger className="absolute top-4 -right-9 z-20 hidden md:inline-flex" />
        </div>
      </Sidebar>
      <SidebarInset>
        <header>
          <div className="header-leading">
            <SidebarTrigger className="md:hidden" />
            <div className="brand">
              <Radio className="mark" size={20} />
              <div>
                <strong>WORKFLOW</strong>
                <small>SESSION TRACE</small>
              </div>
            </div>
          </div>
          <div className="header-actions">
            <div className="live">
              <i /> LIVE MONITOR
            </div>
            <ModeToggle />
          </div>
        </header>
        <div className="app-scroll">
          <div className="app-content">
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
