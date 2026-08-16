/**
 * 探针 C 层2 空闲巡检调度（§5.3.1）。
 * 依赖 probeC 升级阶梯；写盘经注入 schedulePatch；不静态依赖 http/shared。
 */
import {
  applyHealthPatch,
  getHealthPatchScheduler,
  isQuarantinedAccount,
  normalizeHealthStatus,
  type DouyinCookieAccountLike,
  type HealthPatchScheduler,
} from "./cookieAccountSelection.js";
import { CHECK_WINDOW_MS, isPastCheckWindow } from "./probeB.js";
import {
  PROBE_C_ACCOUNT_GAP_MS,
  PROBE_C_IDLE_INTERVAL_MS,
  clearDefaultProbeCAuthCounter,
  getDefaultProbeCAuthCounter,
  mapProbeCResultToHealthPatch,
  type DouyinAccountHealthPatch,
  type DouyinProbeOnceFn,
  type ProbeCAuthCounter,
  type ProbeCEscalation,
  type ProbeOnceResult,
} from "./probeCCore.js";

export { CHECK_WINDOW_MS } from "./probeB.js";
export {
  PROBE_C_ACCOUNT_GAP_MS,
  PROBE_C_IDLE_INTERVAL_MS,
  getDefaultProbeCAuthCounter,
} from "./probeCCore.js";

export type ProbeCIdleSkipReason =
  | "no_probe_fn"
  | "no_id"
  | "no_cookie"
  | "disabled"
  | "quarantined"
  | "within_window"
  | "stopped";

export type ProbeCIdleRoundItem =
  | { kind: "skipped"; accountId?: string; reason: ProbeCIdleSkipReason }
  | {
      kind: "probed";
      accountId: string;
      result: ProbeOnceResult;
      patch: DouyinAccountHealthPatch;
      escalated?: ProbeCEscalation;
    };

export type ProbeCSleepFn = (ms: number) => Promise<void>;

export type RunProbeCIdleRoundOpts = {
  now?: number;
  probeOnce?: DouyinProbeOnceFn | null;
  schedulePatch?: HealthPatchScheduler | null;
  sleep?: ProbeCSleepFn;
  accountGapMs?: number;
  checkWindowMs?: number;
  authCounter?: ProbeCAuthCounter;
  isStopped?: () => boolean;
};

export type StartProbeCIdlePatrolOpts = {
  now?: number | (() => number);
  probeOnce?: DouyinProbeOnceFn | null;
  schedulePatch?: HealthPatchScheduler | null;
  sleep?: ProbeCSleepFn;
  accountGapMs?: number;
  idleIntervalMs?: number;
  checkWindowMs?: number;
  authCounter?: ProbeCAuthCounter;
  runImmediately?: boolean;
  /** 默认 true（Wave4 再接正式配置键）；false 时 start 为 no-op */
  enabled?: boolean;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export type ResetProbeCStateOptions = {
  clearProbeFn?: boolean;
  authCounter?: ProbeCAuthCounter;
  clearAccountsGetter?: boolean;
  resetEnabled?: boolean;
};

export type WireProbeCHostOpts = {
  /** 注入 probeOnce；null 清空 */
  probeOnce?: DouyinProbeOnceFn | null;
  /** 账号列表读取；缺省则用已绑定 getter */
  getAccounts?: () => readonly DouyinCookieAccountLike[] | null | undefined;
  /** 默认 true */
  enabled?: boolean;
  /** 透传 start 选项（不含 getAccounts） */
  patrolOpts?: Omit<StartProbeCIdlePatrolOpts, "enabled" | "probeOnce">;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let probeOnceFn: DouyinProbeOnceFn | null = null;
let patrolTimer: ReturnType<typeof setInterval> | null = null;
let patrolClearInterval: typeof clearInterval = clearInterval;
let patrolStopped = true;
let patrolRunning = false;
/** Wave4 前硬默认 ON；可通过 setProbeCIdlePatrolEnabled 关闭 */
let idlePatrolEnabled = true;
let accountsGetter:
  | (() => readonly DouyinCookieAccountLike[] | null | undefined)
  | null = null;

export function setDouyinProbeCOnce(fn: DouyinProbeOnceFn | null): void {
  probeOnceFn = fn;
}

export function setProbeCIdlePatrolEnabled(enabled: boolean): void {
  idlePatrolEnabled = enabled;
  if (!enabled) {
    stopProbeCIdlePatrol();
  }
}

export function isProbeCIdlePatrolEnabled(): boolean {
  return idlePatrolEnabled;
}

export function isProbeCIdlePatrolRunning(): boolean {
  return patrolRunning;
}

/** 绑定账号列表读取（host 启动时注入 AppConfig.recorder.douyin.accounts） */
export function setProbeCAccountsGetter(
  getAccounts:
    | (() => readonly DouyinCookieAccountLike[] | null | undefined)
    | null,
): void {
  accountsGetter = getAccounts;
}

export function getProbeCAccountsGetter():
  | (() => readonly DouyinCookieAccountLike[] | null | undefined)
  | null {
  return accountsGetter;
}

export function shouldProbeCIdleAccount(
  account: Pick<
    DouyinCookieAccountLike,
    "enabled" | "healthStatus" | "healthCheckedAt"
  >,
  now: number = Date.now(),
  windowMs: number = CHECK_WINDOW_MS,
): boolean {
  if (account.enabled === false) return false;
  if (isQuarantinedAccount(account)) return false;
  if (normalizeHealthStatus(account) === "unknown") return true;
  return isPastCheckWindow(account.healthCheckedAt, now, windowMs);
}

export async function runProbeCIdleRound(
  accounts: readonly DouyinCookieAccountLike[] | null | undefined,
  opts: RunProbeCIdleRoundOpts = {},
): Promise<ProbeCIdleRoundItem[]> {
  const list = accounts ?? [];
  const now = opts.now ?? Date.now();
  const sleep = opts.sleep ?? defaultSleep;
  const gapMs = opts.accountGapMs ?? PROBE_C_ACCOUNT_GAP_MS;
  const windowMs = opts.checkWindowMs ?? CHECK_WINDOW_MS;
  const counter = opts.authCounter ?? getDefaultProbeCAuthCounter();
  const probe = opts.probeOnce !== undefined ? opts.probeOnce : probeOnceFn;
  const schedule =
    opts.schedulePatch !== undefined
      ? opts.schedulePatch
      : getHealthPatchScheduler();
  const out: ProbeCIdleRoundItem[] = [];
  let probedCount = 0;

  for (const account of list) {
    if (opts.isStopped?.()) {
      out.push({ kind: "skipped", reason: "stopped" });
      break;
    }

    const accountId = account?.id?.trim();
    if (!accountId) {
      out.push({ kind: "skipped", reason: "no_id" });
      continue;
    }

    if (account.enabled === false) {
      out.push({ kind: "skipped", accountId, reason: "disabled" });
      continue;
    }

    if (isQuarantinedAccount(account)) {
      out.push({ kind: "skipped", accountId, reason: "quarantined" });
      continue;
    }

    if (!shouldProbeCIdleAccount(account, now, windowMs)) {
      out.push({ kind: "skipped", accountId, reason: "within_window" });
      continue;
    }

    const cookie = account.cookie?.trim();
    if (!cookie) {
      out.push({ kind: "skipped", accountId, reason: "no_cookie" });
      continue;
    }

    if (!probe) {
      out.push({ kind: "skipped", accountId, reason: "no_probe_fn" });
      continue;
    }

    if (probedCount > 0 && gapMs > 0) {
      await sleep(gapMs);
      if (opts.isStopped?.()) {
        out.push({ kind: "skipped", accountId, reason: "stopped" });
        break;
      }
    }

    const result = await probe(cookie);
    const mapped = mapProbeCResultToHealthPatch(
      result,
      counter.getState(accountId),
      now,
    );
    counter.setState(accountId, mapped.nextCount);

    Object.assign(account, applyHealthPatch(account, mapped.patch));
    schedule?.({ accountId, patch: mapped.patch });
    probedCount += 1;
    out.push({
      kind: "probed",
      accountId,
      result,
      patch: mapped.patch,
      escalated: mapped.escalated,
    });
  }

  return out;
}

export function startProbeCIdlePatrol(
  getAccounts: () => readonly DouyinCookieAccountLike[] | null | undefined,
  opts: StartProbeCIdlePatrolOpts = {},
): void {
  stopProbeCIdlePatrol();

  if (opts.enabled === false || !idlePatrolEnabled) {
    return;
  }

  accountsGetter = getAccounts;

  const idleIntervalMs = opts.idleIntervalMs ?? PROBE_C_IDLE_INTERVAL_MS;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const runImmediately = opts.runImmediately !== false;
  patrolStopped = false;
  patrolClearInterval = clearIntervalFn;

  const resolveNow = (): number => {
    if (typeof opts.now === "function") return opts.now();
    if (typeof opts.now === "number") return opts.now;
    return Date.now();
  };

  const tick = (): void => {
    if (patrolStopped || patrolRunning || !idlePatrolEnabled) return;
    patrolRunning = true;
    void runProbeCIdleRound(getAccounts(), {
      now: resolveNow(),
      probeOnce: opts.probeOnce,
      schedulePatch: opts.schedulePatch,
      sleep: opts.sleep,
      accountGapMs: opts.accountGapMs,
      checkWindowMs: opts.checkWindowMs,
      authCounter: opts.authCounter,
      isStopped: () => patrolStopped || !idlePatrolEnabled,
    }).finally(() => {
      patrolRunning = false;
    });
  };

  if (runImmediately) {
    tick();
  }

  patrolTimer = setIntervalFn(tick, idleIntervalMs);
  if (
    patrolTimer &&
    typeof patrolTimer === "object" &&
    "unref" in patrolTimer &&
    typeof (patrolTimer as { unref?: () => void }).unref === "function"
  ) {
    (patrolTimer as { unref: () => void }).unref();
  }
}

/**
 * Host wire 钩子：注入 probeOnce + 启动层2 空闲巡检（best-effort）。
 * getAccounts 缺失时仍注入 probe 并 no-op start（可后续 setProbeCAccountsGetter 再 start）。
 */
export function wireProbeCHost(opts: WireProbeCHostOpts = {}): {
  probeInjected: boolean;
  patrolStarted: boolean;
} {
  if (opts.enabled !== undefined) {
    setProbeCIdlePatrolEnabled(opts.enabled);
  }

  if (opts.probeOnce !== undefined) {
    setDouyinProbeCOnce(opts.probeOnce);
  }

  const getAccounts = opts.getAccounts ?? accountsGetter;
  if (opts.getAccounts) {
    setProbeCAccountsGetter(opts.getAccounts);
  }

  const enabled = opts.enabled !== false && idlePatrolEnabled;
  if (!enabled || !getAccounts) {
    return {
      probeInjected: opts.probeOnce !== undefined,
      patrolStarted: false,
    };
  }

  startProbeCIdlePatrol(getAccounts, {
    ...opts.patrolOpts,
    enabled: true,
    probeOnce: opts.probeOnce,
  });

  return {
    probeInjected: opts.probeOnce !== undefined,
    patrolStarted: true,
  };
}

export function stopProbeCIdlePatrol(): void {
  patrolStopped = true;
  if (patrolTimer != null) {
    patrolClearInterval(patrolTimer);
    patrolTimer = null;
  }
  patrolRunning = false;
}

export function resetProbeCStateForTests(
  options: ResetProbeCStateOptions = {},
): void {
  stopProbeCIdlePatrol();
  const counter = options.authCounter ?? getDefaultProbeCAuthCounter();
  if (typeof counter.clearAll === "function") {
    counter.clearAll();
  } else {
    clearDefaultProbeCAuthCounter();
  }
  if (options.clearProbeFn) {
    probeOnceFn = null;
  }
  if (options.clearAccountsGetter) {
    accountsGetter = null;
  }
  if (options.resetEnabled !== false) {
    idlePatrolEnabled = true;
  }
}
