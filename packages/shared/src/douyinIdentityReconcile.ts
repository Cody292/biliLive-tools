/** query/user 身份对账：只认 user_uid / user.uid / user.sec_uid，trim 后去空。 */

export type DouyinIdentityReconcileReason =
  | "empty_account_uid"
  | "empty_probe_identity"
  | "identity_mismatch";

export type DouyinIdentityReconcileResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DouyinIdentityReconcileReason };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 从 query/user JSON 收集可对账身份键。
 * 仅读取 user_uid、user.uid、user.sec_uid；不认 user_id / userId。
 */
export function collectQueryUserIdentityKeys(body: unknown): string[] {
  if (!isPlainRecord(body)) return [];

  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const key = trimKey(value);
    if (key === undefined || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  push(body.user_uid);
  if (isPlainRecord(body.user)) {
    push(body.user.uid);
    push(body.user.sec_uid);
  }
  return keys;
}

/**
 * 将账号池 accountUid 与探针身份键对账。
 * 空 accountUid 优先于空探针键；任一 trim 后命中即通过。
 */
export function reconcileDouyinAccountUid(
  accountUid: string | undefined,
  keys: readonly string[],
): DouyinIdentityReconcileResult {
  const trimmedAccount = typeof accountUid === "string" ? accountUid.trim() : "";
  if (trimmedAccount.length === 0) {
    return { ok: false, reason: "empty_account_uid" };
  }

  const trimmedKeys: string[] = [];
  for (const key of keys) {
    const trimmed = key.trim();
    if (trimmed.length > 0) trimmedKeys.push(trimmed);
  }
  if (trimmedKeys.length === 0) {
    return { ok: false, reason: "empty_probe_identity" };
  }

  if (trimmedKeys.includes(trimmedAccount)) {
    return { ok: true };
  }
  return { ok: false, reason: "identity_mismatch" };
}
