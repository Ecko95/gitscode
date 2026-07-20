import type { ComponentProps } from "react";
import { useState } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

import { OpenGsdPanel } from "./GsdPanel";
import { McpServersPanel } from "./McpPanel";
import { CockpitContent } from "./ProjectsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { UsagePanel } from "./UsagePanel";

const SYSTEM_SECTIONS = [
  { id: "usage", label: "Usage" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "gsd", label: "Open GSD" },
  { id: "projects", label: "Projects" },
] as const;

export type SystemPanelSection = (typeof SYSTEM_SECTIONS)[number]["id"];

/**
 * System composite: Usage / Skills / MCP / Open GSD / Projects behind one
 * secondary nav. Each section forwards straight through to its existing
 * panel, unchanged — the integrator wires each prop bag the same way
 * GitsCockpit.tsx already wires the standalone panels today.
 */
export interface SystemPanelProps {
  readonly usage: ComponentProps<typeof UsagePanel>;
  readonly skills: ComponentProps<typeof SkillsPanel>;
  readonly mcp: ComponentProps<typeof McpServersPanel>;
  readonly gsd: ComponentProps<typeof OpenGsdPanel>;
  readonly projects: ComponentProps<typeof CockpitContent>;
}

export function SystemPanel({ usage, skills, mcp, gsd, projects }: SystemPanelProps) {
  const [section, setSection] = useState<SystemPanelSection>("usage");

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-4 py-2.5 backdrop-blur sm:px-5">
        <ToggleGroup
          aria-label="System section"
          variant="outline"
          size="sm"
          value={[section]}
          onValueChange={(value) => {
            const next = SYSTEM_SECTIONS.find((item) => item.id === value[0]);
            if (next) {
              setSection(next.id);
            }
          }}
        >
          {SYSTEM_SECTIONS.map((item) => (
            <Toggle key={item.id} value={item.id} aria-label={item.label}>
              {item.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {section === "usage" ? <UsagePanel {...usage} /> : null}
      {section === "skills" ? <SkillsPanel {...skills} /> : null}
      {section === "mcp" ? <McpServersPanel {...mcp} /> : null}
      {section === "gsd" ? <OpenGsdPanel {...gsd} /> : null}
      {section === "projects" ? <CockpitContent {...projects} /> : null}
    </div>
  );
}
