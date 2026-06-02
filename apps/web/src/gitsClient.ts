import type { WsRpcClient } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { getPrimaryKnownEnvironment } from "./environments/primary";
import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
} from "./environments/runtime";

export type GitsEnvironmentClient = WsRpcClient["gits"];

export function readGitsEnvironmentClient(
  environmentId: EnvironmentId,
): GitsEnvironmentClient | null {
  const connection = readEnvironmentConnection(environmentId);
  if (connection) {
    return connection.client.gits;
  }

  if (getPrimaryKnownEnvironment()?.environmentId === environmentId) {
    return getPrimaryEnvironmentConnection().client.gits;
  }

  return null;
}
