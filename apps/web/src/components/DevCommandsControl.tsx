import type { EnvironmentId, GitsDevCommand, GitsDevCommandListResult } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  PlayIcon,
  SquareTerminalIcon,
  StopCircleIcon,
} from "lucide-react";
import { useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { readGitsEnvironmentClient } from "../gitsClient";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";

interface DevCommandsControlProps {
  environmentId: EnvironmentId;
  projectDir: string | null;
}

function makeDevTerminalId(commandId: string): string {
  return `gits-dev-${commandId}`;
}

function makeDevThreadId(projectDir: string): string {
  return `gits-dev:${projectDir}`;
}

async function startDevCommand(input: {
  environmentId: EnvironmentId;
  projectDir: string;
  command: GitsDevCommand;
}): Promise<void> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    throw new Error("Environment API is not available.");
  }
  const threadId = makeDevThreadId(input.projectDir);
  const terminalId = makeDevTerminalId(input.command.id);
  await api.terminal.close({ threadId, terminalId, deleteHistory: true }).catch(() => undefined);
  await api.terminal.open({ threadId, terminalId, cwd: input.command.cwd });
  await api.terminal.write({ threadId, terminalId, data: `${input.command.launchCommand}\n` });
}

async function stopDevCommand(input: {
  environmentId: EnvironmentId;
  projectDir: string;
  command: GitsDevCommand;
}): Promise<void> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) {
    throw new Error("Environment API is not available.");
  }
  const threadId = makeDevThreadId(input.projectDir);
  const terminalId = makeDevTerminalId(input.command.id);
  await api.terminal.write({ threadId, terminalId, data: "\u0003exit\n" }).catch(() => undefined);
  await api.terminal.close({ threadId, terminalId, deleteHistory: false }).catch(() => undefined);
}

export default function DevCommandsControl({ environmentId, projectDir }: DevCommandsControlProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLabel, setActionLabel] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const gitsClient = readGitsEnvironmentClient(environmentId);
  const commandsQuery = useQuery({
    queryKey: ["gits", "header-dev-commands", environmentId, projectDir],
    enabled: Boolean(projectDir && gitsClient),
    queryFn: async (): Promise<GitsDevCommandListResult> => {
      if (!projectDir || !gitsClient) {
        throw new Error("Dev commands are unavailable.");
      }
      return gitsClient.devCommands.list({ projectDir });
    },
    refetchInterval: 30_000,
  });

  const commands = commandsQuery.data?.commands ?? [];
  const shouldRender = Boolean(projectDir) && (commandsQuery.isPending || commands.length > 0);

  if (!shouldRender) {
    return null;
  }

  const runAction = async (label: string, action: () => Promise<void>) => {
    setActionPending(true);
    setActionLabel(label);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setActionPending(false);
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label="Dev commands"
            disabled={commandsQuery.isPending || commands.length === 0}
            title={actionError ?? (actionLabel ? `${actionLabel}${actionPending ? "..." : ""}` : "Dev commands")}
          />
        }
      >
        <SquareTerminalIcon className="size-3.5" />
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Dev
        </span>
        <ChevronDownIcon className="size-3.5 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuGroupLabel>Dev commands</MenuGroupLabel>
        {commandsQuery.isPending ? (
          <MenuItem disabled>
            <SquareTerminalIcon className="size-4" />
            Loading dev commands
          </MenuItem>
        ) : null}
        {commandsQuery.error ? (
          <>
            <MenuSeparator />
            <MenuItem disabled>
              <SquareTerminalIcon className="size-4" />
              {commandsQuery.error instanceof Error
                ? commandsQuery.error.message
                : "Failed to load dev commands."}
            </MenuItem>
          </>
        ) : null}
        {actionError ? (
          <>
            <MenuSeparator />
            <MenuItem disabled>
              <SquareTerminalIcon className="size-4" />
              {actionError}
            </MenuItem>
          </>
        ) : null}
        {commands.map((command) => (
          <MenuSub key={command.id}>
            <MenuSubTrigger>
              <SquareTerminalIcon className="size-4" />
              <span className="truncate">{command.name}</span>
            </MenuSubTrigger>
            <MenuSubPopup align="end" className="min-w-52">
              <MenuItem
                onClick={() =>
                  void runAction(`Start ${command.name}`, () =>
                    startDevCommand({
                      environmentId,
                      projectDir: projectDir!,
                      command,
                    }),
                  )
                }
              >
                <PlayIcon className="size-4" />
                Start
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void runAction(`Stop ${command.name}`, () =>
                    stopDevCommand({
                      environmentId,
                      projectDir: projectDir!,
                      command,
                    }),
                  )
                }
              >
                <StopCircleIcon className="size-4" />
                Stop
              </MenuItem>
              {command.previewUrl ? (
                <MenuItem
                  onClick={() => {
                    window.open(command.previewUrl!, "_blank", "noopener,noreferrer");
                  }}
                >
                  <ExternalLinkIcon className="size-4" />
                  Open preview
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() =>
                  void runAction(`Copy ${command.name} launch command`, async () => {
                    await navigator.clipboard.writeText(command.launchCommand);
                  })
                }
              >
                <CopyIcon className="size-4" />
                Copy launch command
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
        ))}
      </MenuPopup>
    </Menu>
  );
}
