// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { GitsNotesError, type GitsNote, type GitsNoteWriteInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { GitsNotes, type GitsNotesShape } from "../Services/GitsNotes.ts";

const seedId = "VPS localhost callback redirect for windows powershell.md";
const seedContent = "ssh -N -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 user@your-vps";
const notionVersion = "2026-03-11";

type Metadata = { readonly pageId: string | null; readonly hash: string | null };
type ParsedNote = { readonly body: string; readonly metadata: Metadata };
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const isGitsNotesError = Schema.is(GitsNotesError);

export interface GitsNotesOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly rename?: typeof fs.rename;
  readonly fetch?: Fetch;
  readonly now?: () => string;
}

const error = (message: string, cause?: unknown) =>
  new GitsNotesError({ message, ...(cause === undefined ? {} : { cause }) });
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

function parse(content: string): ParsedNote {
  const match = /^---\n(?:gitsNotionPageId: (.+)\n)?(?:gitsLastSyncedHash: (.+)\n)?---\n?/.exec(
    content,
  );
  if (!match) return { body: content, metadata: { pageId: null, hash: null } };
  const header = match[0];
  return {
    body: content.slice(header.length),
    metadata: {
      pageId: /^gitsNotionPageId: (.+)$/m.exec(header)?.[1] ?? null,
      hash: /^gitsLastSyncedHash: (.+)$/m.exec(header)?.[1] ?? null,
    },
  };
}

function serialize(body: string, metadata: Metadata): string {
  if (!metadata.pageId && !metadata.hash) return body;
  return `---\n${metadata.pageId ? `gitsNotionPageId: ${metadata.pageId}\n` : ""}${metadata.hash ? `gitsLastSyncedHash: ${metadata.hash}\n` : ""}---\n${body}`;
}

function assertId(id: string): void {
  if (path.basename(id) !== id || !id.endsWith(".md"))
    throw error("Note ID must be a Markdown basename.");
}

export function makeGitsNotes(options: GitsNotesOptions = {}): GitsNotesShape {
  const env = options.env ?? process.env;
  const vault = env.GITS_NOTES_DIR?.trim() || path.join(homedir(), ".gits", "notes");
  const rename = options.rename ?? fs.rename;
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => DateTime.formatIso(DateTime.nowUnsafe()));
  const filePath = (id: string) => path.join(vault, id);
  const ensureVault = async () => {
    await fs.mkdir(vault, { recursive: true });
    try {
      await fs.writeFile(filePath(seedId), seedContent, { encoding: "utf8", flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  };
  const write = async (id: string, body: string, metadata: Metadata) => {
    assertId(id);
    await ensureVault();
    const target = filePath(id);
    const temp = `${target}.tmp-${randomUUID()}`;
    await fs.writeFile(temp, serialize(body, metadata), "utf8");
    await rename(temp, target);
  };
  const readFile = async (id: string): Promise<GitsNote> => {
    assertId(id);
    await ensureVault();
    const [content, stat] = await Promise.all([
      fs.readFile(filePath(id), "utf8"),
      fs.stat(filePath(id)),
    ]);
    const parsed = parse(content);
    return {
      id,
      title: id.slice(0, -3),
      content: parsed.body,
      updatedAt: stat.mtime.toISOString(),
      notionPageId: parsed.metadata.pageId,
    };
  };
  const effect = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        isGitsNotesError(cause) ? cause : error("GITS notes operation failed.", cause),
    });
  const list = () =>
    effect(async () => {
      await ensureVault();
      const entries = await fs.readdir(vault, { withFileTypes: true });
      return Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => readFile(entry.name)),
      ).then((notes) =>
        notes.sort((a, b) => a.id.localeCompare(b.id)).map(({ content: _, ...summary }) => summary),
      );
    });
  const read = (input: { id: string }) => effect(() => readFile(input.id));
  const save = (input: GitsNoteWriteInput, exists: boolean) =>
    effect(async () => {
      assertId(input.id);
      if (exists) await fs.access(filePath(input.id));
      const previous = exists
        ? parse(await fs.readFile(filePath(input.id), "utf8"))
        : { metadata: { pageId: null, hash: null } };
      await write(input.id, input.content, previous.metadata);
      return readFile(input.id);
    });

  const request = async (url: string, init: RequestInit, token: string) => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": notionVersion,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw error(`Notion request failed (${response.status}).`);
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw error("Notion returned a malformed response.");
    return value as Record<string, unknown>;
  };
  const sync = () =>
    effect(async () => {
      const token = env.GITS_NOTES_NOTION_TOKEN?.trim();
      const source = env.GITS_NOTES_NOTION_DATA_SOURCE_ID?.trim();
      if (!token || !source)
        throw error(
          "Notion sync requires GITS_NOTES_NOTION_TOKEN and GITS_NOTES_NOTION_DATA_SOURCE_ID.",
        );
      const result = {
        created: [] as string[],
        updated: [] as string[],
        conflicts: [] as string[],
        warnings: [] as string[],
      };
      const remote = new Map<string, { id: string; title: string; body: string }>();
      let cursor: string | null = null;
      do {
        const query = await request(
          `https://api.notion.com/v1/data_sources/${source}/query`,
          { method: "POST", body: JSON.stringify(cursor ? { start_cursor: cursor } : {}) },
          token,
        );
        if (!Array.isArray(query.results)) throw error("Notion data source response is malformed.");
        for (const item of query.results) {
          if (!item || typeof item !== "object")
            throw error("Notion data source contains a malformed page.");
          const page = item as Record<string, unknown>;
          const id = page.id;
          const title = (
            (page.properties as Record<string, unknown> | undefined)?.Name as
              | { title?: Array<{ plain_text?: string }> }
              | undefined
          )?.title?.[0]?.plain_text;
          if (typeof id !== "string" || !title)
            throw error("Notion page is missing its Name title.");
          const markdown = await request(
            `https://api.notion.com/v1/pages/${id}/markdown`,
            { method: "GET" },
            token,
          );
          if (typeof markdown.markdown !== "string" || markdown.truncated === true)
            throw error("Notion Markdown response is malformed or truncated.");
          remote.set(id, { id, title, body: markdown.markdown });
        }
        const nextCursor = query.next_cursor;
        if (query.has_more === true) {
          if (typeof nextCursor !== "string")
            throw error("Notion data source pagination is malformed.");
          cursor = nextCursor;
        } else {
          cursor = null;
        }
      } while (cursor);
      const locals = await Effect.runPromise(list());
      for (const summary of locals) {
        const local = await readFile(summary.id);
        const stored = parse(await fs.readFile(filePath(summary.id), "utf8")).metadata;
        if (!stored.pageId) {
          if ([...remote.values()].some((page) => `${page.title}.md` === local.id)) continue;
          const created = await request(
            "https://api.notion.com/v1/pages",
            {
              method: "POST",
              body: JSON.stringify({
                parent: { type: "data_source_id", data_source_id: source },
                properties: { Name: { title: [{ text: { content: local.title } }] } },
                markdown: local.content,
              }),
            },
            token,
          );
          if (typeof created.id !== "string") throw error("Notion create response is malformed.");
          await write(local.id, local.content, { pageId: created.id, hash: hash(local.content) });
          result.created.push(local.id);
          remote.delete(created.id);
          continue;
        }
        const other = remote.get(stored.pageId);
        if (!other) continue;
        remote.delete(stored.pageId);
        const localChanged = stored.hash !== hash(local.content);
        const remoteChanged = stored.hash !== hash(other.body);
        if (localChanged && remoteChanged) {
          const stamp = now()
            .replace(/\.\d{3}Z$/, "Z")
            .replace(/:/g, "-");
          await write(`${local.id.slice(0, -3)} (Notion conflict ${stamp}).md`, other.body, {
            pageId: null,
            hash: null,
          });
          result.conflicts.push(local.id);
        } else if (localChanged) {
          await request(
            `https://api.notion.com/v1/pages/${stored.pageId}`,
            { method: "PATCH", body: JSON.stringify({ markdown: local.content }) },
            token,
          );
          await write(local.id, local.content, {
            pageId: stored.pageId,
            hash: hash(local.content),
          });
          result.updated.push(local.id);
        } else if (remoteChanged) {
          await write(local.id, other.body, { pageId: stored.pageId, hash: hash(other.body) });
          result.updated.push(local.id);
        }
      }
      for (const page of remote.values()) {
        const id = `${page.title}.md`;
        assertId(id);
        try {
          await fs.access(filePath(id));
          const stamp = now()
            .replace(/\.\d{3}Z$/, "Z")
            .replace(/:/g, "-");
          await write(`${id.slice(0, -3)} (Notion conflict ${stamp}).md`, page.body, {
            pageId: null,
            hash: null,
          });
          result.conflicts.push(id);
          continue;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        await write(id, page.body, { pageId: page.id, hash: hash(page.body) });
        result.created.push(id);
      }
      return result;
    });
  return {
    list,
    read,
    create: (input) => save(input, false),
    update: (input) => save(input, true),
    remove: ({ id }) =>
      effect(async () => {
        assertId(id);
        await fs.unlink(filePath(id));
      }),
    sync,
  };
}

export const GitsNotesLive = Layer.succeed(GitsNotes, makeGitsNotes());
