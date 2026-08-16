import type {
  DouyinAccountHealthStatus,
  DouyinCookieAccount,
} from "@biliLive-tools/types";

export type { DouyinAccountHealthStatus };

/** 健康探测默认窗口：12 小时 */
export const CHECK_WINDOW_MS = 12 * 60 * 60 * 1000;

/** 连续鉴权失败达到此阈值后判定应 invalidate（仅计数接口，不接 Recorder） */
export const AUTH_FAIL_THRESHOLD = 2;

const HEALTH_STATUSES = new Set<DouyinAccountHealthStatus>([
  "healthy",
  "expiring",
  "invalid",
  "relogin_required",
  "unknown",
]);

const QUARANTINED = new Set<DouyinAccountHealthStatus>(["invalid", "relogin_required"]);

type HealthStatusInput =
  | DouyinAccountHealthStatus
  | Pick<DouyinCookieAccount, "healthStatus">
  | null
  | undefined;

/**
 * 归一化健康状态：缺省 / null / 非法值 → unknown（6d 历史兼容）。
 */
export function normalizeHealthStatus(input: HealthStatusInput): DouyinAccountHealthStatus {
  if (input == null) return "unknown";
  if (typeof input === "string") {
    return HEALTH_STATUSES.has(input) ? input : "unknown";
  }
  const status = input.healthStatus;
  if (status == null || !HEALTH_STATUSES.has(status)) return "unknown";
  return status;
}

/** invalid | relogin_required 视为隔离，不参与正常选号 */
export function isQuarantinedAccount(
  account: Pick<DouyinCookieAccount, "healthStatus">,
): boolean {
  return QUARANTINED.has(normalizeHealthStatus(account));
}

/**
 * 是否已超过健康检查窗口。
 * healthCheckedAt 缺省视为过窗。
 */
export function isPastCheckWindow(
  healthCheckedAt: number | undefined,
  now: number = Date.now(),
  windowMs: number = CHECK_WINDOW_MS,
): boolean {
  if (healthCheckedAt == null) return true;
  return now - healthCheckedAt >= windowMs;
}

/** unknown 或过窗 → 应探测 */
export function shouldProbeAccount(
  account: Pick<DouyinCookieAccount, "healthStatus" | "healthCheckedAt">,
  now: number = Date.now(),
): boolean {
  if (normalizeHealthStatus(account) === "unknown") return true;
  return isPastCheckWindow(account.healthCheckedAt, now);
}

export type DouyinAccountHealthPatch = {
  healthStatus?: DouyinAccountHealthStatus;
  healthCheckedAt?: number;
  healthReason?: string;
  updatedAt?: string;
  /** 仅当显式传入时才覆盖 cookie / updatedAt */
  cookie?: string;
};

/**
 * 合并 health* 字段，返回新对象。
 * cookie / updatedAt 仅当 patch 显式携带时覆盖。
 */
export function applyHealthPatch(
  account: DouyinCookieAccount,
  patch: DouyinAccountHealthPatch,
): DouyinCookieAccount {
  const next: DouyinCookieAccount = { ...account };
  if (patch.healthStatus !== undefined) next.healthStatus = patch.healthStatus;
  if (patch.healthCheckedAt !== undefined) next.healthCheckedAt = patch.healthCheckedAt;
  if (patch.healthReason !== undefined) next.healthReason = patch.healthReason;
  if (patch.cookie !== undefined) next.cookie = patch.cookie;
  if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;
  return next;
}

export type AuthFailCounter = {
  recordAuthFail: (id: string) => number;
  resetAuthFail: (id: string) => void;
  shouldInvalidate: (id: string) => boolean;
};

/** 进程内连续鉴权失败计数（阈值 AUTH_FAIL_THRESHOLD） */
export function createAuthFailCounter(
  threshold: number = AUTH_FAIL_THRESHOLD,
): AuthFailCounter {
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
