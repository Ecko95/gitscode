/**
 * Rendering untrusted visual-plan HTML/CSS.
 *
 * `diagram` / `custom-html` blocks carry agent-authored (therefore untrusted —
 * the agent can be steered by repo content) inert HTML + CSS. We render them in
 * a fully sandboxed iframe (`sandbox=""`, opaque origin) so no script can ever
 * execute and the CSS cannot leak into the GITS app. The helpers below add
 * defence-in-depth on top of that boundary: hard size caps and a conservative
 * strip of script/handler/`javascript:` constructs, plus theme-token injection
 * so the diagram inherits the panel's light/dark palette.
 */

export const VISUAL_HTML_MAX_BYTES = 40 * 1024;
export const VISUAL_CSS_MAX_BYTES = 20 * 1024;

/** The `--wf-*` design tokens forwarded into the sandboxed document. */
export const VISUAL_PLAN_THEME_VARS = [
  "--wf-ink",
  "--wf-muted",
  "--wf-line",
  "--wf-paper",
  "--wf-card",
  "--wf-accent",
  "--wf-accent-fg",
  "--wf-accent-soft",
  "--wf-warn",
  "--wf-ok",
  "--wf-radius",
] as const;

const byteLength = (value: string): number =>
  typeof TextEncoder !== "undefined" ? new TextEncoder().encode(value).length : value.length;

/**
 * Defence-in-depth strip of the obviously-executable constructs. The sandboxed
 * iframe is the real guarantee; this keeps the rendered DOM clean regardless and
 * survives an accidental loosening of the sandbox.
 */
export function stripDangerousHtml(html: string): string {
  return (
    html
      // <script>…</script> and lone <script …> / </script>
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<\/?script\b[^>]*>/gi, "")
      // framing / external resource elements
      .replace(/<\/?(?:iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
      // inline event handlers:  onclick="…"  on-error='…'  onload=foo
      .replace(/\son[a-z-]+\s*=\s*"[^"]*"/gi, "")
      .replace(/\son[a-z-]+\s*=\s*'[^']*'/gi, "")
      .replace(/\son[a-z-]+\s*=\s*[^\s>]+/gi, "")
      // javascript:/vbscript: URLs in href/src/etc.
      .replace(
        /((?:href|src|xlink:href|action|formaction)\s*=\s*)(["']?)\s*(?:javascript|vbscript|data\s*:\s*text\/html):[^"'>\s]*\2/gi,
        "$1$2#blocked$2",
      )
  );
}

export interface VisualBlockCapsResult {
  readonly html: string;
  readonly css: string;
  readonly truncated: boolean;
}

/** Enforce the size caps, truncating on a byte budget (UTF-8 aware-ish). */
export function enforceVisualBlockCaps(html: string, css: string): VisualBlockCapsResult {
  let truncated = false;
  let nextHtml = html;
  let nextCss = css;
  if (byteLength(nextHtml) > VISUAL_HTML_MAX_BYTES) {
    nextHtml = nextHtml.slice(0, VISUAL_HTML_MAX_BYTES);
    truncated = true;
  }
  if (byteLength(nextCss) > VISUAL_CSS_MAX_BYTES) {
    nextCss = nextCss.slice(0, VISUAL_CSS_MAX_BYTES);
    truncated = true;
  }
  return { html: nextHtml, css: nextCss, truncated };
}

/** Strip anything that could break out of the `<style>` element we wrap CSS in. */
function sanitizeScopedCss(css: string): string {
  return css
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<\/?(?:style|script)\b[^>]*>/gi, "")
    .replace(/<\/style/gi, "");
}

export interface BuildSrcDocInput {
  readonly html: string;
  readonly css?: string | undefined;
  /** Resolved `--wf-*` token values, keyed by token name. */
  readonly themeVars?: Readonly<Record<string, string>> | undefined;
}

/**
 * Assemble the `srcdoc` for the sandboxed iframe: a `:root` theme block, a base
 * reset that adopts the panel typography/colour, the block's scoped CSS, then
 * the sanitised HTML. CSS is naturally scoped — it lives in a separate document.
 */
export function buildVisualBlockSrcDoc(input: BuildSrcDocInput): string {
  const caps = enforceVisualBlockCaps(input.html, input.css ?? "");
  const safeHtml = stripDangerousHtml(caps.html);
  const safeCss = sanitizeScopedCss(caps.css);

  const themeVars = input.themeVars ?? {};
  const rootVars = VISUAL_PLAN_THEME_VARS.map((name) => {
    const value = themeVars[name];
    return value ? `${name}:${value};` : "";
  })
    .filter((line) => line.length > 0)
    .join("");

  const baseStyle = [
    rootVars ? `:root{${rootVars}}` : "",
    "html,body{margin:0;padding:0;background:transparent;}",
    "body{color:var(--wf-ink,#1f2328);font:12px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:auto;}",
    "img,svg,canvas,table{max-width:100%;}",
    "a{color:var(--wf-accent,#2563eb);}",
  ].join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyle}${safeCss}</style></head><body>${safeHtml}</body></html>`;
}

/** Read the resolved `--wf-*` tokens from a mounted surface element. */
export function readVisualPlanThemeVars(element: Element | null): Record<string, string> {
  if (!element || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return {};
  }
  const computed = window.getComputedStyle(element);
  const vars: Record<string, string> = {};
  for (const name of VISUAL_PLAN_THEME_VARS) {
    const value = computed.getPropertyValue(name).trim();
    if (value.length > 0) {
      vars[name] = value;
    }
  }
  return vars;
}
