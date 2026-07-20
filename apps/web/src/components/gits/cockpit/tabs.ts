import {
  BookOpenCheckIcon,
  CircleIcon,
  CircleDollarSignIcon,
  GaugeIcon,
  GitBranchIcon,
  ListChecksIcon,
  PlugIcon,
  PowerIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from "lucide-react";

export type GitsCockpitTab =
  | "overview"
  | "motoko"
  | "dev"
  | "fleet"
  | "automode"
  | "usage"
  | "gsd"
  | "skills"
  | "mcp"
  | "projects";

export const GITS_COCKPIT_TABS: ReadonlyArray<{
  id: GitsCockpitTab;
  label: string;
  icon: typeof CircleIcon;
}> = [
  { id: "overview", label: "Overview", icon: GaugeIcon },
  { id: "motoko", label: "Motoko", icon: SparklesIcon },
  { id: "dev", label: "Dev", icon: SquareTerminalIcon },
  { id: "fleet", label: "Fleet", icon: GitBranchIcon },
  { id: "automode", label: "Automode", icon: PowerIcon },
  { id: "usage", label: "Usage", icon: CircleDollarSignIcon },
  { id: "gsd", label: "Open GSD", icon: ListChecksIcon },
  { id: "skills", label: "Skills", icon: BookOpenCheckIcon },
  { id: "mcp", label: "MCP", icon: PlugIcon },
  { id: "projects", label: "Projects", icon: CircleIcon },
];
