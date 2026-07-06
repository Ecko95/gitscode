import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  DOCS_NAV_ITEMS,
  isDocsSectionSlug,
  type DocsSectionSlug,
} from "../components/docs/DocsSidebarNav";
import { KeyboardShortcutsDoc } from "../components/docs/KeyboardShortcutsDoc";
import ChatMarkdown from "../components/ChatMarkdown";
import orchestration from "../docs/orchestration.md?raw";
import overview from "../docs/overview.md?raw";
import platforms from "../docs/platforms.md?raw";
import sandboxing from "../docs/sandboxing.md?raw";
import security from "../docs/security.md?raw";
import selfHosting from "../docs/self-hosting.md?raw";

type DocsContent = { kind: "markdown"; text: string } | { kind: "shortcuts" };

const DOCS_CONTENT = {
  overview: { kind: "markdown", text: overview },
  security: { kind: "markdown", text: security },
  orchestration: { kind: "markdown", text: orchestration },
  sandboxing: { kind: "markdown", text: sandboxing },
  "self-hosting": { kind: "markdown", text: selfHosting },
  platforms: { kind: "markdown", text: platforms },
  shortcuts: { kind: "shortcuts" },
} satisfies Record<DocsSectionSlug, DocsContent>;

if (import.meta.env.DEV) {
  // ponytail: one cheap manifest check covers the static TOC/content contract.
  for (const item of DOCS_NAV_ITEMS) {
    console.assert(item.slug in DOCS_CONTENT, `no docs content for ${item.slug}`);
  }
}

function DocsSectionRoute() {
  const { section } = Route.useParams();
  if (!isDocsSectionSlug(section)) {
    throw redirect({ to: "/docs/$section", params: { section: "overview" }, replace: true });
  }

  const entry = DOCS_CONTENT[section];
  if (entry.kind === "shortcuts") {
    return <KeyboardShortcutsDoc />;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-y-auto px-5 py-6">
      <ChatMarkdown text={entry.text} cwd={undefined} />
    </div>
  );
}

export const Route = createFileRoute("/docs/$section")({
  beforeLoad: ({ params }) => {
    if (!isDocsSectionSlug(params.section)) {
      throw redirect({ to: "/docs/$section", params: { section: "overview" }, replace: true });
    }
  },
  component: DocsSectionRoute,
});
