import { useEffect, useMemo, useRef } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { APP_DISPLAY_NAME } from "../branding";
import { selectSidebarThreadsAcrossEnvironments, useStore, type AppState } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { registerWebPushSubscription, unregisterWebPushSubscription } from "../lib/webPush";
import { useSettings } from "./useSettings";

interface NotificationThreadState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly latestTurnCompletedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

type BadgeNavigator = Navigator & {
  readonly setAppBadge?: (contents?: number) => Promise<void>;
  readonly clearAppBadge?: () => Promise<void>;
};

const NOTIFICATION_SCOPE = "[NOTIFICATIONS]";
const DEFAULT_FAVICON_SELECTOR = "link[rel~='icon']";
let originalFaviconHref: string | null = null;
let faviconRenderRequestId = 0;

function threadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

function parseFocusedThreadKey(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [environmentId, threadId] = segments;
  if (!environmentId || !threadId) return null;

  try {
    return threadKey(
      decodeURIComponent(environmentId) as EnvironmentId,
      decodeURIComponent(threadId) as ThreadId,
    );
  } catch {
    return null;
  }
}

function collectThreadStates(state: AppState): Map<string, NotificationThreadState> {
  return new Map(
    selectSidebarThreadsAcrossEnvironments(state)
      .filter((thread) => thread.archivedAt === null)
      .map((thread) => [
        threadKey(thread.environmentId, thread.id),
        {
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title || "Untitled thread",
          latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
        },
      ]),
  );
}

function countAttentionThreads(threads: Map<string, NotificationThreadState>): number {
  let count = 0;
  for (const thread of threads.values()) {
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
      count += 1;
    }
  }
  return count;
}

function applyDocumentTitle(attentionCount: number): void {
  document.title =
    attentionCount > 0 ? `(${attentionCount}) ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME;
}

function findFaviconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>(DEFAULT_FAVICON_SELECTOR);
}

function setFaviconHref(href: string): void {
  let link = findFaviconLink();
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}

function ensureOriginalFaviconHref(): string | null {
  if (originalFaviconHref !== null) {
    return originalFaviconHref;
  }

  const link = findFaviconLink();
  originalFaviconHref = link?.href ?? "/favicon.ico";
  return originalFaviconHref;
}

function applyFaviconBadge(attentionCount: number): void {
  const originalHref = ensureOriginalFaviconHref();
  if (!originalHref) return;

  const requestId = ++faviconRenderRequestId;
  if (attentionCount <= 0) {
    setFaviconHref(originalHref);
    return;
  }

  const image = new Image();
  image.addEventListener("load", () => {
    if (requestId !== faviconRenderRequestId) return;

    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.drawImage(image, 0, 0, 32, 32);
    context.fillStyle = "#ef4444";
    context.beginPath();
    context.arc(24, 8, 7, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = "#ffffff";
    context.stroke();
    setFaviconHref(canvas.toDataURL("image/png"));
  });
  image.addEventListener("error", () => {
    // ponytail: if favicon canvas rendering fails, the title badge still carries the count.
  });
  image.src = originalHref;
}

function applyAppBadge(attentionCount: number): void {
  const badgeNavigator = navigator as BadgeNavigator;
  if (attentionCount > 0) {
    void badgeNavigator.setAppBadge?.(attentionCount).catch(() => undefined);
    return;
  }
  void badgeNavigator.clearAppBadge?.().catch(() => undefined);
}

function applyChromeAttentionState(threads: Map<string, NotificationThreadState>): void {
  const attentionCount = countAttentionThreads(threads);
  applyDocumentTitle(attentionCount);
  applyFaviconBadge(attentionCount);
  applyAppBadge(attentionCount);
}

function canSendBrowserNotification(): boolean {
  return "Notification" in window && Notification.permission === "granted";
}

function summarizeNotification(
  thread: NotificationThreadState,
  event: "approval" | "input" | "turn",
) {
  switch (event) {
    case "approval":
      return {
        title: "Approval needed",
        body: thread.title,
      };
    case "input":
      return {
        title: "Input needed",
        body: thread.title,
      };
    case "turn":
      return {
        title: "Turn completed",
        body: thread.title,
      };
  }
}

export function useNotifications(): void {
  const desktopNotificationsEnabled = useSettings(
    (settings) => settings.desktopNotificationsEnabled === true,
  );
  const pushNotificationsEnabled = useSettings(
    (settings) =>
      settings.desktopNotificationsEnabled === true && settings.pushNotificationsEnabled === true,
  );
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const desktopNotificationsEnabledRef = useRef(desktopNotificationsEnabled);
  const focusedThreadKeyRef = useRef(parseFocusedThreadKey(pathname));

  useEffect(() => {
    desktopNotificationsEnabledRef.current = desktopNotificationsEnabled;
  }, [desktopNotificationsEnabled]);

  useEffect(() => {
    focusedThreadKeyRef.current = parseFocusedThreadKey(pathname);
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    const syncPushSubscription = async () => {
      try {
        if (pushNotificationsEnabled) {
          await registerWebPushSubscription();
          return;
        }
        await unregisterWebPushSubscription();
      } catch (error) {
        if (!cancelled) {
          console.warn(`${NOTIFICATION_SCOPE} unable to sync web push subscription`, error);
        }
      }
    };

    void syncPushSubscription();
    return () => {
      cancelled = true;
    };
  }, [pushNotificationsEnabled]);

  const notifyThread = useMemo(
    () => (thread: NotificationThreadState, event: "approval" | "input" | "turn") => {
      if (!desktopNotificationsEnabledRef.current || !canSendBrowserNotification()) {
        return;
      }

      const key = threadKey(thread.environmentId, thread.threadId);
      if (focusedThreadKeyRef.current === key) {
        return;
      }

      const summary = summarizeNotification(thread, event);
      try {
        const notification = new Notification(summary.title, {
          body: summary.body,
          tag: `gits:${event}:${key}:${thread.latestTurnCompletedAt ?? ""}`,
        });
        notification.addEventListener("click", () => {
          window.focus();
          const threadRef = scopeThreadRef(thread.environmentId, thread.threadId);
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          });
          notification.close();
        });
      } catch (error) {
        console.warn(`${NOTIFICATION_SCOPE} unable to show browser notification`, error);
      }
    },
    [navigate],
  );

  useEffect(() => {
    let previousThreads = collectThreadStates(useStore.getState());
    applyChromeAttentionState(previousThreads);

    return useStore.subscribe((state) => {
      const nextThreads = collectThreadStates(state);
      applyChromeAttentionState(nextThreads);

      for (const [key, nextThread] of nextThreads) {
        const previousThread = previousThreads.get(key);
        if (!previousThread) continue;

        if (!previousThread.hasPendingApprovals && nextThread.hasPendingApprovals) {
          notifyThread(nextThread, "approval");
        }
        if (!previousThread.hasPendingUserInput && nextThread.hasPendingUserInput) {
          notifyThread(nextThread, "input");
        }
        if (
          nextThread.latestTurnCompletedAt !== null &&
          previousThread.latestTurnCompletedAt !== nextThread.latestTurnCompletedAt
        ) {
          notifyThread(nextThread, "turn");
        }
      }

      previousThreads = nextThreads;
    });
  }, [notifyThread]);
}
