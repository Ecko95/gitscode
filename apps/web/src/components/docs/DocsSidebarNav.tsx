import { useCallback, type ComponentType } from "react";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  KeyboardIcon,
  MonitorSmartphoneIcon,
  ServerIcon,
  ShieldIcon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";

export type DocsSectionSlug =
  | "overview"
  | "security"
  | "orchestration"
  | "sandboxing"
  | "self-hosting"
  | "platforms"
  | "shortcuts";

export const DOCS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  slug: DocsSectionSlug;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "Overview", slug: "overview", icon: BookOpenIcon },
  { label: "Security", slug: "security", icon: ShieldIcon },
  { label: "Orchestration", slug: "orchestration", icon: BotIcon },
  { label: "Sandboxing", slug: "sandboxing", icon: BoxIcon },
  { label: "Self-hosting", slug: "self-hosting", icon: ServerIcon },
  { label: "Cross-platform", slug: "platforms", icon: MonitorSmartphoneIcon },
  { label: "Keyboard Shortcuts", slug: "shortcuts", icon: KeyboardIcon },
];

export function isDocsSectionSlug(value: string): value is DocsSectionSlug {
  return DOCS_NAV_ITEMS.some((item) => item.slug === value);
}

export function DocsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (slug: DocsSectionSlug) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to: "/docs/$section", params: { section: slug }, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {DOCS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === `/docs/${item.slug}`;
              return (
                <SidebarMenuItem key={item.slug}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => handleSectionClick(item.slug)}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-foreground"
                          : "size-4 shrink-0 text-muted-foreground/60"
                      }
                    />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
