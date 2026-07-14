import type {
  GitsNote,
  GitsNoteIdInput,
  GitsNoteSummary,
  GitsNoteWriteInput,
  GitsNotesSyncResult,
} from "@t3tools/contracts";
import { GitsNotesError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface GitsNotesShape {
  readonly list: () => Effect.Effect<ReadonlyArray<GitsNoteSummary>, GitsNotesError>;
  readonly read: (input: GitsNoteIdInput) => Effect.Effect<GitsNote, GitsNotesError>;
  readonly create: (input: GitsNoteWriteInput) => Effect.Effect<GitsNote, GitsNotesError>;
  readonly update: (input: GitsNoteWriteInput) => Effect.Effect<GitsNote, GitsNotesError>;
  readonly remove: (input: GitsNoteIdInput) => Effect.Effect<void, GitsNotesError>;
  readonly sync: () => Effect.Effect<GitsNotesSyncResult, GitsNotesError>;
}

export class GitsNotes extends Context.Service<GitsNotes, GitsNotesShape>()(
  "t3/gits/Services/GitsNotes",
) {}
