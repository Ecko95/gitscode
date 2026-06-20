import { describe, expect, it } from "vitest";

import {
  buildVisualBlockSrcDoc,
  enforceVisualBlockCaps,
  stripDangerousHtml,
  VISUAL_CSS_MAX_BYTES,
  VISUAL_HTML_MAX_BYTES,
} from "./visualPlanHtml.ts";

describe("stripDangerousHtml", () => {
  it("removes <script> blocks and lone script tags", () => {
    const out = stripDangerousHtml('<div>ok</div><script>alert(1)</script><script src="x.js">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<div>ok</div>");
  });

  it("strips inline event handlers in any quote style", () => {
    const out = stripDangerousHtml(
      `<img src="a.png" onerror="steal()"><b onclick='x()'>hi</b><i onmouseover=go>y</i>`,
    );
    expect(out).not.toMatch(/onerror|onclick|onmouseover/i);
    expect(out).toContain("hi");
    expect(out).toContain("y");
  });

  it("neutralises javascript: and data:text/html URLs", () => {
    const out = stripDangerousHtml(
      `<a href="javascript:alert(1)">x</a><a href='vbscript:msgbox'>y</a>`,
    );
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out.toLowerCase()).not.toContain("vbscript:");
  });

  it("removes framing/external-resource elements", () => {
    const out = stripDangerousHtml('<iframe src="evil"></iframe><object></object><link rel="x">');
    expect(out).not.toMatch(/<iframe|<object|<link/i);
  });

  it("preserves benign inline-styled markup", () => {
    const html = '<svg viewBox="0 0 10 10"><rect style="fill:var(--wf-accent)"/></svg>';
    expect(stripDangerousHtml(html)).toBe(html);
  });
});

describe("enforceVisualBlockCaps", () => {
  it("passes through content within caps", () => {
    const res = enforceVisualBlockCaps("<p>small</p>", "p{color:red}");
    expect(res.truncated).toBe(false);
    expect(res.html).toBe("<p>small</p>");
  });

  it("truncates oversize html and flags it", () => {
    const big = "x".repeat(VISUAL_HTML_MAX_BYTES + 100);
    const res = enforceVisualBlockCaps(big, "");
    expect(res.truncated).toBe(true);
    expect(res.html.length).toBeLessThanOrEqual(VISUAL_HTML_MAX_BYTES);
  });

  it("truncates oversize css and flags it", () => {
    const big = "a".repeat(VISUAL_CSS_MAX_BYTES + 100);
    const res = enforceVisualBlockCaps("<p/>", big);
    expect(res.truncated).toBe(true);
    expect(res.css.length).toBeLessThanOrEqual(VISUAL_CSS_MAX_BYTES);
  });
});

describe("buildVisualBlockSrcDoc", () => {
  it("wraps sanitised html + scoped css into a self-contained document", () => {
    const doc = buildVisualBlockSrcDoc({
      html: '<div class="box">hi</div><script>evil()</script>',
      css: ".box{color:var(--wf-ink)}",
      themeVars: { "--wf-ink": "#101010", "--wf-accent": "#2563eb" },
    });
    expect(doc).toContain("<!doctype html>");
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("evil()");
    expect(doc).toContain(".box{color:var(--wf-ink)}");
    expect(doc).toContain("--wf-ink:#101010;");
    expect(doc).toContain('<div class="box">hi</div>');
  });

  it("prevents CSS from breaking out of the style element", () => {
    const doc = buildVisualBlockSrcDoc({
      html: "<p>x</p>",
      css: "</style><script>evil()</script>",
    });
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("evil()");
  });

  it("omits the :root block when no theme vars are supplied", () => {
    const doc = buildVisualBlockSrcDoc({ html: "<p>x</p>" });
    expect(doc).not.toContain(":root{}");
  });
});
