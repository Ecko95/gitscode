import { cn } from "~/lib/utils";

import { GITS_COCKPIT_TABS, type GitsCockpitTab } from "./tabs";

export function CockpitTabNav({
  activeTab,
  counts,
  onTabChange,
}: {
  activeTab: GitsCockpitTab;
  counts: Record<GitsCockpitTab, string>;
  onTabChange: (tab: GitsCockpitTab) => void;
}) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-2 py-2 backdrop-blur">
      <div
        role="tablist"
        aria-label="GITS cockpit sections"
        className="flex min-w-0 gap-1 overflow-x-auto"
        onKeyDown={(event) => {
          const count = GITS_COCKPIT_TABS.length;
          const index = GITS_COCKPIT_TABS.findIndex((tab) => tab.id === activeTab);
          let nextIndex: number | null = null;
          if (event.key === "ArrowRight") {
            nextIndex = (index + 1) % count;
          } else if (event.key === "ArrowLeft") {
            nextIndex = (index - 1 + count) % count;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = count - 1;
          }
          if (nextIndex === null) {
            return;
          }
          event.preventDefault();
          const nextTab = GITS_COCKPIT_TABS[nextIndex]!;
          onTabChange(nextTab.id);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`#gits-cockpit-tab-${nextTab.id}`)
            ?.focus();
        }}
      >
        {GITS_COCKPIT_TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`gits-cockpit-tab-${tab.id}`}
              aria-controls={`gits-cockpit-panel-${tab.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors",
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => onTabChange(tab.id)}
            >
              <Icon className="size-3.5" />
              <span>{tab.label}</span>
              <span
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums",
                  selected ? "bg-primary-foreground/15" : "bg-muted text-muted-foreground",
                )}
              >
                {counts[tab.id]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
