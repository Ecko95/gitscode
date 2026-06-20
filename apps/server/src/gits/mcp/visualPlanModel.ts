/**
 * Server-side surface for the native visual-plan MCP server: the block-registry
 * catalog and the MCP tool definitions.
 *
 * The pure content helpers (`applyPlanPatches`, `exportPlanToMarkdown`, comment
 * merge/resolve) live in `@t3tools/contracts` so the web panel's optimistic
 * updates and markdown export share one implementation. They are re-exported
 * here so existing server imports keep their stable `./visualPlanModel.ts` path.
 */
import { PLAN_BLOCK_TYPES } from "@t3tools/contracts";

export {
  applyPlanPatches,
  exportPlanToMarkdown,
  resolvePlanComment,
  upsertPlanComment,
} from "@t3tools/contracts";

/** The `get-plan-blocks` payload — the authoritative block catalog. */
export function buildBlockCatalog(): { blockTypes: ReadonlyArray<string>; notes: string } {
  return {
    blockTypes: PLAN_BLOCK_TYPES,
    notes:
      "Each block is { id, type, title?, summary?, editable?, data }. `tabs`/`columns` nest leaf blocks (no further nesting). `rich-text`.data.markdown holds GFM prose; `callout`.data.tone is info|decision|risk|warning|success; `checklist`.data.items[{id,label,checked?,note?}]; `table`.data{columns,rows}; `annotated-code`.data{filename?,language?,code,annotations?[{lines,label?,note}]}; `api-endpoint`.data{method,path,params?,responses?}; `data-model`.data{entities[{id,name,fields[{name,type?,pk?,fk?}]}],relations?}; `question-form`.data.questions[{id,title,mode:single|multi|freeform,options?}]. `diagram`/`custom-html` render inert HTML/CSS (Phase 2).",
  };
}

/** MCP `tools/list` definitions. Content is validated server-side against the
 *  PlanContent schema, so input schemas stay loose and the agent is told to
 *  call `get-plan-blocks` first. */
export const VISUAL_PLAN_TOOLS = [
  {
    name: "get-plan-blocks",
    description:
      "Return the authoritative visual-plan block catalog. ALWAYS call this before authoring or editing a plan.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create-visual-plan",
    description:
      "Create (or replace) the visual plan for this session. Renders live in the GITS visual plan side panel. Provide a structured `content` document.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        brief: { type: "string" },
        content: {
          type: "object",
          description: "PlanContent: { version:number, title?, brief?, blocks: PlanBlock[] }",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "update-visual-plan",
    description:
      "Apply targeted content patches to the current visual plan. Call get-plan-feedback first to read reviewer comments.",
    inputSchema: {
      type: "object",
      properties: {
        contentPatches: { type: "array", items: { type: "object" } },
      },
      required: ["contentPatches"],
      additionalProperties: false,
    },
  },
  {
    name: "get-visual-plan",
    description: "Return the current visual plan content as JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get-plan-feedback",
    description:
      "Return reviewer comments on the current visual plan (with anchors and routing). Act on comments whose resolutionTarget is 'agent'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "export-visual-plan",
    description:
      "Return the current visual plan (plus open reviewer comments) serialized as a single markdown document.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;
