import React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getCachedPlatform } from "../../utils/platform";

export interface SidebarItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{
    className?: string;
    "aria-hidden"?: React.AriaAttributes["aria-hidden"];
  }>;
  group?: string;
  description?: string;
  badge?: string;
  badgeVariant?: "default" | "new" | "update" | "dot";
  shortcut?: string;
}

interface SidebarModalProps<T extends string> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  sidebarItems: SidebarItem<T>[];
  activeSection: T;
  onSectionChange: (section: T) => void;
  children: React.ReactNode;
  sidebarWidth?: string;
  version?: string;
}

export default function SidebarModal<T extends string>({
  open,
  onOpenChange,
  title,
  sidebarItems,
  activeSection,
  onSectionChange,
  children,
  sidebarWidth = "w-56",
  version,
}: SidebarModalProps<T>) {
  const { t } = useTranslation();
  const isMac = React.useMemo(() => getCachedPlatform() === "darwin", []);
  const compactSidebar = sidebarItems.length >= 10;
  const contentScrollRef = React.useRef<HTMLDivElement | null>(null);

  const isToastInteractionTarget = React.useCallback((target: EventTarget | null) => {
    return target instanceof HTMLElement && Boolean(target.closest('[data-toast-viewport="true"]'));
  }, []);

  React.useEffect(() => {
    contentScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [activeSection]);

  // Group items by their group property
  const groupedItems = React.useMemo(() => {
    const groups: { label: string | null; items: SidebarItem<T>[] }[] = [];
    let currentGroup: string | null | undefined = undefined;

    for (const item of sidebarItems) {
      const group = item.group ?? null;
      if (group !== currentGroup) {
        groups.push({ label: group, items: [item] });
        currentGroup = group;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }

    return groups;
  }, [sidebarItems]);

  const renderBadge = (item: SidebarItem<T>) => {
    if (!item.badge && item.badgeVariant !== "dot") return null;

    if (item.badgeVariant === "dot") {
      return <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary shrink-0" />;
    }

    return (
      <span
        className={`ml-auto text-[10px] font-semibold uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-md shrink-0 ${
          item.badgeVariant === "new"
            ? "glass-chip glass-chip--accent text-primary"
            : item.badgeVariant === "update"
              ? "bg-warning/10 text-warning"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {item.badge}
      </span>
    );
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Light glass scrim. ControlPanel resets and removes the busy history view
            from rendering while the modal is open (see `showSettings`),
            so the scrim can stay thin/translucent — the sheet reads as glass over
            the real desktop material, not a flat opaque panel. */}
        <DialogPrimitive.Overlay className="settings-modal-overlay fixed inset-0 z-50 bg-white/5 backdrop-blur-xl dark:bg-black/20 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 h-screen w-screen max-h-none max-w-none rounded-none border-0 bg-transparent p-0 shadow-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          onInteractOutside={(event) => {
            const originalTarget =
              "detail" in event && event.detail && "originalEvent" in event.detail
                ? (event.detail.originalEvent?.target ?? null)
                : null;
            if (
              isToastInteractionTarget(event.target) ||
              isToastInteractionTarget(originalTarget)
            ) {
              event.preventDefault();
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          <div className="app-glass-shell settings-modal-shell relative h-full overflow-hidden">
            {!isMac ? (
              <DialogPrimitive.Close className="glass-chip glass-chip--muted absolute right-4 top-4 z-20 rounded-md p-1.5 opacity-90 transition-all hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="sr-only">{t("windowControls.close")}</span>
              </DialogPrimitive.Close>
            ) : null}
            <div className="flex h-full items-stretch">
              {/* Sidebar — fused into the window edge, macOS Settings style */}
              <div
                className={`glass-panel glass-panel--chrome glass-depth-pulse settings-shell-pane settings-shell-pane--sidebar ${sidebarWidth} flex shrink-0 flex-col overflow-hidden`}
              >
                {/* Reserve title-bar area on macOS so the nav clears traffic lights
                    with breathing room before the first item. */}
                <div className={isMac ? "h-13 shrink-0" : "h-3 shrink-0"} aria-hidden="true" />

                {/* Navigation */}
                <nav
                  aria-label={title}
                  className={`sidebar-scroll-fade relative flex-1 overflow-y-auto ${
                    compactSidebar
                      ? isMac
                        ? "px-2.5 pt-2 pb-4"
                        : "px-2.5 pt-0.5 pb-4"
                      : isMac
                        ? "px-2.5 pt-2.5 pb-3.5"
                        : "px-2.5 pt-1.25 pb-3.5"
                  }`}
                >
                  <div
                    className={
                      compactSidebar ? "flex min-h-full flex-col justify-between gap-1.5" : ""
                    }
                  >
                    {groupedItems.map((group, groupIndex) => (
                      <div
                        key={groupIndex}
                        className={
                          groupIndex > 0
                            ? compactSidebar
                              ? "border-t border-border/30 pt-1.5"
                              : "mt-3.5 border-t border-border/30 pt-2.5"
                            : ""
                        }
                      >
                        {group.label && (
                          <div
                            className={compactSidebar ? "px-2 pb-0.5 pt-0" : "px-2.5 pb-0.5 pt-0.5"}
                          >
                            <span
                              className={`font-semibold tracking-[0.12em] uppercase text-muted-foreground/65 ${
                                compactSidebar ? "text-[10.5px]" : "text-[11px]"
                              }`}
                            >
                              {group.label}
                            </span>
                          </div>
                        )}
                        <div className={compactSidebar ? "space-y-1" : "space-y-1"}>
                          {group.items.map((item) => {
                            const Icon = item.icon;
                            const isActive = activeSection === item.id;
                            return (
                              <button
                                type="button"
                                key={item.id}
                                data-section-id={item.id}
                                aria-current={isActive ? "page" : undefined}
                                onClick={() => onSectionChange(item.id)}
                                title={item.label}
                                className={`group relative w-full flex items-center text-left rounded-xl transition-[background-color,border-color,box-shadow,color] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                                  compactSidebar
                                    ? "gap-2 px-2 py-1 text-[12.5px]"
                                    : "gap-2.5 px-2.5 py-2.5 text-[13px]"
                                } ${
                                  isActive
                                    ? "settings-sidebar-item settings-sidebar-item--active text-foreground"
                                    : "settings-sidebar-item text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                {/* Active indicator bar */}
                                {isActive && (
                                  <div
                                    className={`absolute left-[3px] top-1/2 -translate-y-1/2 rounded-full bg-primary/85 ${
                                      compactSidebar ? "h-4 w-[2px]" : "h-[18px] w-[2px]"
                                    }`}
                                  />
                                )}
                                <div
                                  className={`settings-sidebar-item__icon flex items-center justify-center rounded-lg shrink-0 transition-all duration-100 ${
                                    compactSidebar ? "h-6 w-6" : "h-7 w-7"
                                  } ${isActive ? "settings-sidebar-item__icon--active" : ""}`}
                                >
                                  <Icon
                                    aria-hidden="true"
                                    className={`shrink-0 transition-colors duration-100 ${
                                      compactSidebar ? "h-3.5 w-3.5" : "h-[18px] w-[18px]"
                                    } ${
                                      isActive
                                        ? "text-primary"
                                        : "text-muted-foreground/60 group-hover:text-foreground/80"
                                    }`}
                                  />
                                </div>
                                <span className="flex-1 truncate leading-tight font-normal">
                                  {item.label}
                                </span>
                                {renderBadge(item)}
                                {item.shortcut && !item.badge && (
                                  <kbd className="ml-auto text-[11px] text-muted-foreground/60 font-mono shrink-0">
                                    {item.shortcut}
                                  </kbd>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </nav>

                {/* Footer / version */}
                {version && !compactSidebar && (
                  <div
                    className={`border-t border-border/20 ${
                      compactSidebar ? "px-2.5 py-1.5" : "px-3 py-2.5"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="h-1 w-1 rounded-full bg-success/60" />
                      <span
                        className={`text-muted-foreground/40 tabular-nums tracking-wide ${
                          compactSidebar ? "text-[10px]" : "text-[11px]"
                        }`}
                      >
                        v{version}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Main Content */}
              <div className="settings-canvas settings-shell-pane settings-shell-pane--content shimmer-on-mount flex min-w-0 flex-1 flex-col overflow-hidden">
                <div
                  ref={contentScrollRef}
                  className="scroll-edge-fade-top min-h-0 flex-1 overflow-y-auto"
                >
                  <div
                    className={`section-entrance flex min-h-full flex-col px-6 pb-4 sm:px-7 sm:pb-5 ${
                      isMac ? "pt-8" : "pt-7 sm:pt-8"
                    }`}
                  >
                    {children}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
