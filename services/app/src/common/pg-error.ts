export function getPgCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code)) {
      return record.code;
    }
    for (const key of ['cause', 'meta', 'original', 'driverError']) {
      const nested = walk(record[key]);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };
  return walk(error);
}

export function isRecoverableConcurrencyError(error: unknown): boolean {
  const code = getPgCode(error);
  return code === '40P01' || code === '40001';
}

export function isLockOrStatementTimeout(error: unknown): boolean {
  const code = getPgCode(error);
  if (code === '57014' || code === '55P03') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /lock_timeout|statement_timeout|canceling statement/i.test(message);
}
