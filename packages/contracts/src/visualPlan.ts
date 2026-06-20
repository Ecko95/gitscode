import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Visual plan content model — a GITS-native reimplementation of the
 * builder.io `visual-plan` block registry. The agent authors a `PlanContent`
 * document through the visual-plan MCP tools; the GITS web app renders it as
 * an interactive side panel.
 *
 * v1 renders the document blocks below. `diagram`/`custom-html` are defined
 * here but rendered in Phase 2; `wireframe`/`prototype`/`canvas` arrive in
 * Phase 3 and are intentionally not part of the v1 union yet.
 */

export const PlanBlockId = TrimmedNonEmptyString;
export type PlanBlockId = typeof PlanBlockId.Type;

const blockBase = {
  id: PlanBlockId,
  title: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  editable: Schema.optional(Schema.Boolean),
};

export const PlanRichTextBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("rich-text"),
  data: Schema.Struct({ markdown: Schema.String }),
});

export const PlanCalloutTone = Schema.Literals(["info", "decision", "risk", "warning", "success"]);
export type PlanCalloutTone = typeof PlanCalloutTone.Type;
export const PlanCalloutBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("callout"),
  data: Schema.Struct({
    tone: Schema.optional(PlanCalloutTone),
    body: Schema.String,
  }),
});

export const PlanChecklistItem = Schema.Struct({
  id: PlanBlockId,
  label: Schema.String,
  checked: Schema.optional(Schema.Boolean),
  note: Schema.optional(Schema.String),
});
export const PlanChecklistBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("checklist"),
  data: Schema.Struct({ items: Schema.Array(PlanChecklistItem) }),
});

export const PlanTableDensity = Schema.Literals(["compact", "normal", "relaxed"]);
export const PlanTableBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("table"),
  data: Schema.Struct({
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(Schema.String)),
    density: Schema.optional(PlanTableDensity),
  }),
});

export const PlanCodeBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("code"),
  data: Schema.Struct({
    language: Schema.optional(Schema.String),
    code: Schema.String,
    filename: Schema.optional(Schema.String),
    caption: Schema.optional(Schema.String),
  }),
});

export const PlanCodeAnnotation = Schema.Struct({
  lines: Schema.String,
  label: Schema.optional(Schema.String),
  note: Schema.String,
});
export const PlanAnnotatedCodeBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("annotated-code"),
  data: Schema.Struct({
    filename: Schema.optional(Schema.String),
    language: Schema.optional(Schema.String),
    code: Schema.String,
    annotations: Schema.optional(Schema.Array(PlanCodeAnnotation)),
  }),
});

export const PlanChangeKind = Schema.Literals(["added", "modified", "removed", "renamed"]);
export const PlanFileTreeEntry = Schema.Struct({
  path: Schema.String,
  change: Schema.optional(PlanChangeKind),
  note: Schema.optional(Schema.String),
});
export const PlanFileTreeBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("file-tree"),
  data: Schema.Struct({ entries: Schema.Array(PlanFileTreeEntry) }),
});

export const PlanImplementationMapFile = Schema.Struct({
  path: Schema.String,
  title: Schema.optional(Schema.String),
  note: Schema.String,
  language: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
});
export const PlanImplementationMapBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("implementation-map"),
  data: Schema.Struct({ files: Schema.Array(PlanImplementationMapFile) }),
});

export const PlanApiMethod = Schema.Literals([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export const PlanApiParam = Schema.Struct({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header", "body"]),
  type: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String),
});
export const PlanApiResponse = Schema.Struct({
  status: Schema.String,
  description: Schema.optional(Schema.String),
  example: Schema.optional(Schema.String),
});
export const PlanApiEndpointBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("api-endpoint"),
  data: Schema.Struct({
    method: PlanApiMethod,
    path: Schema.String,
    summary: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    params: Schema.optional(Schema.Array(PlanApiParam)),
    responses: Schema.optional(Schema.Array(PlanApiResponse)),
  }),
});

export const PlanDataModelField = Schema.Struct({
  name: Schema.String,
  type: Schema.optional(Schema.String),
  pk: Schema.optional(Schema.Boolean),
  fk: Schema.optional(Schema.Boolean),
  nullable: Schema.optional(Schema.Boolean),
  note: Schema.optional(Schema.String),
});
export const PlanDataModelEntity = Schema.Struct({
  id: PlanBlockId,
  name: Schema.String,
  note: Schema.optional(Schema.String),
  fields: Schema.Array(PlanDataModelField),
});
export const PlanDataModelRelation = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  kind: Schema.optional(Schema.Literals(["1-1", "1-n", "n-n"])),
  label: Schema.optional(Schema.String),
});
export const PlanDataModelBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("data-model"),
  data: Schema.Struct({
    entities: Schema.Array(PlanDataModelEntity),
    relations: Schema.optional(Schema.Array(PlanDataModelRelation)),
  }),
});

export const PlanQuestionMode = Schema.Literals(["single", "multi", "freeform"]);
export const PlanQuestionOption = Schema.Struct({
  id: PlanBlockId,
  label: Schema.String,
  recommended: Schema.optional(Schema.Boolean),
});
export const PlanQuestion = Schema.Struct({
  id: PlanBlockId,
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  mode: PlanQuestionMode,
  options: Schema.optional(Schema.Array(PlanQuestionOption)),
  allowOther: Schema.optional(Schema.Boolean),
  placeholder: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
export type PlanQuestion = typeof PlanQuestion.Type;
export const PlanQuestionFormBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("question-form"),
  data: Schema.Struct({
    questions: Schema.Array(PlanQuestion),
    submitLabel: Schema.optional(Schema.String),
  }),
});

// Inert scoped HTML/CSS — rendered in Phase 2 (no <script>, sanitized at render).
export const PlanDiagramBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("diagram"),
  data: Schema.Struct({
    html: Schema.optional(Schema.String),
    css: Schema.optional(Schema.String),
    caption: Schema.optional(Schema.String),
  }),
});
export const PlanCustomHtmlBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("custom-html"),
  data: Schema.Struct({
    html: Schema.String,
    css: Schema.optional(Schema.String),
    caption: Schema.optional(Schema.String),
  }),
});

/** Blocks that may appear nested inside `tabs`/`columns` (no further nesting). */
export const PlanLeafBlock = Schema.Union([
  PlanRichTextBlock,
  PlanCalloutBlock,
  PlanChecklistBlock,
  PlanTableBlock,
  PlanCodeBlock,
  PlanAnnotatedCodeBlock,
  PlanFileTreeBlock,
  PlanImplementationMapBlock,
  PlanApiEndpointBlock,
  PlanDataModelBlock,
  PlanQuestionFormBlock,
  PlanDiagramBlock,
  PlanCustomHtmlBlock,
]);
export type PlanLeafBlock = typeof PlanLeafBlock.Type;

export const PlanTabsBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("tabs"),
  data: Schema.Struct({
    orientation: Schema.optional(Schema.Literals(["horizontal", "vertical"])),
    tabs: Schema.Array(
      Schema.Struct({
        id: PlanBlockId,
        label: Schema.String,
        blocks: Schema.Array(PlanLeafBlock),
      }),
    ),
  }),
});
export const PlanColumnsBlock = Schema.Struct({
  ...blockBase,
  type: Schema.Literal("columns"),
  data: Schema.Struct({
    columns: Schema.Array(
      Schema.Struct({
        id: PlanBlockId,
        label: Schema.optional(Schema.String),
        blocks: Schema.Array(PlanLeafBlock),
      }),
    ),
  }),
});

export const PlanBlock = Schema.Union([
  PlanRichTextBlock,
  PlanCalloutBlock,
  PlanChecklistBlock,
  PlanTableBlock,
  PlanCodeBlock,
  PlanAnnotatedCodeBlock,
  PlanFileTreeBlock,
  PlanImplementationMapBlock,
  PlanApiEndpointBlock,
  PlanDataModelBlock,
  PlanQuestionFormBlock,
  PlanDiagramBlock,
  PlanCustomHtmlBlock,
  PlanTabsBlock,
  PlanColumnsBlock,
]);
export type PlanBlock = typeof PlanBlock.Type;

export const PLAN_BLOCK_TYPES = [
  "rich-text",
  "callout",
  "checklist",
  "table",
  "code",
  "annotated-code",
  "file-tree",
  "implementation-map",
  "api-endpoint",
  "data-model",
  "question-form",
  "diagram",
  "custom-html",
  "tabs",
  "columns",
] as const;
export const PlanBlockType = Schema.Literals(PLAN_BLOCK_TYPES);
export type PlanBlockType = typeof PlanBlockType.Type;

export const PlanContent = Schema.Struct({
  version: Schema.Number,
  title: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  blocks: Schema.Array(PlanBlock),
});
export type PlanContent = typeof PlanContent.Type;

/**
 * `update-visual-plan` contract. v1 subset; canvas/prototype/wireframe ops
 * land in Phase 3.
 */
export const PlanContentPatch = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("set-metadata"),
    title: Schema.optional(Schema.String),
    brief: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("replace-block"),
    blockId: PlanBlockId,
    block: PlanBlock,
  }),
  Schema.Struct({
    op: Schema.Literal("update-block"),
    blockId: PlanBlockId,
    patch: Schema.Struct({
      title: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
      editable: Schema.optional(Schema.Boolean),
      data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  }),
  Schema.Struct({
    op: Schema.Literal("replace-blocks"),
    blocks: Schema.Array(PlanBlock),
  }),
  Schema.Struct({
    op: Schema.Literal("update-rich-text"),
    blockId: PlanBlockId,
    title: Schema.optional(Schema.String),
    markdown: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    op: Schema.Literal("append-block"),
    block: PlanBlock,
    afterBlockId: Schema.optional(PlanBlockId),
  }),
  Schema.Struct({
    op: Schema.Literal("remove-block"),
    blockId: PlanBlockId,
  }),
]);
export type PlanContentPatch = typeof PlanContentPatch.Type;

export const PlanCommentResolutionTarget = Schema.Literals(["agent", "human"]);
export type PlanCommentResolutionTarget = typeof PlanCommentResolutionTarget.Type;

export const PlanCommentAuthor = Schema.Literals(["human", "agent"]);

/**
 * One flat anchor covering every comment surface (text-quote, block/section,
 * DOM node, canvas coordinate). Mirrors builder.io's `PlanCommentAnchor`.
 */
export const PlanCommentAnchor = Schema.Struct({
  sectionId: Schema.optional(Schema.String),
  blockId: Schema.optional(PlanBlockId),
  blockType: Schema.optional(Schema.String),
  anchorKind: Schema.optional(Schema.Literals(["text", "block", "visual", "point"])),
  targetKind: Schema.optional(Schema.String),
  textQuote: Schema.optional(Schema.String),
  contextBefore: Schema.optional(Schema.String),
  contextAfter: Schema.optional(Schema.String),
  // canvas / node anchoring (Phase 3) — defined now so the model is stable.
  targetNodeId: Schema.optional(Schema.String),
  targetSelector: Schema.optional(Schema.String),
  canvasX: Schema.optional(Schema.Number),
  canvasY: Schema.optional(Schema.Number),
  canvasWidth: Schema.optional(Schema.Number),
  canvasHeight: Schema.optional(Schema.Number),
});
export type PlanCommentAnchor = typeof PlanCommentAnchor.Type;

export const PlanComment = Schema.Struct({
  id: PlanBlockId,
  parentCommentId: Schema.optional(Schema.NullOr(PlanBlockId)),
  anchor: PlanCommentAnchor,
  message: Schema.String,
  createdBy: PlanCommentAuthor.pipe(Schema.withDecodingDefault(Effect.succeed("human" as const))),
  resolutionTarget: Schema.optional(PlanCommentResolutionTarget),
  resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  consumedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PlanComment = typeof PlanComment.Type;
