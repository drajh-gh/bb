// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarTopReserveRow } from "./SidebarChrome";

const state = vi.hoisted(() => ({
  desktopChrome: false,
  sidebarIdentity: null as { label: string; mark: string } | null,
}));

vi.mock("@/components/ui/sidebar.js", () => ({
  useCloseMobileSidebar: () => vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { sidebarIdentity: state.sidebarIdentity },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  CHROME_ROW_CLASS: "flex chrome-row",
  getBbDesktopInfo: () => ({}),
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS: "desktop-no-drag",
  MACOS_WINDOW_DRAG_CLASS: "desktop-drag",
  shouldUseMacosDesktopChrome: () => state.desktopChrome,
}));

vi.mock("./SidebarHistoryNavigationControls", () => ({
  SidebarHistoryNavigationControls: ({
    className,
  }: {
    className?: string;
  }) => <div className={className}>History controls</div>,
}));

beforeEach(() => {
  state.desktopChrome = false;
  state.sidebarIdentity = null;
});

afterEach(cleanup);

describe("SidebarTopReserveRow", () => {
  it("preserves the unbranded header when no identity is configured", () => {
    render(<SidebarTopReserveRow testId="sidebar-header" />);

    expect(screen.queryByTestId("sidebar-identity-mark")).toBeNull();
    expect(screen.getByText("History controls")).toBeTruthy();
  });

  it("renders the configured identity before the history controls", () => {
    state.sidebarIdentity = {
      label: "Haneda Operations",
      mark: "羽田",
    };

    render(<SidebarTopReserveRow testId="sidebar-header" />);

    const mark = screen.getByRole("img", { name: "Haneda Operations" });
    expect(mark.textContent).toBe("羽田");
    expect(mark.nextElementSibling?.textContent).toBe("History controls");
  });

  it("keeps the identity interactive region out of macOS window dragging", () => {
    state.desktopChrome = true;
    state.sidebarIdentity = {
      label: "Haneda Operations",
      mark: "羽田",
    };

    render(<SidebarTopReserveRow testId="sidebar-header" />);

    expect(screen.getByTestId("sidebar-header").className).toContain(
      "desktop-drag",
    );
    expect(screen.getByTestId("sidebar-identity-mark").className).toContain(
      "desktop-no-drag",
    );
    expect(screen.getByText("History controls").className).toContain(
      "desktop-no-drag",
    );
  });
});
