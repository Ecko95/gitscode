import type { EnvironmentId, GitsDevCommand, TerminalAttachStreamEvent } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";

export type DevCommandSessionState = {
  readonly threadId: string;
  readonly terminalId: string;
  readonly status: "idle" | "starting" | "running" | "exited" | "error" | "closed";
  readonly log: string;
  readonly exitCode: number | null;
  readonly label: string | null;
  readonly updatedAt: string | null;
  readonly pid: number | null;
};

function makeDevTerminalId(commandId: string): string {
  return `gits-dev-${commandId}`;
}

function makeDevThreadId(projectDir: string): string {
  return `gits-dev:${projectDir}`;
}

function trimTerminalLog(log: string): string {
  const maxLength = 24_000;
  return log.length <= maxLength ? log : log.slice(log.length - maxLength);
}

function reduceDevCommandEvent(
  current: DevCommandSessionState,
  event: TerminalAttachStreamEvent,
): DevCommandSessionState {
  if (event.type === "snapshot") {
    return {
      threadId: current.threadId,
      terminalId: event.snapshot.terminalId,
      status: event.snapshot.status,
      log: trimTerminalLog(event.snapshot.history),
      exitCode: event.snapshot.exitCode,
      label: event.snapshot.label,
      updatedAt: event.snapshot.updatedAt,
      pid: event.snapshot.pid,
    };
  }
  if (event.type === "output") {
    return {
      ...current,
      status: current.status === "idle" ? "running" : current.status,
      log: trimTerminalLog(current.log + event.data),
    };
  }
  if (event.type === "activity") {
    return {
      ...current,
      status: event.hasRunningSubprocess ? "running" : current.status,
      label: event.label,
    };
  }
  if (event.type === "restarted") {
    return {
      threadId: current.threadId,
      terminalId: event.snapshot.terminalId,
      status: event.snapshot.status,
      log: trimTerminalLog(event.snapshot.history),
      exitCode: event.snapshot.exitCode,
      label: event.snapshot.label,
      updatedAt: event.snapshot.updatedAt,
      pid: event.snapshot.pid,
    };
  }
  if (event.type === "exited") {
    return {
      ...current,
      status: "exited",
      exitCode: event.exitCode,
      pid: null,
    };
  }
  if (event.type === "error") {
    return {
      ...current,
      status: "error",
      log: trimTerminalLog(
        `${current.log}${current.log.endsWith("\n") || current.log.length === 0 ? "" : "\n"}[error] ${event.message}\n`,
      ),
    };
  }
  if (event.type === "cleared") {
    return {
      ...current,
      log: "",
    };
  }
  return {
    ...current,
    status: "closed",
    pid: null,
  };
}

export function useDevCommandSessions({
  targetEnvironmentId,
  selectedProjectRoot,
}: {
  targetEnvironmentId: EnvironmentId | null;
  selectedProjectRoot: string;
}) {
  const [devSessionStateByCommandId, setDevSessionStateByCommandId] = useState<
    Record<string, DevCommandSessionState | undefined>
  >({});
  const [devActionError, setDevActionError] = useState<string | null>(null);
  const [devActiveCommandId, setDevActiveCommandId] = useState<string | null>(null);
  const [devActionPending, setDevActionPending] = useState(false);
  const devTerminalDetachByCommandIdRef = useRef(new Map<string, () => void>());

  const handleDevStart = async (command: GitsDevCommand) => {
    if (!targetEnvironmentId) {
      setDevActionError("No target environment is available.");
      return;
    }
    const api = readEnvironmentApi(targetEnvironmentId);
    if (!api) {
      setDevActionError("Environment API is not available.");
      return;
    }
    const threadId = makeDevThreadId(selectedProjectRoot);
    const terminalId = makeDevTerminalId(command.id);
    setDevActionPending(true);
    setDevActiveCommandId(command.id);
    setDevActionError(null);
    devTerminalDetachByCommandIdRef.current.get(command.id)?.();
    devTerminalDetachByCommandIdRef.current.delete(command.id);
    setDevSessionStateByCommandId((current) => ({
      ...current,
      [command.id]: {
        threadId,
        terminalId,
        status: "starting",
        log: "",
        exitCode: null,
        label: null,
        updatedAt: new Date().toISOString(),
        pid: null,
      },
    }));
    try {
      await api.terminal
        .close({ threadId, terminalId, deleteHistory: true })
        .catch(() => undefined);
      await api.terminal.open({ threadId, terminalId, cwd: command.cwd });
      const detach = api.terminal.attach(
        { threadId, terminalId, cwd: command.cwd, restartIfNotRunning: false },
        (event) => {
          setDevSessionStateByCommandId((current) => {
            const previous =
              current[command.id] ??
              ({
                threadId,
                terminalId,
                status: "idle",
                log: "",
                exitCode: null,
                label: null,
                updatedAt: null,
                pid: null,
              } satisfies DevCommandSessionState);
            return {
              ...current,
              [command.id]: reduceDevCommandEvent(previous, event),
            };
          });
        },
      );
      devTerminalDetachByCommandIdRef.current.set(command.id, detach);
      await api.terminal.write({ threadId, terminalId, data: `${command.launchCommand}\n` });
    } catch (error) {
      setDevActionError(error instanceof Error ? error.message : "Failed to start dev command.");
      setDevSessionStateByCommandId((current) => ({
        ...current,
        [command.id]: {
          threadId,
          terminalId,
          status: "error",
          log:
            error instanceof Error
              ? `[error] ${error.message}\n`
              : "[error] Failed to start dev command.\n",
          exitCode: null,
          label: null,
          updatedAt: new Date().toISOString(),
          pid: null,
        },
      }));
    } finally {
      setDevActionPending(false);
      setDevActiveCommandId(null);
    }
  };
  const handleDevStop = async (command: GitsDevCommand) => {
    if (!targetEnvironmentId) {
      setDevActionError("No target environment is available.");
      return;
    }
    const api = readEnvironmentApi(targetEnvironmentId);
    if (!api) {
      setDevActionError("Environment API is not available.");
      return;
    }
    const threadId =
      devSessionStateByCommandId[command.id]?.threadId ?? makeDevThreadId(selectedProjectRoot);
    const terminalId = makeDevTerminalId(command.id);
    setDevActionPending(true);
    setDevActiveCommandId(command.id);
    setDevActionError(null);
    try {
      await api.terminal
        .write({ threadId, terminalId, data: "\u0003exit\n" })
        .catch(() => undefined);
      await api.terminal
        .close({ threadId, terminalId, deleteHistory: false })
        .catch(() => undefined);
      devTerminalDetachByCommandIdRef.current.get(command.id)?.();
      devTerminalDetachByCommandIdRef.current.delete(command.id);
      setDevSessionStateByCommandId((current) => ({
        ...current,
        [command.id]: {
          ...(current[command.id] ?? {
            threadId,
            terminalId,
            log: "",
            exitCode: null,
            label: null,
            updatedAt: null,
            pid: null,
          }),
          status: "closed",
          updatedAt: new Date().toISOString(),
          pid: null,
        },
      }));
    } catch (error) {
      setDevActionError(error instanceof Error ? error.message : "Failed to stop dev command.");
    } finally {
      setDevActionPending(false);
      setDevActiveCommandId(null);
    }
  };
  const handleDevCopyLaunchCommand = async (command: GitsDevCommand) => {
    try {
      await navigator.clipboard.writeText(command.launchCommand);
      setDevActionError(null);
    } catch (error) {
      setDevActionError(error instanceof Error ? error.message : "Failed to copy launch command.");
    }
  };

  useEffect(() => {
    const detachByCommandId = devTerminalDetachByCommandIdRef.current;
    return () => {
      for (const detach of detachByCommandId.values()) {
        detach();
      }
      detachByCommandId.clear();
      setDevSessionStateByCommandId({});
    };
  }, [selectedProjectRoot]);

  return {
    devSessionStateByCommandId,
    devActionError,
    devActiveCommandId,
    devActionPending,
    handleDevStart,
    handleDevStop,
    handleDevCopyLaunchCommand,
  };
}
