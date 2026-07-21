import type { UsageSummary } from "@t3tools/contracts";
import { BotIcon, CircleDollarSignIcon, CircleIcon, GaugeIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

import {
  EmptyState,
  SignalRow,
  StatBlock,
  StatusPill,
  formatCount,
  formatIsoDate,
  formatPercent,
  formatUsd,
} from "./primitives";

export function UsagePanel({
  usage,
  loading,
  error,
  onRefresh,
}: {
  usage: UsageSummary | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
}) {
  const errorMessage = error instanceof Error ? error.message : null;
  const topModels = usage?.models.slice(0, 8) ?? [];

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">Usage</h2>
            <StatusPill label="local host" tone="default" />
            <StatusPill label={usage?.costEstimate ? "estimated" : "checking"} tone="warning" />
            <StatusPill label={usage ? formatUsd(usage.estimatedCostUsd) : "..."} tone="default" />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {usage
              ? `${formatCount(usage.totals.totalTokens)} tokens scanned | ${formatIsoDate(
                  usage.checkedAt,
                )}`
              : "Reading local provider JSONL usage logs."}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      {loading && !usage ? (
        <EmptyState label="Reading usage logs..." />
      ) : !usage ? (
        <EmptyState label="Usage summary unavailable." />
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4">
            <StatBlock
              label="Tokens"
              value={formatCount(usage.totals.totalTokens)}
              icon={GaugeIcon}
            />
            <StatBlock
              label="Cost"
              value={formatUsd(usage.estimatedCostUsd)}
              icon={CircleDollarSignIcon}
            />
            <StatBlock
              label="Requests"
              value={formatCount(usage.models.reduce((total, row) => total + row.requestCount, 0))}
              icon={BotIcon}
            />
            <StatBlock label="Days" value={formatCount(usage.days.length)} icon={CircleIcon} />
          </div>

          <div className="grid border-b border-border/60 md:grid-cols-2">
            {usage.windows.length === 0 ? (
              <EmptyState label="No Codex rolling-window rate limit records found." />
            ) : (
              usage.windows.map((window) => (
                <SignalRow
                  key={`${window.provider}:${window.label}`}
                  label={`${window.provider} ${window.label}`}
                  value={formatPercent(window.remainingPercent)}
                  tone={
                    (window.remainingPercent ?? 100) < 20
                      ? "danger"
                      : (window.remainingPercent ?? 100) < 40
                        ? "warning"
                        : "success"
                  }
                  detail={`resets ${formatIsoDate(window.resetAt)} | source ${
                    window.sourcePath ?? "unknown"
                  }`}
                />
              ))
            )}
          </div>

          <ScrollArea chainVerticalScroll scrollFade hideScrollbars className="w-full">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase text-muted-foreground/70">
                <tr>
                  <th className="px-4 py-2 font-medium sm:px-5">Provider / model</th>
                  <th className="px-3 py-2 font-medium">Requests</th>
                  <th className="px-3 py-2 font-medium">Input</th>
                  <th className="px-3 py-2 font-medium">Cached</th>
                  <th className="px-3 py-2 font-medium">Output</th>
                  <th className="px-3 py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {topModels.map((row) => (
                  <tr key={`${row.provider}:${row.model}`}>
                    <td className="px-4 py-2.5 sm:px-5">
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusPill label={row.provider} tone="default" />
                        <span className="truncate font-medium">{row.model}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(row.requestCount)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(row.tokens.inputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(
                        row.tokens.cachedInputTokens +
                          row.tokens.cacheCreationInputTokens +
                          row.tokens.cacheReadInputTokens,
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatCount(row.tokens.outputTokens + row.tokens.reasoningOutputTokens)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatUsd(row.estimatedCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>

          <div className="grid gap-2 px-4 py-3 sm:px-5">
            {usage.sources.map((source) => (
              <div key={source.provider} className="min-w-0 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{source.provider}</span> |{" "}
                {source.status} | {formatCount(source.scannedFilePaths.length)} files |{" "}
                {source.note ?? source.homePath}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
