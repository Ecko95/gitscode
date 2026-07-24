import { ProviderInstanceId, type DelamainPeerListResult } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PeerFleetPanel } from "./FleetPanel";

const list: DelamainPeerListResult = {
  capabilities: {
    available: true,
    binaryPath: "delamain",
    supported: ["list", "spawn"],
    unsupported: ["status", "log", "kill", "reply", "wait", "integrate"],
    checkedAt: "2026-07-24T00:00:00.000Z",
  },
  peers: [],
};

function renderPanel(spawnProviderInstanceId: ReturnType<typeof ProviderInstanceId.make> | null) {
  return renderToStaticMarkup(
    <PeerFleetPanel
      list={list}
      loading={false}
      error={null}
      selectedPeerId={null}
      logText={undefined}
      logLoading={false}
      inbox={undefined}
      actionError={null}
      spawnRepo="/srv/repo"
      spawnName=""
      spawnPrompt="Do the work"
      spawnProviderInstanceId={spawnProviderInstanceId}
      spawnProviderOptions={[]}
      replyText=""
      actionPending={false}
      onRefresh={vi.fn()}
      onSelectPeer={vi.fn()}
      onSpawnRepoChange={vi.fn()}
      onSpawnNameChange={vi.fn()}
      onSpawnPromptChange={vi.fn()}
      onSpawnProviderInstanceChange={vi.fn()}
      onReplyTextChange={vi.fn()}
      onSpawn={vi.fn()}
      onReply={vi.fn()}
      onWait={vi.fn()}
      onKill={vi.fn()}
      onIntegrate={vi.fn()}
      killSwitchEnabled={false}
    />,
  );
}

describe("PeerFleetPanel", () => {
  it("disables Spawn until a routed provider account is selected", () => {
    expect(renderPanel(null)).toMatch(/<button[^>]* disabled=""[^>]*>.*Spawn Peer<\/button>/s);
  });

  it("enables Spawn when repository, prompt, and provider account are routed", () => {
    expect(renderPanel(ProviderInstanceId.make("codex-work"))).not.toMatch(
      /<button[^>]* disabled=""[^>]*>.*Spawn Peer<\/button>/s,
    );
  });
});
