// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import { makeGitsNotes } from "./GitsNotes.ts";

const seedId = "VPS localhost callback redirect for windows powershell.md";
const seedContent = "ssh -N -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 user@your-vps";

const withVault = async (
  test: (notes: ReturnType<typeof makeGitsNotes>, dir: string) => Promise<void>,
) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
  try {
    await test(makeGitsNotes({ env: { GITS_NOTES_DIR: dir } }), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

describe("GitsNotesLive vault", () => {
  it("creates a missing vault and seed only once", () =>
    withVault(async (notes, dir) => {
      await Effect.runPromise(notes.list());
      expect(await fs.readFile(path.join(dir, seedId), "utf8")).toBe(seedContent);
      await fs.writeFile(path.join(dir, seedId), "custom", "utf8");
      await Effect.runPromise(notes.list());
      expect(await fs.readFile(path.join(dir, seedId), "utf8")).toBe("custom");
    }));

  it("lists only direct markdown files", () =>
    withVault(async (notes, dir) => {
      await fs.writeFile(path.join(dir, "keep.md"), "ok");
      await fs.writeFile(path.join(dir, "skip.txt"), "no");
      await fs.mkdir(path.join(dir, "nested"));
      await fs.writeFile(path.join(dir, "nested", "skip.md"), "no");
      expect((await Effect.runPromise(notes.list())).map((note) => note.id).sort()).toEqual(
        [seedId, "keep.md"].sort(),
      );
    }));

  it("rejects traversal IDs", () =>
    withVault(async (notes) => {
      await expect(Effect.runPromise(notes.read({ id: "../x.md" }))).rejects.toThrow(/basename/i);
    }));

  it("writes and reads a note", () =>
    withVault(async (notes) => {
      const created = await Effect.runPromise(
        notes.create({ id: "one.md", title: "One", content: "hello" }),
      );
      expect(created).toMatchObject({
        id: "one.md",
        title: "one",
        content: "hello",
        notionPageId: null,
      });
      expect(await Effect.runPromise(notes.read({ id: "one.md" }))).toMatchObject({
        content: "hello",
      });
    }));

  it("does not overwrite an existing note during create", () =>
    withVault(async (notes, dir) => {
      await fs.writeFile(path.join(dir, "one.md"), "previous", "utf8");
      await expect(
        Effect.runPromise(notes.create({ id: "one.md", title: "One", content: "next" })),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(dir, "one.md"), "utf8")).toBe("previous");
    }));

  it("renames an updated note from its title without losing frontmatter", () =>
    withVault(async (notes, dir) => {
      await fs.writeFile(
        path.join(dir, "one.md"),
        "---\ngitsNotionPageId: page-one\ngitsLastSyncedHash: hash-one\n---\nprevious",
      );
      await expect(
        Effect.runPromise(notes.update({ id: "one.md", title: "Renamed", content: "next" })),
      ).resolves.toMatchObject({
        id: "Renamed.md",
        title: "Renamed",
        content: "next",
        notionPageId: "page-one",
      });
      await expect(fs.access(path.join(dir, "one.md"))).rejects.toThrow();
      expect(await fs.readFile(path.join(dir, "Renamed.md"), "utf8")).toContain(
        "gitsNotionPageId: page-one",
      );
    }));

  it("does not lose the source note when its rename target exists", () =>
    withVault(async (notes, dir) => {
      await fs.writeFile(path.join(dir, "one.md"), "previous", "utf8");
      await fs.writeFile(path.join(dir, "Taken.md"), "taken", "utf8");
      await expect(
        Effect.runPromise(notes.update({ id: "one.md", title: "Taken", content: "next" })),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(dir, "one.md"), "utf8")).toBe("previous");
      expect(await fs.readFile(path.join(dir, "Taken.md"), "utf8")).toBe("taken");
    }));

  it("deletes only the selected note", () =>
    withVault(async (notes) => {
      await Effect.runPromise(notes.create({ id: "one.md", title: "One", content: "one" }));
      await Effect.runPromise(notes.create({ id: "two.md", title: "Two", content: "two" }));
      await Effect.runPromise(notes.remove({ id: "one.md" }));
      expect(await Effect.runPromise(notes.read({ id: "two.md" }))).toMatchObject({
        content: "two",
      });
    }));

  it("keeps the previous complete file if rename fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    const notes = makeGitsNotes({
      env: { GITS_NOTES_DIR: dir },
      rename: () => Promise.reject(new Error("rename failed")),
    });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "one.md"), "previous", "utf8");
    await expect(
      Effect.runPromise(notes.update({ id: "one.md", title: "one", content: "next" })),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(dir, "one.md"), "utf8")).toBe("previous");
  });
});

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("GitsNotesLive Notion sync", () => {
  it("creates a Notion Markdown page for a local note", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/query")) return json({ results: [] });
      if (url.endsWith("/pages")) return json({ id: "page-local" });
      throw new Error(`unexpected request ${url}`);
    });
    const notes = makeGitsNotes({
      env: {
        GITS_NOTES_DIR: dir,
        GITS_NOTES_NOTION_TOKEN: "token",
        GITS_NOTES_NOTION_DATA_SOURCE_ID: "source",
      },
      fetch,
    });
    await Effect.runPromise(
      notes.create({ id: "local.md", title: "Local", content: "local markdown" }),
    );
    await Effect.runPromise(notes.sync());
    const localCreate = fetch.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/pages") && String(init?.body).includes("local markdown"),
    );
    expect(localCreate?.[1]?.headers).toMatchObject({
      Authorization: "Bearer token",
      "Notion-Version": "2026-03-11",
    });
    expect(JSON.parse(String(localCreate?.[1]?.body))).toMatchObject({
      markdown: "local markdown",
      properties: { Name: { title: [{ text: { content: "local" } }] } },
    });
  });

  it("creates a mapped local file from remote Markdown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/query")
        ? json({
            results: [
              { id: "page-remote", properties: { Name: { title: [{ plain_text: "Remote" }] } } },
            ],
          })
        : String(input).endsWith("/markdown")
          ? json({ markdown: "remote markdown" })
          : json({ id: "page-seed" }),
    );
    const notes = makeGitsNotes({
      env: {
        GITS_NOTES_DIR: dir,
        GITS_NOTES_NOTION_TOKEN: "token",
        GITS_NOTES_NOTION_DATA_SOURCE_ID: "source",
      },
      fetch,
    });
    await Effect.runPromise(notes.sync());
    expect(await Effect.runPromise(notes.read({ id: "Remote.md" }))).toMatchObject({
      content: "remote markdown",
      notionPageId: "page-remote",
    });
  });

  it("replaces mapped remote Markdown through the enhanced Markdown endpoint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "Local.md"),
      "---\ngitsNotionPageId: page-local\ngitsLastSyncedHash: 4794cd39245362643b1c7ba2aaf611a97734f5759157a303c76af75825d77555\n---\nlocal markdown",
    );
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/query"))
        return json({
          results: [
            { id: "page-local", properties: { Name: { title: [{ plain_text: "Local" }] } } },
          ],
        });
      if (url.endsWith("/page-local/markdown")) return json({ markdown: "remote markdown" });
      if (url.endsWith("/pages")) return json({ id: "page-seed" });
      throw new Error(`unexpected request ${url}`);
    });
    const notes = makeGitsNotes({
      env: {
        GITS_NOTES_DIR: dir,
        GITS_NOTES_NOTION_TOKEN: "token",
        GITS_NOTES_NOTION_DATA_SOURCE_ID: "source",
      },
      fetch,
    });
    await Effect.runPromise(notes.sync());
    expect(fetch).toHaveBeenCalledWith(
      "https://api.notion.com/v1/pages/page-local/markdown",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          type: "replace_content",
          replace_content: { new_str: "local markdown" },
        }),
      }),
    );
  });

  it("rejects unsafe remote titles before writing to the vault", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/query")
        ? json({
            results: [
              { id: "page-unsafe", properties: { Name: { title: [{ plain_text: "../unsafe" }] } } },
            ],
          })
        : String(input).endsWith("/markdown")
          ? json({ markdown: "remote markdown" })
          : json({ id: "page-seed" }),
    );
    const notes = makeGitsNotes({
      env: { GITS_NOTES_NOTION_TOKEN: "token", GITS_NOTES_NOTION_DATA_SOURCE_ID: "source" },
      fetch,
    });
    await expect(Effect.runPromise(notes.sync())).rejects.toThrow(/basename/i);
  });

  it("writes a conflict copy when both sides changed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    const oldHash = "b".repeat(64);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "dual.md"),
      `---\ngitsNotionPageId: page-dual\ngitsLastSyncedHash: ${oldHash}\n---\nlocal changed`,
    );
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/query")
        ? json({
            results: [
              { id: "page-dual", properties: { Name: { title: [{ plain_text: "dual" }] } } },
            ],
          })
        : String(input).endsWith("/markdown")
          ? json({ markdown: "remote changed" })
          : json({ id: "page-seed" }),
    );
    const notes = makeGitsNotes({
      env: {
        GITS_NOTES_DIR: dir,
        GITS_NOTES_NOTION_TOKEN: "token",
        GITS_NOTES_NOTION_DATA_SOURCE_ID: "source",
      },
      fetch,
      now: () => "2026-07-14T10:00:00.000Z",
    });
    const result = await Effect.runPromise(notes.sync());
    expect(result.conflicts).toContain("dual.md");
    expect(
      await fs.readFile(path.join(dir, "dual (Notion conflict 2026-07-14T10-00-00Z).md"), "utf8"),
    ).toBe("remote changed");
  });

  it("preserves an existing unmapped filename when remote import collides", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Remote.md"), "local content");
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/query")
        ? json({
            results: [
              { id: "page-remote", properties: { Name: { title: [{ plain_text: "Remote" }] } } },
            ],
          })
        : String(input).endsWith("/page-remote/markdown")
          ? json({ markdown: "remote content" })
          : json({ id: "page-seed" }),
    );
    const notes = makeGitsNotes({
      env: {
        GITS_NOTES_DIR: dir,
        GITS_NOTES_NOTION_TOKEN: "token",
        GITS_NOTES_NOTION_DATA_SOURCE_ID: "source",
      },
      fetch,
      now: () => "2026-07-14T10:00:00.000Z",
    });
    const result = await Effect.runPromise(notes.sync());
    expect(await fs.readFile(path.join(dir, "Remote.md"), "utf8")).toBe("local content");
    expect(
      await fs.readFile(path.join(dir, "Remote (Notion conflict 2026-07-14T10-00-00Z).md"), "utf8"),
    ).toBe("remote content");
    expect(result.conflicts).toContain("Remote.md");
  });

  it("queries every Notion data-source page", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-gits-notes-"));
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/query")) {
        return String(init?.body).includes("cursor-2")
          ? json({
              results: [{ id: "page-2", properties: { Name: { title: [{ plain_text: "Two" }] } } }],
              has_more: false,
            })
          : json({
              results: [{ id: "page-1", properties: { Name: { title: [{ plain_text: "One" }] } } }],
              has_more: true,
              next_cursor: "cursor-2",
            });
      }
      if (url.endsWith("/page-1/markdown")) return json({ markdown: "one" });
      if (url.endsWith("/page-2/markdown")) return json({ markdown: "two" });
      return json({ id: "page-seed" });
    });
    const notes = makeGitsNotes({
      env: {
        GITS_NOTES_DIR: dir,
        GITS_NOTES_NOTION_TOKEN: "token",
        GITS_NOTES_NOTION_DATA_SOURCE_ID: "source",
      },
      fetch,
    });
    await Effect.runPromise(notes.sync());
    expect(await Effect.runPromise(notes.read({ id: "One.md" }))).toMatchObject({ content: "one" });
    expect(await Effect.runPromise(notes.read({ id: "Two.md" }))).toMatchObject({ content: "two" });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/query"))).toHaveLength(2);
  });

  it("returns a typed configuration error without HTTP when Notion is unconfigured", async () => {
    const fetch = vi.fn();
    const notes = makeGitsNotes({ env: {}, fetch });
    await expect(Effect.runPromise(notes.sync())).rejects.toThrow(/GITS_NOTES_NOTION_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
