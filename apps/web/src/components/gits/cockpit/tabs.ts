import {
  CircleIcon,
  GaugeIcon,
  GitBranchIcon,
  RadarIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";

export type GitsCockpitTab = "overview" | "motoko" | "autopilot" | "fleet" | "system";

export const GITS_COCKPIT_TABS: ReadonlyArray<{
  id: GitsCockpitTab;
  label: string;
  icon: typeof CircleIcon;
}> = [
  { id: "overview", label: "Command", icon: GaugeIcon },
  { id: "motoko", label: "Motoko", icon: SparklesIcon },
  { id: "autopilot", label: "Autopilot", icon: RadarIcon },
  { id: "fleet", label: "Fleet", icon: GitBranchIcon },
  { id: "system", label: "System", icon: SlidersHorizontalIcon },
];
