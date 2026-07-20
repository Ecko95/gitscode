import type {
  GitsSkillInventoryItem,
  GitsSkillInventorySnapshot,
  GitsSkillProvider,
} from "@t3tools/contracts";
import {
  BookOpenCheckIcon,
  CircleIcon,
  GitBranchIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  StarIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import {
  EmptyState,
  SectionHeader,
  StatBlock,
  StatusPill,
  formatCount,
  isRecord,
  statusTone,
} from "./primitives";

export type SkillReviewState = Record<
  string,
  {
    readonly rating: number | null;
    readonly review: string;
  }
>;

const SKILL_REVIEW_STORAGE_KEY = "gits:skills:reviews:v1";

export function loadSkillReviewState(): SkillReviewState {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SKILL_REVIEW_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const reviews: SkillReviewState = {};
    for (const [skillId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const rating = typeof value.rating === "number" ? value.rating : null;
      const review = typeof value.review === "string" ? value.review : "";
      reviews[skillId] = {
        rating:
          rating !== null && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
        review,
      };
    }
    return reviews;
  } catch {
    return {};
  }
}

export function saveSkillReviewState(reviews: SkillReviewState): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SKILL_REVIEW_STORAGE_KEY, JSON.stringify(reviews));
}

function formatSkillProvider(provider: GitsSkillProvider): string {
  if (provider === "gits") {
    return "GITS";
  }
  return provider.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatSkillKind(kind: GitsSkillInventoryItem["kind"]): string {
  return kind.replaceAll("-", " ");
}

function portabilityTone(
  portability: GitsSkillInventoryItem["portability"],
): ReturnType<typeof statusTone> {
  if (portability === "native" || portability === "ported") {
    return "success";
  }
  if (portability === "missing-port" || portability === "candidate") {
    return "warning";
  }
  return "default";
}

function applySkillReviews(
  skill: GitsSkillInventoryItem,
  reviews: SkillReviewState,
): GitsSkillInventoryItem {
  const review = reviews[skill.id];
  if (!review) {
    return skill;
  }
  return {
    ...skill,
    rating: review.rating,
    review: review.review.trim().length > 0 ? review.review : null,
  };
}

export function SkillsPanel({
  snapshot,
  loading,
  error,
  reviews,
  onRefresh,
  onRatingChange,
  onReviewChange,
}: {
  snapshot: GitsSkillInventorySnapshot | undefined;
  loading: boolean;
  error: unknown;
  reviews: SkillReviewState;
  onRefresh: () => void;
  onRatingChange: (skillId: string, rating: number | null) => void;
  onReviewChange: (skillId: string, review: string) => void;
}) {
  const [providerFilter, setProviderFilter] = useState<GitsSkillProvider | "all">("all");
  const [search, setSearch] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const skills = useMemo(
    () => (snapshot?.skills ?? []).map((skill) => applySkillReviews(skill, reviews)),
    [reviews, snapshot?.skills],
  );
  const visibleSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    return skills.filter((skill) => {
      if (providerFilter !== "all" && skill.provider !== providerFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        skill.name,
        skill.title,
        skill.description ?? "",
        skill.path,
        skill.provider,
        skill.kind,
        skill.portability,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [providerFilter, search, skills]);
  const selectedSkill =
    (selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) : null) ??
    visibleSkills[0] ??
    null;
  const ratedCount = skills.filter((skill) => skill.rating !== null).length;
  const reviewedCount = skills.filter((skill) => skill.review !== null).length;
  const errorMessage = error instanceof Error ? error.message : null;

  useEffect(() => {
    if (selectedSkillId && visibleSkills.some((skill) => skill.id === selectedSkillId)) {
      return;
    }
    setSelectedSkillId(visibleSkills[0]?.id ?? null);
  }, [selectedSkillId, visibleSkills]);

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Skills Intelligence</h2>
            <StatusPill label="local host" tone="default" />
            <StatusPill
              label={loading && !snapshot ? "scanning" : "read-only"}
              tone={loading && !snapshot ? "warning" : "success"}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCount(snapshot?.totals.skillCount ?? 0)} skills |{" "}
            {formatCount(snapshot?.totals.missingPortCount ?? 0)} missing ports |{" "}
            {formatCount(ratedCount)} rated | {formatCount(reviewedCount)} reviewed
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4">
        <StatBlock
          label="Skills"
          value={formatCount(snapshot?.totals.skillCount ?? 0)}
          icon={BookOpenCheckIcon}
        />
        <StatBlock
          label="Providers"
          value={formatCount(snapshot?.totals.providerCount ?? 0)}
          icon={CircleIcon}
        />
        <StatBlock
          label="Missing Ports"
          value={formatCount(snapshot?.totals.missingPortCount ?? 0)}
          icon={GitBranchIcon}
        />
        <StatBlock
          label="HERMES"
          value={formatCount(snapshot?.totals.hermesCandidateCount ?? 0)}
          icon={SparklesIcon}
        />
      </div>

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.85fr)]">
        <div className="min-w-0 border-r border-border/60">
          <div className="grid gap-2 border-b border-border/60 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:px-5">
            <div className="relative min-w-0">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                nativeInput
                size="sm"
                value={search}
                placeholder="Search skills"
                className="pl-8"
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            <select
              value={providerFilter}
              className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
              onChange={(event) =>
                setProviderFilter(event.currentTarget.value as GitsSkillProvider | "all")
              }
            >
              <option value="all">All providers</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="cursor">Cursor</option>
            </select>
          </div>

          <SectionHeader title="Inventory" count={visibleSkills.length} />
          {loading && visibleSkills.length === 0 ? (
            <EmptyState label="Scanning local provider skills..." />
          ) : visibleSkills.length === 0 ? (
            <EmptyState label="No skills match the current filters." />
          ) : (
            <div className="divide-y divide-border/60">
              {visibleSkills.slice(0, 160).map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/35 sm:px-5",
                    selectedSkill?.id === skill.id && "bg-muted/55",
                  )}
                  onClick={() => setSelectedSkillId(skill.id)}
                >
                  <BookOpenCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-medium">{skill.title}</span>
                      <StatusPill label={formatSkillProvider(skill.provider)} tone="default" />
                      <StatusPill
                        label={skill.portability.replaceAll("-", " ")}
                        tone={portabilityTone(skill.portability)}
                      />
                    </div>
                    <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                      {skill.description ?? skill.path}
                    </div>
                  </div>
                </button>
              ))}
              {visibleSkills.length > 160 ? (
                <div className="px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
                  +{formatCount(visibleSkills.length - 160)} more skills
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionHeader title="Review" count={selectedSkill ? 1 : 0} />
          {selectedSkill ? (
            <div className="grid gap-4 px-4 py-4 text-xs sm:px-5">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold">{selectedSkill.title}</h3>
                  <StatusPill
                    label={`${formatSkillProvider(selectedSkill.provider)} ${formatSkillKind(
                      selectedSkill.kind,
                    )}`}
                    tone="default"
                  />
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {selectedSkill.path}
                </div>
                {selectedSkill.description ? (
                  <p className="mt-2 text-muted-foreground">{selectedSkill.description}</p>
                ) : null}
              </div>

              <div className="grid gap-2">
                <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                  Rating
                </div>
                <div
                  role="group"
                  aria-label={`Skill rating: ${selectedSkill.rating ?? 0} of 5`}
                  className="flex flex-wrap gap-1"
                >
                  {[1, 2, 3, 4, 5].map((rating) => {
                    const selected = (selectedSkill.rating ?? 0) >= rating;
                    return (
                      <Button
                        key={rating}
                        size="icon-sm"
                        variant={selected ? "default" : "outline"}
                        onClick={() =>
                          onRatingChange(
                            selectedSkill.id,
                            selectedSkill.rating === rating ? null : rating,
                          )
                        }
                        aria-label={`Rate ${rating}`}
                        aria-pressed={selected}
                      >
                        <StarIcon className={cn("size-3.5", selected && "fill-current")} />
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-2">
                <div className="text-[11px] font-medium uppercase text-muted-foreground/80">
                  Review
                </div>
                <Textarea
                  value={reviews[selectedSkill.id]?.review ?? ""}
                  placeholder="Notes, quality issues, porting ideas"
                  className="min-h-28 text-xs"
                  onChange={(event) => onReviewChange(selectedSkill.id, event.currentTarget.value)}
                />
              </div>

              <div className="grid gap-2">
                <SectionHeader title="Provider summaries" count={snapshot?.providers.length ?? 0} />
                <div className="overflow-hidden rounded-md border border-border/70">
                  {(snapshot?.providers ?? []).map((provider) => (
                    <div
                      key={provider.provider}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                    >
                      <span className="truncate font-medium">
                        {formatSkillProvider(provider.provider)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.totalCount)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {formatCount(provider.missingPortCount)} missing ports
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                <SectionHeader title="Insights" count={snapshot?.insights.length ?? 0} />
                {(snapshot?.insights ?? []).length === 0 ? (
                  <EmptyState label="No skill insights yet." />
                ) : (
                  <div className="grid gap-2">
                    {(snapshot?.insights ?? []).map((insight) => (
                      <div key={insight.id} className="rounded-md border border-border/70 p-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">{insight.title}</span>
                          <StatusPill
                            label={insight.severity}
                            tone={statusTone(insight.severity)}
                          />
                        </div>
                        <p className="mt-1 text-muted-foreground">{insight.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {(snapshot?.warnings ?? []).length > 0 ? (
                <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
                  {(snapshot?.warnings ?? []).slice(0, 3).join(" | ")}
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState label="Select a skill to review." />
          )}
        </div>
      </div>
    </section>
  );
}
