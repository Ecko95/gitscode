import type {
  EnvironmentId,
  UsageModelBreakdownEntry,
  UsageProvider,
  UsageWindowKey,
  UsageWindowSummary,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { GaugeIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import {
  clampUsagePercent,
  readUsageSummary,
  selectProviderUsageWindows,
} from "../../lib/providerUsage";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import {
  buildCostSegments,
  formatTokens,
  formatUsd,
  totalCostUsd,
  totalTokens,
} from "./UsagePanel.logic";

const SEGMENT_CLASSES = [
  "bg-primary",
  "bg-primary/75",
  "bg-primary/55",
  "bg-primary/35",
  "bg-primary/20",
] as const;

const WINDOW_LABELS: Record<UsageWindowKey, string> = {
  fiveHour: "5h",
  weekly: "7d",
};

function SectionLabel(props: { children: ReactNode }) {
  return (
    <div className="font-mono text-[9px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
      {props.children}
    </div>
  );
}

function RateWindowRow(props: {
  providerLabel: string;
  windowLabel: string;
  window: UsageWindowSummary;
}) {
  const used = props.window.usedPercent;
  if (used === null) return null;
  const resetLabel = props.window.resetAt
    ? `Resets ${new Date(props.window.resetAt).toLocaleString()}`
    : null;
  return (
    <div
      className="grid grid-cols-[minmax(0,5.5rem)_1fr_2.5rem] items-center gap-2 text-[11px]"
      title={resetLabel ?? undefined}
    >
      <span className="truncate text-muted-foreground">
        {props.providerLabel} {props.windowLabel}
      </span>
      <progress
        aria-label={`${props.providerLabel} ${props.windowLabel} usage`}
        className="h-1.5 w-full accent-primary"
        max={100}
        value={clampUsagePercent(used)}
      />
      <span className="text-right font-mono text-muted-foreground">{Math.round(used)}%</span>
    </div>
  );
}

function ModelRow(props: { entry: UsageModelBreakdownEntry; colorIndex: number }) {
  const { entry } = props;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-[2px]", SEGMENT_CLASSES[props.colorIndex])}
      />
      <span className="min-w-0 flex-1 truncate text-foreground" title={entry.model}>
        {entry.model}
      </span>
      <span className="shrink-0 font-mono text-muted-foreground">
        {entry.turns} {entry.turns === 1 ? "turn" : "turns"}
      </span>
      <span
        className="shrink-0 font-mono text-muted-foreground"
        title={`${formatTokens(entry.inputTokens)} in · ${formatTokens(entry.cachedInputTokens)} cached · ${formatTokens(entry.outputTokens)} out`}
      >
        {formatTokens(totalTokens(entry))} tok
      </span>
      <span className="w-14 shrink-0 text-right font-mono font-semibold text-foreground">
        {formatUsd(entry.estCostUsd)}
      </span>
    </div>
  );
}

export function UsagePanelControl(props: { environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const [windowKey, setWindowKey] = useState<UsageWindowKey>("fiveHour");

  const summaryQuery = useQuery({
    queryKey: ["gits", "usage"],
    queryFn: readUsageSummary,
    enabled: open,
    refetchInterval: 60_000,
    retry: false,
  });

  const breakdownQuery = useQuery({
    queryKey: ["usage", "model-breakdown", props.environmentId, windowKey],
    queryFn: () => {
      const api = readEnvironmentApi(props.environmentId);
      if (!api) throw new Error("Environment unavailable");
      return api.provider.usageModelBreakdown({ window: windowKey });
    },
    enabled: open,
    refetchInterval: 60_000,
    retry: false,
  });

  const providerWindows = (["claude", "codex"] as const satisfies ReadonlyArray<UsageProvider>)
    .map((provider) => ({
      provider,
      label: provider === "claude" ? "Claude" : "Codex",
      windows: selectProviderUsageWindows(summaryQuery.data, provider),
    }))
    .filter(({ windows }) => windows.fiveHour !== null || windows.weekly !== null);

  const entries = breakdownQuery.data?.entries ?? [];
  const segments = buildCostSegments(entries);
  const colorIndexByModel = new Map(
    segments.map((segment) => [`${segment.provider} ${segment.model}`, segment.colorIndex]),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Toggle
            className="shrink-0"
            pressed={open}
            aria-label="Toggle usage panel"
            title="Usage"
            variant="outline"
            size="xs"
          >
            <GaugeIcon className="size-3" />
          </Toggle>
        }
      />
      <PopoverPopup align="end" className="w-[22rem]" side="bottom">
        <div className="grid gap-4" data-testid="usage-panel">
          <div className="flex items-center justify-between">
            <SectionLabel>Usage</SectionLabel>
            <div className="flex overflow-hidden rounded-md border border-border">
              {(["fiveHour", "weekly"] as const).map((key) => (
                <button
                  key={key}
                  aria-pressed={windowKey === key}
                  className={cn(
                    "px-2 py-0.5 font-mono text-[10px] font-semibold",
                    windowKey === key
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                  onClick={() => setWindowKey(key)}
                  type="button"
                >
                  {WINDOW_LABELS[key]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <SectionLabel>Rate windows</SectionLabel>
            {providerWindows.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">
                {summaryQuery.isPending && open
                  ? "Loading rate windows…"
                  : "No provider rate windows available."}
              </div>
            ) : (
              providerWindows.map(({ provider, label, windows }) => (
                <div className="grid gap-1" key={provider}>
                  {windows.fiveHour ? (
                    <RateWindowRow
                      providerLabel={label}
                      windowLabel="5h"
                      window={windows.fiveHour}
                    />
                  ) : null}
                  {windows.weekly ? (
                    <RateWindowRow providerLabel={label} windowLabel="7d" window={windows.weekly} />
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="grid gap-1.5">
            <SectionLabel>Models · last {WINDOW_LABELS[windowKey]}</SectionLabel>
            {breakdownQuery.isError ? (
              <div className="text-[11px] text-muted-foreground">Usage breakdown unavailable.</div>
            ) : entries.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">
                {breakdownQuery.isPending && open
                  ? "Loading model usage…"
                  : "No recorded model usage in this window."}
              </div>
            ) : (
              <>
                {segments.length > 0 ? (
                  <div className="flex h-2 overflow-hidden rounded-full border border-border/60 bg-muted">
                    {segments.map((segment) => (
                      <div
                        className={cn("h-full", SEGMENT_CLASSES[segment.colorIndex])}
                        key={`${segment.provider} ${segment.model}`}
                        style={{ width: `${segment.widthPercent}%` }}
                        title={segment.model}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="grid gap-1.5 pt-0.5">
                  {entries.map((entry) => (
                    <ModelRow
                      colorIndex={colorIndexByModel.get(`${entry.provider} ${entry.model}`) ?? 4}
                      entry={entry}
                      key={`${entry.provider} ${entry.model}`}
                    />
                  ))}
                </div>
                <div className="mt-1 flex items-center justify-between border-t border-dashed border-border pt-2">
                  <SectionLabel>Est. window spend</SectionLabel>
                  <span className="font-mono text-sm font-bold text-foreground">
                    {formatUsd(totalCostUsd(entries))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
