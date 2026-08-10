import { Link } from "@tanstack/react-router";
import { FolderKanban, Radio, Workflow } from "lucide-react";
import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from "react";

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

const defaultHeader = {
  heading: "WORKFLOW",
  subheading: "SESSION TRACE",
};

type Header = typeof defaultHeader;

const HeaderContext = createContext<(header: Header) => void>(() => undefined);

export function useAppHeader(heading: string, subheading: string) {
  const setHeader = useContext(HeaderContext);

  useLayoutEffect(() => {
    setHeader({ heading, subheading });
    return () => setHeader(defaultHeader);
  }, [heading, setHeader, subheading]);
}

function Navigation() {
  const { isMobile, setOpenMobile } = useSidebar();
  const close = () => isMobile && setOpenMobile(false);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip="Workspace">
          <Link to="/workspace" activeProps={{ "data-active": true }} onClick={close}>
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
  const [header, setHeader] = useState<Header>(defaultHeader);
  const { error } = useWorkflow();
  return (
    <HeaderContext.Provider value={setHeader}>
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
                  <h1>{header.heading}</h1>
                  <small>{header.subheading}</small>
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
    </HeaderContext.Provider>
  );
}
