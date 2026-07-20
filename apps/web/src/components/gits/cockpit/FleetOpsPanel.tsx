import type { ComponentProps } from "react";

import { SectionHeader } from "./primitives";
import { PeerFleetPanel } from "./FleetPanel";
import { DevCommandPanel } from "./DevPanel";

/**
 * Fleet composite: Delamain peers + dev terminals in one scroll. Each section
 * forwards straight through to its existing panel, unchanged — the integrator
 * wires `peerFleet`/`devCommands` the same way GitsCockpit.tsx already wires
 * `PeerFleetPanel`/`DevCommandPanel` today.
 */
export interface FleetOpsPanelProps {
  readonly peerFleet: ComponentProps<typeof PeerFleetPanel>;
  readonly devCommands: ComponentProps<typeof DevCommandPanel>;
}

export function FleetOpsPanel({ peerFleet, devCommands }: FleetOpsPanelProps) {
  return (
    <>
      <SectionHeader title="Delamain peers" count={peerFleet.list?.peers.length ?? 0} />
      <PeerFleetPanel {...peerFleet} />
      <SectionHeader title="Dev terminals" count={devCommands.list?.commands.length ?? 0} />
      <DevCommandPanel {...devCommands} />
    </>
  );
}
