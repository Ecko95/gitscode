import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import { formatShortcutLabel } from "../../keybindings";
import { commandLabel } from "../settings/KeybindingsSettings.logic";

function shortcutDisplayLabel(key: string, platform: string): string {
  const shortcut = parseKeybindingShortcut(key);
  // ponytail: keep future unknown default syntax visible instead of adding docs-only parsing.
  return shortcut ? formatShortcutLabel(shortcut, platform) : key;
}

export function KeyboardShortcutsDoc() {
  const platform = navigator.platform;
  const rows = DEFAULT_KEYBINDINGS.map((rule) => ({
    action: commandLabel(rule.command),
    shortcut: shortcutDisplayLabel(rule.key, platform),
    context: rule.when ?? "Global",
  })).toSorted((left, right) => left.action.localeCompare(right.action));

  if (import.meta.env.DEV) {
    // ponytail: this runtime assertion is the manifest smoke check instead of a dedicated test.
    console.assert(
      rows.every((row) => row.shortcut.length > 0),
      "empty shortcut docs label",
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 overflow-y-auto px-5 py-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-normal text-foreground">
          Keyboard Shortcuts
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          These are the default shortcuts. You can rebind them under Settings, Keybindings.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-normal text-muted-foreground">
              <tr>
                <th className="border-b border-border px-4 py-2 font-medium">Action</th>
                <th className="border-b border-border px-4 py-2 font-medium">Shortcut</th>
                <th className="border-b border-border px-4 py-2 font-medium">Context</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.action}:${row.shortcut}:${row.context}`}
                  className="border-b border-border/60 last:border-b-0"
                >
                  <td className="px-4 py-2.5 text-foreground">{row.action}</td>
                  <td className="px-4 py-2.5">
                    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {row.shortcut}
                    </kbd>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {row.context}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
