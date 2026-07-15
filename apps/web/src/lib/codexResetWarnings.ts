export interface CodexResetCreditExpiry {
  readonly id: string;
  readonly expiresAt: string | null;
}

export interface CodexResetWarning {
  readonly key: string;
  readonly creditId: string;
  readonly thresholdHours: 48 | 24;
  readonly expiresAt: string;
}

export function collectDueResetWarnings(
  credits: ReadonlyArray<CodexResetCreditExpiry>,
  deliveredKeys: ReadonlySet<string>,
  now = Date.now(),
): CodexResetWarning[] {
  return credits.flatMap((credit) => {
    if (!credit.expiresAt) return [];
    const remainingHours = (Date.parse(credit.expiresAt) - now) / 3_600_000;
    if (remainingHours <= 0 || remainingHours > 48) return [];
    const thresholdHours = remainingHours <= 24 ? 24 : 48;
    const key = `${credit.id}:${thresholdHours}`;
    return deliveredKeys.has(key)
      ? []
      : [{ key, creditId: credit.id, thresholdHours, expiresAt: credit.expiresAt }];
  });
}
