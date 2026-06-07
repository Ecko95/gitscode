import * as Schema from "effect/Schema";
import { useLocalStorage } from "./hooks/useLocalStorage";

const SIDEBAR_OPEN_KEY = "t3code:sidebar-open";

export function useSidebarOpenState() {
  return useLocalStorage(SIDEBAR_OPEN_KEY, true, Schema.Boolean);
}
