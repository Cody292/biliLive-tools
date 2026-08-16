/**
 * 探针 B：可分类 probeOnce 注入 + shouldProbe + 30s 限流。
 * 层1 任务联动路径：probeOnce 结果走探针 C 升级阶梯（auth_failed 2/3）。
 * 不静态依赖 http/shared（包环）；probeOnce / schedulePatch 经注入。
 */
import {
  applyHealthPatch,
  getHealthPatchScheduler,
  isQuarantinedAccount,
  normalizeHealthStatus,
  type DouyinAccountHealthPatch,
  type DouyinCookieAccountLike,
  type HealthPatchScheduler,
} from "./cookieAccountSelection.js";
import {
  getDefaultProbeCAuthCounter,
  mapProbeCResultToHealthPatch,
  type ProbeCAuthCounter,
  type ProbeCEscalation,
  type ProbeCMapResult,
} from "./probeCCore.js";

export const CHECK_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MIN_PROBE_INTERVAL_MS = 30_000;

export type ProbeFailureClass =
  | "auth_failed"
  | "http_error"
  | "timeout"
  | "parse_error"
  | "network"
  | "unknown";

export type ProbeOnceOk = {
  readonly ok: true;
  readonly identity?: {
    readonly nickname?: string;
    readonly uid?: string;
    readonly sec_user_id?: string;
  };
};

export type ProbeOnceFail = {
  readonly ok: false;
  readonly class: ProbeFailureClass;
  readonly httpStatus?: number;
  readonly reason?: string;
};

export type ProbeOnceResult = ProbeOnceOk | ProbeOnceFail;

export type DouyinProbeOnceFn = (cookie: string) => Promise<ProbeOnceResult>;

let probeOnceFn: DouyinProbeOnceFn | null = null;
let lastProbeStartedAt = 0;

export function setDouyinProbeOnce(fn: DouyinProbeOnceFn | null): void {
  probeOnceFn = fn;
}

export function resetProbeBStateForTests(options: { clearProbeFn?: boolean } = {}): void {
  lastProbeStartedAt = 0;
  if (options.clearProbeFn) {
    probeOnceFn = null;
  }
}

export function isPastCheckWindow(
  healthCheckedAt: number | undefined,
  now: number = Date.now(),
  windowMs: number = CHECK_WINDOW_MS,
): boolean {
  if (healthCheckedAt == null) return true;
  return now - healthCheckedAt >= windowMs;
}

export function shouldProbeAccount(
  account: Pick<DouyinCookieAccountLike, "healthStatus" | "healthCheckedAt">,
  now: number = Date.now(),
): boolean {
  if (normalizeHealthStatus(account) === "unknown") return true;
  return isPastCheckWindow(account.healthCheckedAt, now);
}

function isProbeOnceFail(result: ProbeOnceResult): result is ProbeOnceFail {
  return result.ok === false;
}

/**
 * 兼容映射：单次结果 → patch（不含 C 连续计数）。
 * 层1 实际写盘请用 mapLayer1ProbeResultToHealthPatch / maybeProbeAccount。
 */
export function mapProbeResultToHealthPatch(
  result: ProbeOnceResult,
  now: number = Date.now(),
): DouyinAccountHealthPatch {
  if (!isProbeOnceFail(result)) {
    return {
      healthStatus: "healthy",
      healthCheckedAt: now,
      healthReason: "probe ok",
    };
  }
  if (result.class === "auth_failed") {
    return {
      healthStatus: "invalid",
      healthCheckedAt: now,
      healthReason: result.reason ?? "auth_failed",
    };
  }
  return {
    healthReason: result.reason ?? result.class,
  };
}

/**
 * 层1：probeOnce 结果走 C 阶梯（2×auth_failed→invalid，3×→relogin_required）。
 * 与探针 A markAuthFailure 计数隔离；均不改 enabled。
 */
export function mapLayer1ProbeResultToHealthPatch(
  result: ProbeOnceResult,
  accountId: string,
  now: number = Date.now(),
  authCounter: ProbeCAuthCounter = getDefaultProbeCAuthCounter(),
): ProbeCMapResult {
  const mapped = mapProbeCResultToHealthPatch(
    result,
    authCounter.getState(accountId),
    now,
  );
  authCounter.setState(accountId, mapped.nextCount);
  return mapped;
}

export type MaybeProbeSkipReason =
  | "no_probe_fn"
  | "should_not_probe"
  | "rate_limited"
  | "no_cookie"
  | "no_id"
  | "quarantined";

export type MaybeProbeResult =
  | { kind: "skipped"; reason: MaybeProbeSkipReason }
  | {
      kind: "probed";
      result: ProbeOnceResult;
      patch: DouyinAccountHealthPatch;
      escalated?: ProbeCEscalation;
    };

export type MaybeProbeAccountInput = {
  account: DouyinCookieAccountLike;
  accounts?: DouyinCookieAccountLike[] | null;
  now?: number;
  force?: boolean;
  probe?: DouyinProbeOnceFn;
  schedulePatch?: HealthPatchScheduler;
  authCounter?: ProbeCAuthCounter;
};

export async function maybeProbeAccount(
  input: MaybeProbeAccountInput,
): Promise<MaybeProbeResult> {
  const account = input.account;
  const accountId = account.id?.trim();
  if (!accountId) return { kind: "skipped", reason: "no_id" };

  const cookie = account.cookie?.trim();
  if (!cookie) return { kind: "skipped", reason: "no_cookie" };

  if (!input.force && isQuarantinedAccount(account)) {
    return { kind: "skipped", reason: "quarantined" };
  }

  const now = input.now ?? Date.now();
  if (!input.force && !shouldProbeAccount(account, now)) {
    return { kind: "skipped", reason: "should_not_probe" };
  }

  if (
    !input.force &&
    lastProbeStartedAt > 0 &&
    now - lastProbeStartedAt < MIN_PROBE_INTERVAL_MS
  ) {
    return { kind: "skipped", reason: "rate_limited" };
  }

  const probe = input.probe ?? probeOnceFn;
  if (!probe) return { kind: "skipped", reason: "no_probe_fn" };

  lastProbeStartedAt = now;
  const result = await probe(cookie);
  const mapped = mapLayer1ProbeResultToHealthPatch(
    result,
    accountId,
    now,
    input.authCounter ?? getDefaultProbeCAuthCounter(),
  );
  const patch = mapped.patch;

  if (Array.isArray(input.accounts)) {
    const idx = input.accounts.findIndex((a) => a?.id === accountId);
    if (idx >= 0) {
      input.accounts[idx] = applyHealthPatch(input.accounts[idx], patch);
    }
  } else {
    Object.assign(account, applyHealthPatch(account, patch));
  }

  const schedule = input.schedulePatch ?? getHealthPatchScheduler();
  schedule?.({ accountId, patch });

  return { kind: "probed", result, patch, escalated: mapped.escalated };
}

export type ProbeAccountsNeedingCheckInput = {
  accounts: DouyinCookieAccountLike[] | null | undefined;
  now?: number;
  probe?: DouyinProbeOnceFn;
  schedulePatch?: HealthPatchScheduler;
};

/** 调度前：need-probe 账号限流探测，本批最多一个实际 probe */
export async function probeAccountsNeedingCheck(
  input: ProbeAccountsNeedingCheckInput,
): Promise<MaybeProbeResult[]> {
  const accounts = input.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return [];

  const now = input.now ?? Date.now();
  const out: MaybeProbeResult[] = [];

  for (const account of accounts) {
    if (!account || account.enabled === false) continue;
    if (!account.cookie?.trim()) continue;
    if (isQuarantinedAccount(account)) continue;
    if (!shouldProbeAccount(account, now)) continue;

    const result = await maybeProbeAccount({
      account,
      accounts,
      now,
      probe: input.probe,
      schedulePatch: input.schedulePatch,
    });
    out.push(result);
    if (result.kind === "probed" || result.reason === "rate_limited") {
      break;
    }
  }
  return out;
}
