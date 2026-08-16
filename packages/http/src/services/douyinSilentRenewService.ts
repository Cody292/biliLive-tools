/**
 * 静默续期编排服务（方案 B · T5）
 *
 * 边界：
 * - 仅编排：取号 → runSilentProfileRenew → mapSilentRenewResult → scheduleHealthAccountPatch
 * - 不改 routes / FE / Mode A / 探针 C
 * - 日志仅 meta（redactCookieMeta）；永不打印完整 cookie
 * - 账号缺失：AccountNotFoundError（路由可映射 404）
 * - accountId 非法：InvalidAccountIdError（路由可映射 400）
 */

import type { DouyinAccountHealthStatus, DouyinCookieAccount } from "@biliLive-tools/types";
import {
  mapSilentRenewResult,
  redactCookieMeta,
  sanitizeAccountId,
  scheduleHealthAccountPatch,
  type MapSilentRenewOptions,
  type SilentRenewCoreResult,
  type SilentRenewFailureClass,
  type SilentRenewRuntimeInput,
  type ScheduleHealthAccountPatchInput,
} from "@biliLive-tools/shared";

import {
  runSilentProfileRenew,
  type RunSilentProfileRenewOptions,
} from "./douyinProfileRuntime.js";

/** 账号未找到；路由层应映射 HTTP 404 */
export class AccountNotFoundError extends Error {
  readonly code = "ACCOUNT_NOT_FOUND" as const;
  readonly accountId: string;

  constructor(accountId: string) {
    super(`account not found: ${accountId}`);
    this.name = "AccountNotFoundError";
    this.accountId = accountId;
  }
}

/** FE 安全 API 结果：可含 cookie 便于内存同步，服务端写盘以 schedule 为准 */
export type SilentRenewApiResult = {
  readonly ok: boolean;
  readonly healthStatus?: DouyinAccountHealthStatus | string;
  readonly failureClass?: SilentRenewFailureClass;
  readonly message: string;
  readonly healthCheckedAt?: number;
  readonly updatedAt?: string;
  /** 成功时可选返回，便于 FE 内存同步；禁止日志打印 */
  readonly cookie?: string;
};

export type SilentRenewAccountInput = {
  readonly accountId: string;
};

export type GetAccountFn = (
  accountId: string,
) =>
  | DouyinCookieAccount
  | null
  | undefined
  | Promise<DouyinCookieAccount | null | undefined>;

export type RunSilentProfileRenewFn = (
  options: RunSilentProfileRenewOptions,
) => Promise<SilentRenewRuntimeInput>;

export type MapSilentRenewResultFn = (
  input: SilentRenewRuntimeInput,
  options?: MapSilentRenewOptions,
) => SilentRenewCoreResult;

export type ScheduleHealthAccountPatchFn = (input: ScheduleHealthAccountPatchInput) => void;

export type SilentRenewServiceLogPayload = Record<
  string,
  string | number | boolean | undefined
>;

export type SilentRenewServiceDeps = {
  readonly getAccount: GetAccountFn;
  readonly runSilentProfileRenew?: RunSilentProfileRenewFn;
  readonly mapSilentRenewResult?: MapSilentRenewResultFn;
  readonly scheduleHealthAccountPatch?: ScheduleHealthAccountPatchFn;
  readonly now?: () => number;
  readonly log?: (payload: SilentRenewServiceLogPayload) => void;
  /** 透传给 runSilentProfileRenew 的可选运行时参数（不含 accountId/seedCookie） */
  readonly profileOptions?: Omit<RunSilentProfileRenewOptions, "accountId" | "seedCookie">;
};

/**
 * 编排单账号静默续期。
 *
 * 404 约定：账号缺失抛 `AccountNotFoundError`（code=ACCOUNT_NOT_FOUND）。
 * 400 约定：accountId 非法抛 `InvalidAccountIdError`（code=INVALID_ACCOUNT_ID）。
 * 其余失败以 `SilentRenewApiResult.ok=false` 返回，不抛。
 */
export async function silentRenewAccount(
  deps: SilentRenewServiceDeps,
  input: SilentRenewAccountInput,
): Promise<SilentRenewApiResult> {
  const runRenew = deps.runSilentProfileRenew ?? runSilentProfileRenew;
  const mapResult = deps.mapSilentRenewResult ?? mapSilentRenewResult;
  const schedulePatch = deps.scheduleHealthAccountPatch ?? scheduleHealthAccountPatch;
  const now = deps.now ?? Date.now;
  const log = deps.log;

  // 1) accountId 合法校验（空/路径穿越 → 400 形态）
  const accountId = sanitizeAccountId(input.accountId);

  // 2) 取号
  const account = await deps.getAccount(accountId);
  if (account == null) {
    log?.({
      phase: "account_missing",
      accountId,
    });
    throw new AccountNotFoundError(accountId);
  }

  const seedCookie = typeof account.cookie === "string" ? account.cookie : "";
  const cookieMeta = redactCookieMeta(seedCookie);

  log?.({
    phase: "start",
    accountId,
    cookieLen: cookieMeta.cookieLen,
    cookiePrefix: cookieMeta.prefix,
  });

  // 3) runtime 静默续期
  const runtime = await runRenew({
    ...deps.profileOptions,
    accountId,
    seedCookie: seedCookie || undefined,
    expectedAccountUid: account.accountUid,
    deps: {
      ...deps.profileOptions?.deps,
      now,
      log: deps.profileOptions?.deps?.log ?? log,
    },
  });

  // 4) 映射 Schema B patch
  const mapped = mapResult(runtime, { now: now() });

  // 5) 有 patch 则写健康（成功 / auth_expired / 仅 reason 等，与 core 一致）
  if (mapped.patch != null) {
    schedulePatch({
      accountId,
      patch: mapped.patch,
    });
  }

  const healthCheckedAt = mapped.patch?.healthCheckedAt;
  const healthStatus = mapped.patch?.healthStatus;
  const updatedAt = mapped.ok ? mapped.patch?.updatedAt : undefined;

  const api: SilentRenewApiResult = {
    ok: mapped.ok,
    message: mapped.message,
    ...(mapped.failureClass !== undefined ? { failureClass: mapped.failureClass } : {}),
    ...(healthStatus !== undefined ? { healthStatus } : {}),
    ...(healthCheckedAt !== undefined ? { healthCheckedAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };

  const resultCookieMeta =
    api.cookie != null ? redactCookieMeta(api.cookie) : { cookieLen: 0, prefix: "" };

  log?.({
    phase: "done",
    accountId,
    ok: api.ok,
    failureClass: api.failureClass,
    healthStatus: typeof api.healthStatus === "string" ? api.healthStatus : undefined,
    healthCheckedAt: api.healthCheckedAt,
    cookieLen: resultCookieMeta.cookieLen,
    cookiePrefix: resultCookieMeta.prefix,
    hashBefore12: runtime.rotate?.hashBefore12,
    hashAfter12: runtime.rotate?.hashAfter12,
    rotated: api.ok,
  });

  return api;
}
