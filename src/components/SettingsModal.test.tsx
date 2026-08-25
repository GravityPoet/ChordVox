// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import SettingsModal from "./SettingsModal";

type MockSidebarItem = {
  id: string;
  label: string;
  group?: string;
};

type MockSidebarProps = {
  sidebarItems: MockSidebarItem[];
  sidebarWidth?: string;
  activeSection: string;
  onSectionChange: (section: string) => void;
  children: React.ReactNode;
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./ui/SidebarModal", () => ({
  default: ({
    sidebarItems,
    sidebarWidth,
    activeSection,
    onSectionChange,
    children,
  }: MockSidebarProps) => (
    <div data-active-section={activeSection} data-sidebar-width={sidebarWidth}>
      {sidebarItems.map((item) => (
        <button
          type="button"
          key={item.id}
          data-section-id={item.id}
          data-group={item.group}
          onClick={() => onSectionChange(item.id)}
        >
          {item.label}
        </button>
      ))}
      {children}
    </div>
  ),
}));

vi.mock("./SettingsPage", () => ({
  default: ({ activeSection }: { activeSection: string }) => (
    <div data-settings-page-section={activeSection} />
  ),
}));

describe("SettingsModal navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("opens user history directly while keeping diagnostics as a separate settings page", async () => {
    const onOpenTranscriptionHistory = vi.fn();

    await act(async () => {
      root.render(
        <SettingsModal
          open={true}
          onOpenChange={vi.fn()}
          onOpenTranscriptionHistory={onOpenTranscriptionHistory}
        />
      );
    });

    const historyButton = container.querySelector(
      'button[data-section-id="transcriptionHistory"]'
    ) as HTMLButtonElement;
    const diagnosticsButton = container.querySelector(
      'button[data-section-id="callRecords"]'
    ) as HTMLButtonElement;

    expect(historyButton.dataset.group).toBe("settingsModal.groups.speech");
    expect(diagnosticsButton.dataset.group).toBe("settingsModal.groups.system");
    expect(
      container.querySelector("[data-sidebar-width]")?.getAttribute("data-sidebar-width")
    ).toBe("w-[15rem]");

    await act(async () => {
      historyButton.click();
    });
    expect(onOpenTranscriptionHistory).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector("[data-active-section]")?.getAttribute("data-active-section")
    ).toBe("account");

    await act(async () => {
      diagnosticsButton.click();
    });
    expect(
      container.querySelector("[data-active-section]")?.getAttribute("data-active-section")
    ).toBe("callRecords");
  });
});
