import type { UsageProvider, UsageWindowSummary } from "@t3tools/contracts";

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
    <div className="grid min-w-0 grid-cols-[3rem_minmax(5rem,1fr)_auto] items-center gap-2 text-[11px]">
      <span className="font-medium text-muted-foreground">{props.label}</span>
      {used === null || used === undefined ? (
        <span className="col-span-2 text-muted-foreground">Usage unavailable</span>
      ) : (
        <>
          <progress
            aria-label={`${name} ${props.label} usage`}
            className="h-1.5 w-full accent-primary"
            max={100}
            value={clampUsagePercent(used)}
          />
          <span className="whitespace-nowrap text-muted-foreground">
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
  return (
    <div className="mb-1 grid gap-1 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
      <UsageRow provider={props.provider} label="5h" window={props.windows.fiveHour} />
      <UsageRow provider={props.provider} label="weekly" window={props.windows.weekly} />
    </div>
  );
}
