/**
 * Pure helpers for the native visual-plan MCP server: applying content
 * patches, exporting a plan to markdown (for sending back to the chat
 * session), and describing the block registry / tool surface.
 */
import type { PlanBlock, PlanComment, PlanContent, PlanContentPatch } from "@t3tools/contracts";
import { PLAN_BLOCK_TYPES } from "@t3tools/contracts";

export function applyPlanPatches(
  content: PlanContent,
  patches: ReadonlyArray<PlanContentPatch>,
): PlanContent {
  let next = content;
  for (const patch of patches) {
    next = applyPlanPatch(next, patch);
  }
  return next;
}

function applyPlanPatch(content: PlanContent, patch: PlanContentPatch): PlanContent {
  switch (patch.op) {
    case "set-metadata":
      return {
        ...content,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
      };
    case "replace-blocks":
      return { ...content, blocks: patch.blocks };
    case "replace-block":
      return {
        ...content,
        blocks: content.blocks.map((block) => (block.id === patch.blockId ? patch.block : block)),
      };
    case "remove-block":
      return { ...content, blocks: content.blocks.filter((block) => block.id !== patch.blockId) };
    case "append-block": {
      if (patch.afterBlockId) {
        const index = content.blocks.findIndex((block) => block.id === patch.afterBlockId);
        if (index >= 0) {
          const blocks = [...content.blocks];
          blocks.splice(index + 1, 0, patch.block);
          return { ...content, blocks };
        }
      }
      return { ...content, blocks: [...content.blocks, patch.block] };
    }
    case "update-rich-text":
      return {
        ...content,
        blocks: content.blocks.map((block) => {
          if (block.id !== patch.blockId || block.type !== "rich-text") {
            return block;
          }
          return {
            ...block,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            data: {
              ...block.data,
              ...(patch.markdown !== undefined ? { markdown: patch.markdown } : {}),
            },
          };
        }),
      };
    case "update-block":
      return {
        ...content,
        blocks: content.blocks.map((block) => {
          if (block.id !== patch.blockId) {
            return block;
          }
          const merged = {
            ...block,
            ...(patch.patch.title !== undefined ? { title: patch.patch.title } : {}),
            ...(patch.patch.summary !== undefined ? { summary: patch.patch.summary } : {}),
            ...(patch.patch.editable !== undefined ? { editable: patch.patch.editable } : {}),
            ...(patch.patch.data !== undefined
              ? { data: { ...(block as { data: unknown }).data as object, ...patch.patch.data } }
              : {}),
          };
          return merged as PlanBlock;
        }),
      };
  }
}

/** Serialize a plan + reviewer comments to a single markdown document. */
export function exportPlanToMarkdown(content: PlanContent, comments: ReadonlyArray<PlanComment>): string {
  const lines: string[] = [];
  if (content.title) {
    lines.push(`# ${content.title}`, "");
  }
  if (content.brief) {
    lines.push(content.brief, "");
  }
  for (const block of content.blocks) {
    lines.push(...blockToMarkdown(block));
    lines.push("");
  }
  const open = comments.filter((comment) => !comment.resolvedAt);
  if (open.length > 0) {
    lines.push("## Reviewer comments", "");
    for (const comment of open) {
      const target = describeAnchor(comment);
      const routing = comment.resolutionTarget ? ` _(for: ${comment.resolutionTarget})_` : "";
      lines.push(`- **${target}**${routing}: ${comment.message}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function describeAnchor(comment: PlanComment): string {
  const anchor = comment.anchor;
  if (anchor.textQuote) {
    return `on “${truncate(anchor.textQuote, 80)}”`;
  }
  if (anchor.blockId) {
    return `on block ${anchor.blockId}`;
  }
  if (anchor.sectionId) {
    return `on section ${anchor.sectionId}`;
  }
  return "general";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function blockToMarkdown(block: PlanBlock): string[] {
  const heading = block.title ? [`### ${block.title}`, ""] : [];
  switch (block.type) {
    case "rich-text":
      return [...heading, block.data.markdown];
    case "callout":
      return [...heading, `> ${block.data.tone ? `**${block.data.tone.toUpperCase()}** ` : ""}${block.data.body}`];
    case "checklist":
      return [
        ...heading,
        ...block.data.items.map(
          (item) => `- [${item.checked ? "x" : " "}] ${item.label}${item.note ? ` — ${item.note}` : ""}`,
        ),
      ];
    case "table":
      return [
        ...heading,
        `| ${block.data.columns.join(" | ")} |`,
        `| ${block.data.columns.map(() => "---").join(" | ")} |`,
        ...block.data.rows.map((row) => `| ${row.join(" | ")} |`),
      ];
    case "code":
      return [...heading, "```" + (block.data.language ?? ""), block.data.code, "```"];
    case "annotated-code":
      return [
        ...heading,
        block.data.filename ? `_${block.data.filename}_` : "",
        "```" + (block.data.language ?? ""),
        block.data.code,
        "```",
        ...(block.data.annotations ?? []).map((a) => `- lines ${a.lines}: ${a.label ? `**${a.label}** ` : ""}${a.note}`),
      ].filter((line) => line !== "");
    case "file-tree":
      return [...heading, ...block.data.entries.map((e) => `- ${e.change ? `[${e.change}] ` : ""}\`${e.path}\`${e.note ? ` — ${e.note}` : ""}`)];
    case "implementation-map":
      return [...heading, ...block.data.files.map((f) => `- \`${f.path}\`${f.title ? ` (${f.title})` : ""} — ${f.note}`)];
    case "api-endpoint":
      return [...heading, `\`${block.data.method} ${block.data.path}\`${block.data.summary ? ` — ${block.data.summary}` : ""}`];
    case "data-model":
      return [
        ...heading,
        ...block.data.entities.flatMap((entity) => [
          `**${entity.name}**`,
          ...entity.fields.map((field) => `- ${field.name}${field.type ? `: ${field.type}` : ""}${field.pk ? " (pk)" : ""}`),
        ]),
      ];
    case "question-form":
      return [
        ...heading,
        ...block.data.questions.map(
          (question) =>
            `**${question.title}** (${question.mode})${question.options ? `: ${question.options.map((o) => o.label).join(", ")}` : ""}`,
        ),
      ];
    case "diagram":
    case "custom-html":
      return [...heading, block.data.caption ?? "_(visual block)_"];
    case "tabs":
      return [...heading, ...block.data.tabs.flatMap((tab) => [`**${tab.label}**`, ...tab.blocks.flatMap(blockToMarkdown)])];
    case "columns":
      return [...heading, ...block.data.columns.flatMap((column) => column.blocks.flatMap(blockToMarkdown))];
  }
}

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
