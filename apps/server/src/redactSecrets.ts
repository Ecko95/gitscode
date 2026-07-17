/** Cheap last-mile redaction for logs, diagnostics, and other serialized text surfaces. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string | ((match: string) => string)]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]"],
  [/\bsk-ant-[A-Za-z0-9\-_]{8,}/g, "sk-ant-[REDACTED]"],
  [/\bsk-[A-Za-z0-9\-_]{20,}/g, "sk-[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{10,}/g, "ghp_[REDACTED]"],
  [/\bghs_[A-Za-z0-9]{10,}/g, "ghs_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "github_pat_[REDACTED]"],
  [
    /"(?:api_?key|token|secret|access_token|refresh_token|auth_token|bearer_token|client_secret)"\s*:\s*"[A-Za-z0-9\-._~+/]{20,}=*"/gi,
    (match: string) => match.replace(/"[A-Za-z0-9\-._~+/]{20,}=*"$/, '"[REDACTED]"'),
  ],
  [
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|PASSWORD|TOKEN|SECRET))=(?:"[^"]*"|'[^']*'|[^\s]+)/g,
    (match: string) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`,
  ],
  [
    /(--(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|token|secret|password)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    (match: string) =>
      `${match.slice(0, Math.max(match.lastIndexOf("="), match.lastIndexOf(" ")) + 1)}[REDACTED]`,
  ],
  [
    /\b(?:code|state|api_?key|access_token|refresh_token|auth_token|bearer_token|token|secret|client_secret)=(?:"[^"]*"|'[^']*'|[^\s&#]+)/gi,
    (match: string) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`,
  ],
  [
    /([?&](?:code|state|access_token|refresh_token|auth_token|token)=)[^&#\s"']+/gi,
    (match: string) => `${match.slice(0, match.indexOf("=") + 1)}[REDACTED]`,
  ],
];

export function redactSecrets(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement as string);
  }
  return result;
}
