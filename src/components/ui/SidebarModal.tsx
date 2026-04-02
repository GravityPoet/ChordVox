import React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { getCachedPlatform } from "../../utils/platform";

export interface SidebarItem<T extends string> {
  id: T;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
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
  const isMac = React.useMemo(() => getCachedPlatform() === "darwin", []);
  const compactSidebar = sidebarItems.length >= 9;

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
        className={`ml-auto text-[8px] font-semibold uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-md shrink-0 ${
          item.badgeVariant === "new"
            ? "bg-primary/10 text-primary dark:bg-primary/15"
            : item.badgeVariant === "update"
              ? "bg-warning/10 text-warning dark:bg-warning/15"
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed inset-0 z-50 h-screen w-screen max-h-none max-w-none rounded-none p-0 overflow-hidden bg-background border-0 shadow-none dark:bg-surface-1 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
          <div className="relative h-full overflow-hidden">
            <DialogPrimitive.Close className="absolute right-4 top-4 z-10 rounded-md p-1.5 opacity-40 ring-offset-background transition-all hover:opacity-100 bg-transparent hover:bg-muted dark:hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1">
              <X className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>

            <div className="flex h-full">
              {/* Sidebar */}
              <div
                className={`${sidebarWidth} shrink-0 border-r border-border/40 dark:border-border-subtle flex flex-col bg-surface-1 dark:bg-surface-0`}
              >
                {/* Reserve title-bar area on macOS to avoid traffic-light overlap */}
                <div className={isMac ? "h-10 shrink-0" : "h-2.5 shrink-0"} aria-hidden="true" />

                {/* Navigation */}
                <nav
                  aria-label={title}
                  className={`relative flex-1 overflow-y-auto ${
                    compactSidebar ? "px-2 pt-1.5 pb-1.5" : "px-3 pt-3 pb-3"
                  }`}
                >
                  {groupedItems.map((group, groupIndex) => (
                    <div
                      key={groupIndex}
                      className={
                        groupIndex > 0
                          ? compactSidebar
                            ? "mt-2.5 border-t border-border/30 pt-2 dark:border-border-subtle/80"
                            : "mt-5 border-t border-border/30 pt-4 dark:border-border-subtle/80"
                          : ""
                      }
                    >
                      {group.label && (
                        <div className={compactSidebar ? "px-2.5 pb-0.5 pt-0.5" : "px-3 pb-1.5 pt-1"}>
                          <span
                            className={`font-semibold tracking-[0.12em] uppercase text-muted-foreground/50 dark:text-muted-foreground/65 ${
                              compactSidebar ? "text-[9px]" : "text-[11px]"
                            }`}
                          >
                            {group.label}
                          </span>
                        </div>
                      )}
                      <div className={compactSidebar ? "space-y-0" : "space-y-1.5"}>
                        {group.items.map((item) => {
                          const Icon = item.icon;
                          const isActive = activeSection === item.id;
                          return (
                            <button
                              key={item.id}
                              data-section-id={item.id}
                              onClick={() => onSectionChange(item.id)}
                              className={`group relative w-full flex items-center text-left rounded-xl transition-all duration-100 outline-none ${
                                compactSidebar
                                  ? "gap-2 px-2.5 py-1.5 text-[12px]"
                                  : "gap-3 px-3 py-3 text-[13px]"
                              } ${
                                isActive
                                  ? "text-foreground bg-muted dark:bg-surface-raised"
                                  : "text-muted-foreground dark:text-foreground/60 hover:text-foreground hover:bg-muted/50 dark:hover:bg-surface-2"
                              }`}
                            >
                              {/* Active indicator bar */}
                              {isActive && (
                                <div
                                  className={`absolute left-0 top-1/2 -translate-y-1/2 w-0.5 rounded-full bg-primary ${
                                    compactSidebar ? "h-4.5" : "h-5"
                                  }`}
                                />
                              )}
                              <div
                                className={`flex items-center justify-center rounded-lg shrink-0 transition-all duration-100 ${
                                  compactSidebar ? "h-6 w-6" : "h-7 w-7"
                                } ${
                                  isActive ? "bg-primary/10 dark:bg-primary/15" : "bg-transparent"
                                }`}
                              >
                                <Icon
                                  className={`shrink-0 transition-colors duration-100 ${
                                    compactSidebar ? "h-[15px] w-[15px]" : "h-[18px] w-[18px]"
                                  } ${
                                    isActive
                                      ? "text-primary"
                                      : "text-muted-foreground/60 dark:text-foreground/40 group-hover:text-foreground/80"
                                  }`}
                                />
                              </div>
                              <span
                                className={`flex-1 truncate leading-tight ${isActive ? "font-medium" : "font-normal"}`}
                              >
                                {item.label}
                              </span>
                              {renderBadge(item)}
                              {item.shortcut && !item.badge && (
                                <kbd className="ml-auto text-[9px] text-muted-foreground/25 font-mono shrink-0">
                                  {item.shortcut}
                                </kbd>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>

                {/* Footer / version */}
                {version && (
                  <div
                    className={`border-t border-border/20 dark:border-border-subtle ${
                      compactSidebar ? "px-2.5 py-1.5" : "px-3 py-2.5"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <div className="h-1 w-1 rounded-full bg-success/60" />
                      <span
                        className={`text-muted-foreground/40 tabular-nums tracking-wide ${
                          compactSidebar ? "text-[8px]" : "text-[9px]"
                        }`}
                      >
                        v{version}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Main Content */}
              <div className="flex-1 overflow-y-auto bg-background dark:bg-surface-1">
                <div className="p-6">{children}</div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
