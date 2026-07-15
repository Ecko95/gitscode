import type { CodexAccountUsage, CodexResetCredit } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

function UsageWindow(props: { label: string; window: CodexAccountUsage["primary"] }) {
  return (
    <div className="grid gap-1">
      <div className="flex justify-between text-sm">
        <span>{props.label}</span>
        <span>
          {props.window ? `${Math.round(props.window.usedPercent)}% used` : "Unavailable"}
        </span>
      </div>
      {props.window ? (
        <progress className="h-2 w-full" max={100} value={props.window.usedPercent} />
      ) : null}
    </div>
  );
}

export function formatCodexResetExpiry(expiresAt: string | null): string {
  return expiresAt ? `Expires ${new Date(expiresAt).toLocaleString()}` : "Expiry unavailable";
}

export function CodexUsageDialog(props: {
  mode: "status" | "usage" | null;
  model: string | null;
  workspace: string | null;
  usage: CodexAccountUsage | undefined;
  error: string | null;
  isLoading: boolean;
  isRedeeming: boolean;
  onClose: () => void;
  onRedeem: (credit: CodexResetCredit) => void;
}) {
  return (
    <Dialog open={props.mode !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.mode === "status" ? "Codex status" : "Codex usage"}</DialogTitle>
        </DialogHeader>
        {props.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
        {props.error ? <p className="text-destructive text-sm">{props.error}</p> : null}
        {!props.isLoading && !props.error && !props.usage ? (
          <p className="text-muted-foreground text-sm">Usage unavailable</p>
        ) : null}
        {props.usage ? (
          <div className="grid gap-4">
            {props.mode === "status" ? (
              <div className="grid gap-1 text-sm">
                <p>Model: {props.model ?? "Unavailable"}</p>
                <p className="truncate">Workspace: {props.workspace ?? "Unavailable"}</p>
              </div>
            ) : null}
            <p className="text-muted-foreground text-sm">
              Plan: {props.usage.planType ?? "Unavailable"}
            </p>
            <UsageWindow label="5-hour limit" window={props.usage.primary} />
            <UsageWindow label="Weekly limit" window={props.usage.secondary} />
            {props.mode === "usage" ? (
              <div className="grid gap-2">
                <h3 className="font-medium text-sm">
                  Usage limit resets ({props.usage.availableResetCount})
                </h3>
                {props.usage.resetCredits.map((credit) => (
                  <div className="flex items-center justify-between gap-3 text-sm" key={credit.id}>
                    <span>
                      {credit.title ?? "Full reset"} · {formatCodexResetExpiry(credit.expiresAt)}
                    </span>
                    {credit.status === "available" ? (
                      <Button
                        disabled={props.isRedeeming}
                        onClick={() => props.onRedeem(credit)}
                        size="sm"
                        variant="outline"
                      >
                        Redeem
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
