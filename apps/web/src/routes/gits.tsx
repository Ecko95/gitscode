import { createFileRoute, redirect } from "@tanstack/react-router";

import { GitsCockpit } from "../components/gits/GitsCockpit";

export const Route = createFileRoute("/gits")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: GitsCockpit,
});
