import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@bb/shared-ui/lib/utils";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import {
  CHROME_ROW_CLASS,
  getBbDesktopInfo,
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { SidebarHistoryNavigationControls } from "./SidebarHistoryNavigationControls";
import { useSystemConfig } from "@/hooks/queries/system-queries";

export function SidebarTopReserveRow({ testId }: { testId: string }) {
  const closeOnMobile = useCloseMobileSidebar();
  const [desktopInfo] = useState(getBbDesktopInfo);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const { data: systemConfig } = useSystemConfig();
  const sidebarIdentity = systemConfig?.sidebarIdentity;

  return (
    <div
      data-testid={testId}
      className={cn(
        CHROME_ROW_CLASS,
        "shrink-0 justify-end px-2",
        usesDesktopChrome && MACOS_WINDOW_DRAG_CLASS,
      )}
    >
      {sidebarIdentity ? (
        <span
          aria-label={sidebarIdentity.label}
          className={cn(
            "mr-auto inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-sm border border-primary/35 bg-primary/10 px-1.5 text-xs font-semibold tracking-wide text-primary shadow-sm",
            usesDesktopChrome && MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
          )}
          data-testid="sidebar-identity-mark"
          role="img"
          title={sidebarIdentity.label}
        >
          {sidebarIdentity.mark}
        </span>
      ) : null}
      <SidebarHistoryNavigationControls
        onNavigate={closeOnMobile}
        className={
          usesDesktopChrome ? MACOS_CHROME_CONTROL_NO_DRAG_CLASS : undefined
        }
      />
    </div>
  );
}

export function SidebarResizeHandle({
  isResizing,
  onMouseDown,
  testId,
}: {
  isResizing: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "absolute -right-1.5 top-0 z-30 hidden h-full w-3 cursor-col-resize md:block",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-sidebar-border",
        isResizing && "before:bg-sidebar-border",
      )}
      onMouseDown={onMouseDown}
    />
  );
}
