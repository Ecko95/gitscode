import { createFileRoute, redirect } from "@tanstack/react-router";

import { GitsNotes } from "../components/gits/GitsNotes";

export const Route = createFileRoute("/notes")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: GitsNotes,
});
