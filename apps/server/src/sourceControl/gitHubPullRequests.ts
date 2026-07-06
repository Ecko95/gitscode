import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  TrimmedNonEmptyString,
  type ChangeRequestCheckState,
  type ChangeRequestChecks,
  type ChangeRequestMergeability,
} from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

const GitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

const GitHubPullRequestChecksSchema = Schema.Struct({
  mergeable: Schema.optional(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

const GitHubStatusCheckRollupEntrySchema = Schema.Struct({
  __typename: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  workflowName: Schema.optional(Schema.NullOr(Schema.String)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
  targetUrl: Schema.optional(Schema.NullOr(Schema.String)),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGitHubPullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const normalizedState = input.state?.trim().toUpperCase();
  if (
    (typeof input.mergedAt === "string" && input.mergedAt.trim().length > 0) ||
    normalizedState === "MERGED"
  ) {
    return "merged";
  }
  if (normalizedState === "CLOSED") {
    return "closed";
  }
  return "open";
}

function normalizeGitHubPullRequestRecord(
  raw: Schema.Schema.Type<typeof GitHubPullRequestSchema>,
): NormalizedGitHubPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.headRepository?.nameWithOwner);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.headRepositoryOwner?.login) ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    state: normalizeGitHubPullRequestState(raw),
    updatedAt: raw.updatedAt ?? Option.none(),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

const decodeGitHubPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGitHubPullRequest = decodeJsonResult(GitHubPullRequestSchema);
const decodeGitHubPullRequestChecks = decodeJsonResult(GitHubPullRequestChecksSchema);
const decodeGitHubPullRequestEntry = Schema.decodeUnknownExit(GitHubPullRequestSchema);
const decodeGitHubStatusCheckRollupEntry = Schema.decodeUnknownExit(
  GitHubStatusCheckRollupEntrySchema,
);

export const formatGitHubJsonDecodeError = formatSchemaError;

export function decodeGitHubPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedGitHubPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeGitHubPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGitHubPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGitHubPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGitHubPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGitHubPullRequestJson(
  raw: string,
): Result.Result<NormalizedGitHubPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGitHubPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}

function normalizeMergeability(value: string | null | undefined): ChangeRequestMergeability | null {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "MERGEABLE") return "mergeable";
  if (normalized === "CONFLICTING") return "conflicting";
  if (normalized === "UNKNOWN") return "unknown";
  return null;
}

function normalizeCheckState(input: {
  readonly state?: string | null | undefined;
  readonly status?: string | null | undefined;
  readonly conclusion?: string | null | undefined;
}): ChangeRequestCheckState {
  const state = input.state?.trim().toUpperCase();
  if (state === "SUCCESS") return "passed";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  if (state === "PENDING" || state === "EXPECTED") return "pending";

  const conclusion = input.conclusion?.trim().toUpperCase();
  if (conclusion === "SUCCESS") return "passed";
  if (
    conclusion === "FAILURE" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED" ||
    conclusion === "STARTUP_FAILURE"
  ) {
    return "failed";
  }
  if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return "skipped";

  const status = input.status?.trim().toUpperCase();
  if (status === "QUEUED" || status === "IN_PROGRESS" || status === "WAITING") {
    return "pending";
  }
  if (status === "COMPLETED") return "unknown";
  return "unknown";
}

export function decodeGitHubPullRequestChecksJson(
  raw: string,
): Result.Result<ChangeRequestChecks, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGitHubPullRequestChecks(raw);
  if (Result.isFailure(result)) {
    return Result.fail(result.failure);
  }

  const checks: Array<ChangeRequestChecks["checks"][number]> = [];
  for (const entry of result.success.statusCheckRollup ?? []) {
    const decodedEntry = decodeGitHubStatusCheckRollupEntry(entry);
    if (Exit.isFailure(decodedEntry)) {
      continue;
    }
    const rawEntry = decodedEntry.value;
    const name =
      trimOptionalString(rawEntry.name) ??
      trimOptionalString(rawEntry.context) ??
      trimOptionalString(rawEntry.workflowName);
    if (!name) {
      continue;
    }
    checks.push({
      name,
      state: normalizeCheckState(rawEntry),
      detailUrl: trimOptionalString(rawEntry.detailsUrl) ?? trimOptionalString(rawEntry.targetUrl),
    });
  }

  return Result.succeed({
    summary: {
      passed: checks.filter((check) => check.state === "passed").length,
      failed: checks.filter((check) => check.state === "failed").length,
      pending: checks.filter((check) => check.state === "pending").length,
    },
    checks,
    mergeable: normalizeMergeability(result.success.mergeable),
  });
}
