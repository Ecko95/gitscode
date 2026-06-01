// @effect-diagnostics nodeBuiltinImport:off
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GitsSkillInventorySnapshot as GitsSkillInventorySnapshotSchema,
  type GitsSkillInsight,
  type GitsSkillInventoryItem,
  type GitsSkillInventorySnapshot,
  type GitsSkillKind,
  type GitsSkillPortability,
  type GitsSkillProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  GitsSkillInventoryResolver,
  GitsSkillInventoryResolverError,
  type GitsSkillInventoryResolverShape,
} from "../Services/GitsSkillInventory.ts";

export interface GitsSkillScanTarget {
  readonly provider: GitsSkillProvider;
  readonly kind: GitsSkillKind;
  readonly rootPath: string;
  readonly maxDepth?: number;
}

export interface GitsSkillInventoryResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly scanTargets?: ReadonlyArray<GitsSkillScanTarget>;
  readonly now?: () => string;
  readonly maxFilesPerRoot?: number;
}

interface SkillCandidate {
  readonly target: GitsSkillScanTarget;
  readonly filePath: string;
  readonly stats: Stats;
}

type RawSkillItem = Omit<GitsSkillInventoryItem, "portability"> & {
  readonly normalizedName: string;
};

const decodeSnapshot = Schema.decodeUnknownSync(GitsSkillInventorySnapshotSchema);
const PROVIDERS: ReadonlyArray<GitsSkillProvider> = ["codex", "claude", "cursor"];
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);

function isNotFoundError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

function cleanText(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  const trimmed = cleanText(value);
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
}

function titleCaseName(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function expandHome(rawPath: string, homeDir: string): string {
  if (rawPath === "~") {
    return homeDir;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function splitPathList(value: string | undefined, homeDir: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((entry) => expandHome(entry.trim(), homeDir))
    .filter((entry) => entry.length > 0);
}

function uniqueTargets(targets: ReadonlyArray<GitsSkillScanTarget>): GitsSkillScanTarget[] {
  const seen = new Set<string>();
  const unique: GitsSkillScanTarget[] = [];
  for (const target of targets) {
    const key = `${target.provider}:${target.kind}:${path.resolve(target.rootPath)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      ...target,
      rootPath: path.resolve(target.rootPath),
    });
  }
  return unique;
}

function defaultScanTargets(env: NodeJS.ProcessEnv, homeDir: string): GitsSkillScanTarget[] {
  const codexHome = expandHome(env.CODEX_HOME?.trim() || "~/.codex", homeDir);
  const claudeHome = expandHome(env.CLAUDE_HOME?.trim() || "~/.claude", homeDir);
  const cursorHome = expandHome(env.CURSOR_HOME?.trim() || "~/.cursor", homeDir);
  return uniqueTargets([
    ...splitPathList(env.GITS_CODEX_SKILL_ROOTS, homeDir).map((rootPath) => ({
      provider: "codex" as const,
      kind: "skill" as const,
      rootPath,
      maxDepth: 3,
    })),
    { provider: "codex", kind: "skill", rootPath: path.join(codexHome, "skills"), maxDepth: 3 },
    {
      provider: "codex",
      kind: "skill",
      rootPath: path.join(homeDir, ".agents", "skills"),
      maxDepth: 3,
    },
    ...splitPathList(env.GITS_CLAUDE_SKILL_ROOTS, homeDir).map((rootPath) => ({
      provider: "claude" as const,
      kind: "skill" as const,
      rootPath,
      maxDepth: 3,
    })),
    { provider: "claude", kind: "skill", rootPath: path.join(claudeHome, "skills"), maxDepth: 3 },
    { provider: "claude", kind: "agent", rootPath: path.join(claudeHome, "agents"), maxDepth: 2 },
    {
      provider: "claude",
      kind: "slash-command",
      rootPath: path.join(claudeHome, "commands"),
      maxDepth: 2,
    },
    ...splitPathList(env.GITS_CURSOR_SKILL_ROOTS, homeDir).map((rootPath) => ({
      provider: "cursor" as const,
      kind: "skill" as const,
      rootPath,
      maxDepth: 3,
    })),
    { provider: "cursor", kind: "skill", rootPath: path.join(cursorHome, "skills"), maxDepth: 3 },
    {
      provider: "cursor",
      kind: "skill",
      rootPath: path.join(cursorHome, "skills-cursor"),
      maxDepth: 3,
    },
    { provider: "cursor", kind: "rule", rootPath: path.join(cursorHome, "rules"), maxDepth: 3 },
    {
      provider: "cursor",
      kind: "slash-command",
      rootPath: path.join(cursorHome, "commands"),
      maxDepth: 2,
    },
  ]);
}

function isCandidateFile(entry: Dirent, target: GitsSkillScanTarget): boolean {
  if (!entry.isFile()) {
    return false;
  }
  const lowerName = entry.name.toLowerCase();
  if (lowerName === "skill.md") {
    return true;
  }
  if (target.kind === "skill") {
    return lowerName.endsWith(".skill.md");
  }
  if (target.kind === "rule") {
    return lowerName.endsWith(".mdc") || lowerName.endsWith(".md");
  }
  return lowerName.endsWith(".md") || lowerName.endsWith(".yaml") || lowerName.endsWith(".yml");
}

async function readOptionalDirectory(directoryPath: string): Promise<ReadonlyArray<Dirent> | null> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return null;
    }
    throw cause;
  }
}

async function collectCandidates(
  target: GitsSkillScanTarget,
  maxFiles: number,
): Promise<{
  readonly candidates: SkillCandidate[];
  readonly warnings: string[];
}> {
  const warnings: string[] = [];
  const candidates: SkillCandidate[] = [];
  const maxDepth = target.maxDepth ?? 3;

  async function walk(directoryPath: string, depth: number): Promise<void> {
    if (candidates.length >= maxFiles) {
      return;
    }
    const entries = await readOptionalDirectory(directoryPath);
    if (!entries) {
      if (depth === 0) {
        warnings.push(`Missing ${target.provider} ${target.kind} root: ${directoryPath}`);
      }
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= maxFiles) {
        warnings.push(`Stopped scanning ${target.rootPath} after ${maxFiles} files.`);
        return;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRECTORIES.has(entry.name)) {
          await walk(entryPath, depth + 1);
        }
        continue;
      }
      if (!isCandidateFile(entry, target)) {
        continue;
      }
      candidates.push({
        target,
        filePath: entryPath,
        stats: await fs.stat(entryPath),
      });
    }
  }

  await walk(target.rootPath, 0);
  return { candidates, warnings };
}

function resolveSkillName(candidate: SkillCandidate): string {
  const basename = path.basename(candidate.filePath);
  if (basename.toLowerCase() === "skill.md") {
    return normalizeName(path.basename(path.dirname(candidate.filePath))) || "skill";
  }
  return normalizeName(basename.replace(/\.(md|mdc|ya?ml)$/i, "")) || "skill";
}

function readMarkdownMetadata(
  raw: string,
  fallbackName: string,
): {
  readonly title: string;
  readonly description: string | null;
  readonly tags: string[];
} {
  let title: string | null = null;
  let description: string | null = null;
  const tags = new Set<string>();

  for (const rawLine of raw.split(/\r?\n/).slice(0, 80)) {
    const line = rawLine.trim();
    if (!line || line === "---") {
      continue;
    }
    const metadataMatch = line.match(
      /^(title|name|displayName|description|summary|tags)\s*:\s*(.+)$/i,
    );
    if (metadataMatch) {
      const key = metadataMatch[1]?.toLowerCase();
      const value = cleanText(metadataMatch[2] ?? "");
      if ((key === "title" || key === "name" || key === "displayname") && !title && value) {
        title = truncate(value, 160);
      }
      if ((key === "description" || key === "summary") && !description && value) {
        description = truncate(value, 280);
      }
      if (key === "tags") {
        value
          .replaceAll(/[[\]'"]/g, "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
          .forEach((tag) => tags.add(tag));
      }
      continue;
    }
    if (line.startsWith("#") && !title) {
      title = truncate(line.replace(/^#+\s*/, ""), 160);
      continue;
    }
    if (!description && !line.startsWith("#") && !line.startsWith("```")) {
      description = truncate(line.replace(/^[-*]\s*/, ""), 280);
    }
    if (title && description) {
      break;
    }
  }

  return {
    title: title ?? titleCaseName(fallbackName),
    description,
    tags: [...tags].toSorted(),
  };
}

async function readSkill(candidate: SkillCandidate): Promise<RawSkillItem> {
  const name = resolveSkillName(candidate);
  const raw = await fs.readFile(candidate.filePath, "utf8");
  const metadata = readMarkdownMetadata(raw, name);
  return {
    id: `${candidate.target.provider}:${candidate.target.kind}:${candidate.filePath}`,
    provider: candidate.target.provider,
    kind: candidate.target.kind,
    name,
    title: metadata.title,
    description: metadata.description,
    path: candidate.filePath,
    sourceRoot: candidate.target.rootPath,
    rating: null,
    review: null,
    usageCount: 0,
    lastUsedAt: null,
    lastModifiedAt: candidate.stats.mtime.toISOString(),
    tags: [candidate.target.provider, candidate.target.kind, ...metadata.tags].toSorted(),
    normalizedName: normalizeName(name),
  };
}

function applyPortability(items: ReadonlyArray<RawSkillItem>): GitsSkillInventoryItem[] {
  const codexNames = new Set(
    items.filter((item) => item.provider === "codex").map((item) => item.normalizedName),
  );
  return items.map(({ normalizedName, ...item }) => {
    let portability: GitsSkillPortability = "unknown";
    if (item.provider === "codex") {
      portability = "native";
    } else if (codexNames.has(normalizedName)) {
      portability = "ported";
    } else {
      portability = "missing-port";
    }
    return { ...item, portability };
  });
}

function buildInsights(skills: ReadonlyArray<GitsSkillInventoryItem>): GitsSkillInsight[] {
  const insights: GitsSkillInsight[] = [];
  const missingPorts = skills.filter((skill) => skill.portability === "missing-port");
  if (missingPorts.length > 0) {
    insights.push({
      id: "missing-provider-ports",
      kind: "missing-provider-port",
      title: "Provider skills need Codex/GITS ports",
      detail: `${missingPorts.length} Claude or Cursor skills do not have a matching Codex skill name yet.`,
      severity: "warning",
      skillIds: missingPorts.slice(0, 20).map((skill) => skill.id),
    });
  }

  const weakDescriptions = skills.filter(
    (skill) => !skill.description || skill.description.length < 24,
  );
  if (weakDescriptions.length > 0) {
    insights.push({
      id: "weak-skill-descriptions",
      kind: "weak-description",
      title: "Descriptions need tightening",
      detail: `${weakDescriptions.length} skills have missing or very short descriptions, which makes routing and HERMES improvement weaker.`,
      severity: "info",
      skillIds: weakDescriptions.slice(0, 20).map((skill) => skill.id),
    });
  }

  const byName = new Map<string, GitsSkillInventoryItem[]>();
  for (const skill of skills) {
    const key = normalizeName(skill.name);
    byName.set(key, [...(byName.get(key) ?? []), skill]);
  }
  const duplicates = [...byName.values()].filter((group) => group.length > 1);
  if (duplicates.length > 0) {
    insights.push({
      id: "duplicate-skill-names",
      kind: "duplicate-name",
      title: "Duplicate names detected",
      detail: `${duplicates.length} skill names appear in more than one provider or root.`,
      severity: "info",
      skillIds: duplicates.flatMap((group) => group.map((skill) => skill.id)).slice(0, 20),
    });
  }

  const hermesCandidates = new Set(
    [...missingPorts, ...weakDescriptions].slice(0, 40).map((skill) => skill.id),
  );
  if (hermesCandidates.size > 0) {
    insights.push({
      id: "hermes-improvement-candidates",
      kind: "hermes-candidate",
      title: "HERMES candidates ready",
      detail: `${hermesCandidates.size} skills are good candidates for HERMES-assisted porting or prompt improvement once writeback approval is wired.`,
      severity: "info",
      skillIds: [...hermesCandidates],
    });
  }

  return insights;
}

function providerSummaries(skills: ReadonlyArray<GitsSkillInventoryItem>) {
  return PROVIDERS.map((provider) => {
    const providerSkills = skills.filter((skill) => skill.provider === provider);
    return {
      provider,
      totalCount: providerSkills.length,
      nativeCount: providerSkills.filter((skill) => skill.portability === "native").length,
      missingPortCount: providerSkills.filter((skill) => skill.portability === "missing-port")
        .length,
      ratedCount: providerSkills.filter((skill) => skill.rating !== null).length,
      reviewedCount: providerSkills.filter((skill) => skill.review !== null).length,
    };
  }).filter((provider) => provider.totalCount > 0);
}

async function buildSnapshot(options: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDir?: string | undefined;
  readonly scanTargets?: ReadonlyArray<GitsSkillScanTarget> | undefined;
  readonly now: () => string;
  readonly maxFilesPerRoot: number;
}): Promise<GitsSkillInventorySnapshot> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const targets = uniqueTargets(options.scanTargets ?? defaultScanTargets(env, homeDir));
  const scanResults = await Promise.all(
    targets.map((target) => collectCandidates(target, options.maxFilesPerRoot)),
  );
  const warnings = scanResults.flatMap((result) => result.warnings);
  const rawItems = await Promise.all(
    scanResults.flatMap((result) => result.candidates).map((candidate) => readSkill(candidate)),
  );
  const skills = applyPortability(rawItems).toSorted((left, right) =>
    `${left.provider}:${left.kind}:${left.name}`.localeCompare(
      `${right.provider}:${right.kind}:${right.name}`,
    ),
  );
  const insights = buildInsights(skills);
  const providers = providerSummaries(skills);
  const snapshot = {
    scannedAt: options.now(),
    skills,
    providers,
    totals: {
      skillCount: skills.length,
      providerCount: providers.length,
      ratedCount: skills.filter((skill) => skill.rating !== null).length,
      reviewedCount: skills.filter((skill) => skill.review !== null).length,
      missingPortCount: skills.filter((skill) => skill.portability === "missing-port").length,
      hermesCandidateCount:
        insights.find((insight) => insight.kind === "hermes-candidate")?.skillIds.length ?? 0,
    },
    warnings: warnings.slice(0, 40),
    insights,
  };
  return decodeSnapshot(snapshot);
}

export const makeGitsSkillInventoryResolver = (options?: GitsSkillInventoryResolverOptions) =>
  GitsSkillInventoryResolver.of({
    getSnapshot: () =>
      Effect.gen(function* () {
        const scannedAt = options?.now ? options.now() : DateTime.formatIso(yield* DateTime.now);
        return yield* Effect.tryPromise({
          try: () =>
            buildSnapshot({
              env: options?.env,
              homeDir: options?.homeDir,
              scanTargets: options?.scanTargets,
              now: () => scannedAt,
              maxFilesPerRoot: options?.maxFilesPerRoot ?? 400,
            }),
          catch: (cause) =>
            new GitsSkillInventoryResolverError({
              message: "Failed to scan local GITS skill inventory.",
              cause,
            }),
        });
      }),
  } satisfies GitsSkillInventoryResolverShape);

export const GitsSkillInventoryResolverLive = Layer.succeed(
  GitsSkillInventoryResolver,
  makeGitsSkillInventoryResolver(),
);
