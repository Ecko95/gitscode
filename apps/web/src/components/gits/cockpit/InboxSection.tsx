import type { CockpitInboxFilter, CockpitInboxItem } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InboxIcon, PinIcon } from "lucide-react";
import { useState } from "react";

import type { GitsEnvironmentClient } from "~/gitsClient";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";

import { EmptyState, StatusPill, formatIsoDate } from "./primitives";
import {
  INBOX_FILTERS,
  inboxItemDeepLink,
  inboxStateLabel,
  inboxStateTone,
  isInboxItemUnread,
  orderedInboxTimeline,
} from "./inbox/inbox.logic";

export function InboxSection({
  readGitsClient,
  environmentId,
}: {
  readonly readGitsClient: () => GitsEnvironmentClient;
  readonly environmentId: string | null;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<CockpitInboxFilter>("unread");
  const queryKey = ["gits", "cockpit-inbox", environmentId, filter] as const;
  const inbox = useQuery({
    queryKey,
    queryFn: () => readGitsClient().cockpitInbox.list({ filter }),
    enabled: environmentId !== null,
    refetchInterval: 10_000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["gits", "cockpit-inbox", environmentId] });
  const markRead = useMutation({
    mutationFn: (id: string) => readGitsClient().cockpitInbox.markRead({ id }),
    onSuccess: refresh,
  });
  const markAllRead = useMutation({
    mutationFn: () => readGitsClient().cockpitInbox.markAllRead({ filter }),
    onSuccess: refresh,
  });
  const pin = useMutation({
    mutationFn: (item: CockpitInboxItem) =>
      readGitsClient().cockpitInbox.pin({ id: item.id, pinned: !item.pinned }),
    onSuccess: refresh,
  });
  const openItem = async (item: CockpitInboxItem) => {
    if (isInboxItemUnread(item)) await markRead.mutateAsync(item.id);
    window.location.assign(inboxItemDeepLink(item));
  };

  return (
    <section className="border-b border-border/60" aria-labelledby="cockpit-inbox-heading">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <div>
          <h3 id="cockpit-inbox-heading" className="flex items-center gap-2 text-sm font-semibold">
            <InboxIcon className="size-4 text-primary" />
            Inbox
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Durable proposal and autonomous-work history.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={markAllRead.isPending || (inbox.data?.items.length ?? 0) === 0}
          onClick={() => markAllRead.mutate()}
        >
          Mark visible read
        </Button>
      </div>

      <div className="flex gap-1 overflow-x-auto border-y border-border/50 px-4 py-2 sm:px-5">
        {INBOX_FILTERS.map(({ value, label }) => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? "secondary" : "ghost"}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
            <span className="font-mono text-[10px] text-muted-foreground">
              {inbox.data?.counts[value] ?? 0}
            </span>
          </Button>
        ))}
      </div>

      {inbox.isPending ? (
        <p className="px-4 py-5 text-xs text-muted-foreground sm:px-5">Loading Inbox…</p>
      ) : inbox.error ? (
        <p className="px-4 py-5 text-xs text-destructive sm:px-5">
          {inbox.error instanceof Error ? inbox.error.message : "Inbox could not be loaded."}
        </p>
      ) : inbox.data?.items.length === 0 ? (
        <EmptyState label={`No ${filter} Inbox items.`} />
      ) : (
        <div className="divide-y divide-border/50">
          {inbox.data?.items.map((item) => {
            const unread = isInboxItemUnread(item);
            return (
              <article
                key={item.id}
                className={cn("px-4 py-3 sm:px-5", unread && "bg-primary/[0.035]")}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      unread ? "bg-primary" : "bg-muted-foreground/30",
                    )}
                    aria-label={unread ? "Unread" : "Read"}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="truncate text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void openItem(item)}
                      >
                        {item.title}
                      </button>
                      <StatusPill
                        label={inboxStateLabel(item.state)}
                        tone={inboxStateTone(item.state)}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/70">
                      {item.repository ?? "No repository"} · {formatIsoDate(item.updatedAt)}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant={item.pinned ? "secondary" : "ghost"}
                    aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
                    disabled={pin.isPending}
                    onClick={() => pin.mutate(item)}
                  >
                    <PinIcon className="size-3.5" />
                  </Button>
                </div>
                <details
                  className="ml-4 mt-2"
                  onToggle={(event) => {
                    if (event.currentTarget.open && unread) markRead.mutate(item.id);
                  }}
                >
                  <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                    Timeline · {item.timeline.length}
                  </summary>
                  <ol className="mt-2 border-l border-border pl-3">
                    {orderedInboxTimeline(item).map((event) => (
                      <li key={event.eventKey} className="relative pb-2 text-xs last:pb-0">
                        <span className="absolute -left-[15px] top-1 size-1 rounded-full bg-muted-foreground" />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{inboxStateLabel(event.state)}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {formatIsoDate(event.at)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-muted-foreground">{event.reason}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
