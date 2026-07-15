import type { UsageProvider, UsageWindowSummary } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";

import { clampUsagePercent } from "../../lib/providerUsage";

type UsageWindows = {
  fiveHour: UsageWindowSummary | null;
  weekly: UsageWindowSummary | null;
};

function UsageRow(props: {
  provider: UsageProvider;
  label: "5h" | "weekly";
  window: UsageWindowSummary | null;
}) {
  const name = props.provider === "codex" ? "Codex" : "Claude";
  const used = props.window?.usedPercent;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_30%_minmax(0,1fr)] items-center gap-2 text-[11px]">
      <span className="font-medium text-muted-foreground">{props.label}</span>
      {used === null || used === undefined ? (
        <span className="col-span-2 text-muted-foreground">Usage unavailable</span>
      ) : (
        <>
          <progress
            aria-label={`${name} ${props.label} usage`}
            className="h-1.5 w-full min-w-16 accent-primary"
            max={100}
            value={clampUsagePercent(used)}
          />
          <span
            className="truncate text-right text-muted-foreground"
            title={
              props.window?.resetAt
                ? `${Math.round(used)}% · Resets ${new Date(props.window.resetAt).toLocaleString()}`
                : `${Math.round(used)}%`
            }
          >
            {Math.round(used)}%
            {props.window?.resetAt
              ? ` · Resets ${new Date(props.window.resetAt).toLocaleString()}`
              : ""}
          </span>
        </>
      )}
    </div>
  );
}

export function ComposerUsageBars(props: { provider: UsageProvider; windows: UsageWindows }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("t3.composer-usage-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("t3.composer-usage-collapsed", String(next));
    } catch {
      // Storage is optional; the control still works for this page load.
    }
  };

  if (collapsed) {
    return (
      <div className="mb-1 flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1 text-[11px] text-muted-foreground">
        <span>Usage</span>
        <button
          aria-expanded="false"
          aria-label="Expand usage"
          className="rounded p-0.5 hover:bg-muted"
          onClick={toggleCollapsed}
          title="Expand usage"
          type="button"
        >
          <ChevronUpIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative mb-1 grid gap-1 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 pr-9">
      <UsageRow provider={props.provider} label="5h" window={props.windows.fiveHour} />
      <UsageRow provider={props.provider} label="weekly" window={props.windows.weekly} />
      <button
        aria-expanded="true"
        aria-label="Collapse usage"
        className="absolute top-1.5 right-2 rounded p-0.5 text-muted-foreground hover:bg-muted"
        onClick={toggleCollapsed}
        title="Collapse usage"
        type="button"
      >
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
