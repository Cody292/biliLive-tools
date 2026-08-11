/**
 * 抖音 Cookie 账号选号/恢复候选 + 探针 A。
 * §9.5：候选从权威源每次重算；quarantine=invalid|relogin_required。
 *
 * 不静态依赖 @biliLive-tools/shared（shared→DouYinRecorder 包循环）。
 * 健康谓词/计数与 shared/douyinAccountHealth 契约对齐；
 * 写盘经 setDouyinHealthPatchScheduler 注入 scheduleHealthAccountPatch。
 * 探针 B 见 probeB.ts（经本文件 re-export）。
 */

export const AUTH_FAIL_THRESHOLD = 2;

export type DouyinAccountHealthStatus =
  | "healthy"
  | "expiring"
  | "invalid"
  | "relogin_required"
  | "unknown";

/** 选号/健康所需最小账号形状（与 types/liveManager 字段对齐） */
export type DouyinCookieAccountLike = {
  id?: string;
  remark?: string;
  cookie?: string;
  enabled?: boolean;
  weight?: number | null;
  updatedAt?: string;
  healthStatus?: DouyinAccountHealthStatus;
  healthCheckedAt?: number;
  healthReason?: string;
};

export type DouyinAccountHealthPatch = {
  healthStatus?: DouyinAccountHealthStatus;
  healthCheckedAt?: number;
  healthReason?: string;
  cookie?: string;
};

const QUARANTINED = new Set<DouyinAccountHealthStatus>(["invalid", "relogin_required"]);
const HEALTH_STATUSES = new Set<DouyinAccountHealthStatus>([
  "healthy",
  "expiring",
  "invalid",
  "relogin_required",
  "unknown",
]);

export function normalizeHealthStatus(
  input:
    | DouyinAccountHealthStatus
    | Pick<DouyinCookieAccountLike, "healthStatus">
    | null
    | undefined,
): DouyinAccountHealthStatus {
  if (input == null) return "unknown";
  if (typeof input === "string") {
    return HEALTH_STATUSES.has(input) ? input : "unknown";
  }
  const status = input.healthStatus;
  if (status == null || !HEALTH_STATUSES.has(status)) return "unknown";
  return status;
}

export function isQuarantinedAccount(
  account: Pick<DouyinCookieAccountLike, "healthStatus">,
): boolean {
  return QUARANTINED.has(normalizeHealthStatus(account));
}

export function applyHealthPatch<T extends DouyinCookieAccountLike>(
  account: T,
  patch: DouyinAccountHealthPatch,
): T {
  const next = { ...account };
  if (patch.healthStatus !== undefined) next.healthStatus = patch.healthStatus;
  if (patch.healthCheckedAt !== undefined) next.healthCheckedAt = patch.healthCheckedAt;
  if (patch.healthReason !== undefined) next.healthReason = patch.healthReason;
  if (patch.cookie !== undefined) next.cookie = patch.cookie;
  return next;
}

export type AuthFailCounter = {
  recordAuthFail: (id: string) => number;
  resetAuthFail: (id: string) => void;
  shouldInvalidate: (id: string) => boolean;
};

export function createAuthFailCounter(threshold: number = AUTH_FAIL_THRESHOLD): AuthFailCounter {
  const counts = new Map<string, number>();
  return {
    recordAuthFail(id: string): number {
      const next = (counts.get(id) ?? 0) + 1;
      counts.set(id, next);
      return next;
    },
    resetAuthFail(id: string): void {
      counts.delete(id);
    },
    shouldInvalidate(id: string): boolean {
      return (counts.get(id) ?? 0) >= threshold;
    },
  };
}

const defaultAuthFailCounter = createAuthFailCounter(AUTH_FAIL_THRESHOLD);

export function getDefaultAuthFailCounter(): AuthFailCounter {
  return defaultAuthFailCounter;
}

export type HealthPatchScheduler = (input: {
  accountId: string;
  patch: DouyinAccountHealthPatch;
}) => void;

let healthPatchScheduler: HealthPatchScheduler | null = null;

/** 宿主绑定 scheduleHealthAccountPatch（通常在 shared/http 启动时） */
export function setDouyinHealthPatchScheduler(fn: HealthPatchScheduler | null): void {
  healthPatchScheduler = fn;
}

export type SelectableDouyinCookieAccount = DouyinCookieAccountLike & {
  cookie: string;
};

/** §9.5：从权威源重算；enabled 与 quarantine 正交 */
export function deriveSelectableDouyinCookieAccounts(
  accounts: readonly DouyinCookieAccountLike[] | null | undefined,
): SelectableDouyinCookieAccount[] {
  const list = accounts ?? [];
  const result: SelectableDouyinCookieAccount[] = [];
  for (const account of list) {
    if (account.enabled === false) continue;
    const cookie = account.cookie?.trim();
    if (!cookie) continue;
    if (isQuarantinedAccount(account)) continue;
    result.push({
      ...account,
      cookie,
      remark: typeof account.remark === "string" ? account.remark.trim() : account.remark,
    });
  }
  return result;
}

export function isAuthFailureError(error: unknown): boolean {
  if (error == null) return false;

  const status =
    typeof error === "object" && error !== null
      ? Number(
          (error as { statusCode?: unknown; status?: unknown; httpStatus?: unknown }).statusCode ??
            (error as { status?: unknown }).status ??
            (error as { httpStatus?: unknown }).httpStatus,
        )
      : Number.NaN;
  if (status === 401 || status === 403) return true;

  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (
    /timeout|timed?\s*out|etimedout|econnreset|enotfound|econnrefused|network|socket hang up|no message received/.test(
      msg,
    )
  ) {
    return false;
  }
  return /(?:^|[^\d])401(?:[^\d]|$)|(?:^|[^\d])403(?:[^\d]|$)|unauthorized|auth[_\s-]?fail|login[_\s-]?required|cookie.*(invalid|expired|失效)|鉴权|未登录|请重新登录|relogin|登录失效|登录过期|session.*(invalid|expired)/.test(
    msg,
  );
}

export type MarkAuthFailureInput = {
  accountId: string;
  reason: string;
  accounts: DouyinCookieAccountLike[] | null | undefined;
  now?: number;
  counter?: AuthFailCounter;
  schedulePatch?: HealthPatchScheduler;
};

export type MarkAuthFailureResult =
  | { kind: "ignored" }
  | { kind: "counted"; count: number; invalidated: false }
  | {
      kind: "invalidated";
      count: number;
      invalidated: true;
      patch: DouyinAccountHealthPatch;
    };

/** 探针 A：连续 AUTH_FAIL_THRESHOLD 次鉴权失败 → invalid；不改 updatedAt */
export function markAuthFailure(input: MarkAuthFailureInput): MarkAuthFailureResult {
  const { accountId, reason, accounts } = input;
  if (!accountId) return { kind: "ignored" };

  const counter = input.counter ?? defaultAuthFailCounter;
  const count = counter.recordAuthFail(accountId);
  if (!counter.shouldInvalidate(accountId)) {
    return { kind: "counted", count, invalidated: false };
  }

  const now = input.now ?? Date.now();
  const patch: DouyinAccountHealthPatch = {
    healthStatus: "invalid",
    healthCheckedAt: now,
    healthReason: reason,
  };

  if (Array.isArray(accounts)) {
    const idx = accounts.findIndex((a) => a?.id === accountId);
    if (idx >= 0) {
      accounts[idx] = applyHealthPatch(accounts[idx], patch);
    }
  }

  const schedule = input.schedulePatch ?? healthPatchScheduler;
  schedule?.({ accountId, patch });

  return { kind: "invalidated", count, invalidated: true, patch };
}

export function resetAuthFailForAccount(
  accountId: string | undefined,
  counter: AuthFailCounter = defaultAuthFailCounter,
): void {
  if (!accountId) return;
  counter.resetAuthFail(accountId);
}

export function getSelectableAccountIndices(
  selectable: readonly SelectableDouyinCookieAccount[],
  authCookie?: string,
): number[] {
  if (selectable.length === 0) return [];
  const indices = selectable.map((_a, i) => i);
  if (!authCookie) return indices;
  const authIdx = selectable.findIndex((a) => a.cookie === authCookie);
  if (authIdx < 0) return indices;
  return [authIdx, ...indices.filter((i) => i !== authIdx)];
}

export function getHealthPatchScheduler(): HealthPatchScheduler | null {
  return healthPatchScheduler;
}

// 探针 B re-export（保持 cookieAccountSelection 单一导入面）
export {
  CHECK_WINDOW_MS,
  MIN_PROBE_INTERVAL_MS,
  isPastCheckWindow,
  mapProbeResultToHealthPatch,
  maybeProbeAccount,
  probeAccountsNeedingCheck,
  resetProbeBStateForTests,
  setDouyinProbeOnce,
  shouldProbeAccount,
} from "./probeB.js";
export type {
  DouyinProbeOnceFn,
  MaybeProbeAccountInput,
  MaybeProbeResult,
  MaybeProbeSkipReason,
  ProbeAccountsNeedingCheckInput,
  ProbeFailureClass,
  ProbeOnceFail,
  ProbeOnceOk,
  ProbeOnceResult,
} from "./probeB.js";
