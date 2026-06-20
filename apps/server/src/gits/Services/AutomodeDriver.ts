import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeDriverShape {
	/**
	 * Run exactly one driver step: reconcile the in-flight goal against its peer,
	 * and if idle (and autonomous, not killed, not halted) dispatch the next queued
	 * goal. Exposed so tests can step the loop deterministically.
	 */
	readonly tickOnce: () => Effect.Effect<void, AutomodeSupervisorError>;
}

export class AutomodeDriver extends Context.Service<AutomodeDriver, AutomodeDriverShape>()(
	"t3/gits/Services/AutomodeDriver",
) {}
