// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { AccountSection, type AccountSectionProps } from "./AccountSection";

const { mockTranslate, toast } = vi.hoisted(() => ({
  toast: vi.fn(),
  mockTranslate: (key: string) =>
    ({
      "support.card.title": "Support & feedback",
      "support.card.description": "Need help?",
      "support.card.github": "GitHub project",
      "support.card.email": "Contact the author",
      "support.card.emailAddress": "gravitypoet@icloud.com",
      "support.emailCopied.title": "Email copied",
      "support.emailCopied.description": "Email copied to clipboard",
      "support.copyFailed.title": "Could not copy email",
      "support.copyFailed.description": "Copy the address manually",
    })[key] || key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en" },
    t: mockTranslate,
  }),
}));

vi.mock("../EfficiencyOverview", () => ({
  default: () => <div data-testid="efficiency-overview" />,
}));

vi.mock("../ui/toastContext", () => ({
  useToast: () => ({ toast }),
}));

describe("AccountSection support links", () => {
  let container: HTMLDivElement;
  let root: Root;
  let openExternal: ReturnType<typeof vi.fn>;
  let writeClipboard: ReturnType<typeof vi.fn>;
  let showAlertDialog: AccountSectionProps["showAlertDialog"];

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    openExternal = vi.fn().mockResolvedValue({ success: true });
    writeClipboard = vi.fn().mockResolvedValue({ success: true });
    showAlertDialog = vi.fn();
    toast.mockReset();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { openExternal, writeClipboard },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const renderSection = async () => {
    const props: AccountSectionProps = {
      isLoaded: true,
      isSignedIn: false,
      user: null,
      usage: null,
      licenseStatus: {
        success: true,
        configured: true,
        status: "active",
        isActive: true,
        keyPresent: true,
        plan: "owner",
      },
      licenseKeyInput: "",
      setLicenseKeyInput: vi.fn(),
      showLicenseKeyInput: false,
      setShowLicenseKeyInput: vi.fn(),
      licenseBusyAction: null,
      licenseValidationFeedback: null,
      trialOfferAvailable: false,
      startProTrialFromAccount: vi.fn().mockResolvedValue(undefined),
      openLicensePurchasePage: vi.fn(),
      handleActivateLicense: vi.fn(),
      handleValidateLicense: vi.fn(),
      handleClearLicense: vi.fn(),
      handleSignOut: vi.fn(),
      isSigningOut: false,
      showAlertDialog,
    };

    await act(async () => {
      root.render(<AccountSection {...props} />);
    });
  };

  it("keeps support as a compact footer after the account metrics", async () => {
    await renderSection();

    const statusCard = container.querySelector(".account-status-card");
    const supportCard = container.querySelector('[data-testid="account-support-card"]');
    const efficiencyOverview = container.querySelector('[data-testid="efficiency-overview"]');
    const githubLink = container.querySelector(
      '[data-testid="account-support-github"]'
    ) as HTMLAnchorElement;
    const emailButton = container.querySelector(
      '[data-testid="account-support-email"]'
    ) as HTMLButtonElement;

    expect(statusCard).toBeTruthy();
    expect(supportCard).toBeTruthy();
    expect(efficiencyOverview).toBeTruthy();
    expect(supportCard!.tagName).toBe("SECTION");
    expect(supportCard!.classList.contains("border-t")).toBe(true);
    expect(supportCard!.classList.contains("glass-panel--hoverable")).toBe(false);
    expect(
      statusCard!.compareDocumentPosition(efficiencyOverview!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      efficiencyOverview!.compareDocumentPosition(supportCard!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(githubLink.getAttribute("href")).toBe("https://github.com/GravityPoet/ChordVox");
    expect(emailButton.tagName).toBe("BUTTON");
    expect(emailButton.getAttribute("type")).toBe("button");
    expect(emailButton.getAttribute("href")).toBeNull();
    expect(githubLink.getAttribute("target")).toBe("_blank");
    expect(githubLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(supportCard!.textContent).toContain("GravityPoet/ChordVox");
    expect(supportCard!.textContent).toContain("gravitypoet@icloud.com");
  });

  it("opens GitHub safely and copies the email without launching a browser", async () => {
    await renderSection();

    const githubLink = container.querySelector(
      '[data-testid="account-support-github"]'
    ) as HTMLAnchorElement;
    const emailButton = container.querySelector(
      '[data-testid="account-support-email"]'
    ) as HTMLButtonElement;
    await act(async () => {
      githubLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      emailButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/GravityPoet/ChordVox", {
      showError: false,
    });
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard).toHaveBeenCalledWith("gravitypoet@icloud.com");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Email copied", variant: "success" })
    );
  });

  it("shows a copy error without opening a browser when clipboard access fails", async () => {
    writeClipboard.mockResolvedValueOnce({ success: false });
    await renderSection();

    const emailButton = container.querySelector(
      '[data-testid="account-support-email"]'
    ) as HTMLButtonElement;
    await act(async () => {
      emailButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(showAlertDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy email" })
    );
  });
});
