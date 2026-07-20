import type { GsdPhase, VerificationGate } from "@t3tools/contracts";
import { CircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const NUMBER_FORMAT = new Intl.NumberFormat();
const USD_FORMAT = new Intl.NumberFormat(undefined, {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function formatCpuTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  }
  return `${(minutes / 60).toFixed(2)}h`;
}

export const PHASE_STATUS_LABELS: Record<GsdPhase["status"], string> = {
  unknown: "Unknown",
  discussing: "Discussing",
  planned: "Planned",
  executing: "Executing",
  blocked: "Blocked",
  completed: "Completed",
  verified: "Verified",
};

export const GATE_STATUS_LABELS: Record<VerificationGate["status"], string> = {
  unknown: "Unknown",
  missing: "Missing",
  pending: "Pending",
  blocked: "Blocked",
  failed: "Failed",
  passed: "Passed",
};

export function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

export function formatTokenLimit(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "unknown";
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return formatCount(value);
}

export function formatUsd(value: number): string {
  return USD_FORMAT.format(value);
}

export function formatIsoDate(value: string | null | undefined): string {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "..." : `${value.toFixed(0)}%`;
}

export function formatSlotRemaining(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function tallyValues<T extends string>(values: ReadonlyArray<T>): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function statusTone(status: string): "default" | "warning" | "danger" | "success" {
  if (status === "passed" || status === "verified" || status === "completed") {
    return "success";
  }
  if (status === "blocked" || status === "failed") {
    return "danger";
  }
  if (status === "missing" || status === "pending" || status === "planned") {
    return "warning";
  }
  return "default";
}

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: ReturnType<typeof statusTone>;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium",
        tone === "success" &&
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" &&
          "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "default" && "border-border bg-muted/35 text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

export function StatBlock({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof CircleIcon;
}) {
  return (
    <div className="min-w-0 border-r border-b border-border/60 px-4 py-3 last:border-r-0 sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground/70">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate font-mono text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return <div className="px-4 py-3 text-xs text-muted-foreground sm:px-5">{label}</div>;
}

export function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center justify-between border-b border-border/60 px-4 py-2.5 sm:px-5">
      <h3 className="truncate text-xs font-semibold uppercase text-muted-foreground/80">{title}</h3>
      <span className="font-mono text-[11px] text-muted-foreground">{formatCount(count)}</span>
    </div>
  );
}

export function SignalRow({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: ReturnType<typeof statusTone>;
}) {
  return (
    <div className="grid min-h-16 gap-1 border-b border-r border-border/60 px-4 py-3 last:border-r-0 sm:px-5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        <StatusPill label={value} tone={tone} />
      </div>
      <div className="line-clamp-2 text-[11px] text-muted-foreground">{detail}</div>
    </div>
  );
}
