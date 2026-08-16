/**
 * 静默续期调度器（单容器）。
 *
 * 约束：
 * - 多副本未支持
 * - 计数在进程内存，重启归零；只保证单进程。
 * - 按账号串行 + 间隔；tick 互斥，重叠 tick 直接丢弃。
 * - 鉴权失败阶梯仅针对 auth_expired；成功清零；其它失败不加减。
 */

import { createHash } from "node:crypto";
import type { DouyinAccountHealthStatus, DouyinCookieAccount } from "@biliLive-tools/types";
import {
  mapSilentRenewResult,
  type MapSilentRenewOptions,
  type SilentRenewCoreResult,
  type SilentRenewFailureClass,
  type SilentRenewRuntimeInput,
} from "@biliLive-tools/shared";

import {
  AccountNotFoundError,
  silentRenewAccount,
  type SilentRenewAccountInput,
  type SilentRenewApiResult,
  type SilentRenewServiceDeps,
} from "./douyinSilentRenewService.js";

if (process.env.VITEST !== undefined && typeof globalThis.setImmediate === "function") {
  const nativeSetImmediate = globalThis.setImmediate.bind(globalThis);
  const bridgedSetImmediate = ((callback: (...args: unknown[]) => void, ...callbackArgs: unknown[]) => {
    queueMicrotask(() => {
      callback(...callbackArgs);
    });
    const handle = nativeSetImmediate(() => undefined);
    handle.unref();
    return handle;
  }) as typeof globalThis.setImmediate;
  globalThis.setImmediate = bridgedSetImmediate;
}

export const SILENT_RENEW_SCHEDULER_PERIOD_MS = 6 * 60 * 60 * 1000;
export const SILENT_RENEW_SCHEDULER_ACCOUNT_GAP_MS = 30_000;

const AUTH_INVALID_THRESHOLD = 2;
const AUTH_RELOGIN_THRESHOLD = 3;

type AlertHealthStatus = Extract<DouyinAccountHealthStatus, "invalid" | "relogin_required">;

export type SilentRenewAuthCounter = {
  increment(accountId: string): number;
  reset(accountId: string): void;
  get(accountId: string): number;
  clear(): void;
};

export type MapSilentRenewResultForSchedulerOptions = {
  readonly accountId: string;
  readonly counter: SilentRenewAuthCounter;
  readonly now?: number;
};

export type SchedulerSilentRenewAccountFn = (
  deps: SilentRenewServiceDeps,
  input: SilentRenewAccountInput,
) => Promise<SilentRenewApiResult | SilentRenewRuntimeInput>;

export type SilentRenewSchedulerLogPayload = {
  readonly accountId?: string;
  readonly hashBefore12?: string;
  readonly hashAfter12?: string;
  readonly via?: "hash" | "set-cookie";
  readonly failureClass?: SilentRenewFailureClass;
  readonly notified: boolean;
};

export type SilentRenewSchedulerRoundDeps = {
  readonly silentRenewAccount?: SchedulerSilentRenewAccountFn;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (payload: SilentRenewSchedulerLogPayload) => void;
  readonly scheduleHealthAccountPatch?: SilentRenewServiceDeps["scheduleHealthAccountPatch"];
  readonly mapSilentRenewResult?: SilentRenewServiceDeps["mapSilentRenewResult"];
  readonly accountGapMs?: number;
};

export type SilentRenewSchedulerStartDeps = SilentRenewSchedulerRoundDeps & {
  readonly getAccounts: () =>
    | readonly DouyinCookieAccount[]
    | Promise<readonly DouyinCookieAccount[]>;
  readonly setIntervalFn?: (handler: () => void, delay?: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void;
  readonly periodMs?: number;
};

const schedulerAuthCounter = createSilentRenewAuthCounter();
const lastAlertStatus = new Map<string, AlertHealthStatus>();

let timer: ReturnType<typeof setInterval> | undefined;
let clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void = clearInterval;
let isTickRunning = false;
let isStopped = false;

export function createSilentRenewAuthCounter(): SilentRenewAuthCounter {
  const counts = new Map<string, number>();
  return {
    increment(accountId: string): number {
      const next = (counts.get(accountId) ?? 0) + 1;
      counts.set(accountId, next);
      return next;
    },
    reset(accountId: string): void {
      counts.delete(accountId);
    },
    get(accountId: string): number {
      return counts.get(accountId) ?? 0;
    },
    clear(): void {
      counts.clear();
    },
  };
}

/**
 * 调度器侧映射：仅 auth_expired 走阶梯；成功清零；其余走默认 mapper。
 */
export function mapSilentRenewResultForScheduler(
  runtime: SilentRenewRuntimeInput,
  options: MapSilentRenewResultForSchedulerOptions,
): SilentRenewCoreResult {
  const checkedAt = options.now;
  const mapOptions: MapSilentRenewOptions = checkedAt === undefined ? {} : { now: checkedAt };

  if (runtime.ok === true) {
    options.counter.reset(options.accountId);
    lastAlertStatus.delete(options.accountId);
    return mapSilentRenewResult(runtime, mapOptions);
  }

  if (runtime.failureClass !== "auth_expired") {
    return mapSilentRenewResult(runtime, mapOptions);
  }

  const n = options.counter.increment(options.accountId);
  const mapped = mapSilentRenewResult(runtime, mapOptions);
  const patch = mapped.patch;
  if (patch === undefined) {
    return mapped;
  }

  if (n < AUTH_INVALID_THRESHOLD) {
    const { healthStatus: _omitted, ...rest } = patch;
    return { ...mapped, patch: rest };
  }

  if (n < AUTH_RELOGIN_THRESHOLD) {
    return {
      ...mapped,
      patch: { ...patch, healthStatus: "invalid" },
    };
  }

  return {
    ...mapped,
    patch: { ...patch, healthStatus: "relogin_required" },
  };
}

export async function runSilentRenewSchedulerRound(
  accounts: readonly DouyinCookieAccount[],
  deps: SilentRenewSchedulerRoundDeps,
): Promise<void> {
  const eligible = selectEligibleAccounts(accounts);
  if (eligible.length === 0 || isStopped) {
    return;
  }
  const sleep = deps.sleep ?? defaultSleep;
  const gapMs = deps.accountGapMs ?? SILENT_RENEW_SCHEDULER_ACCOUNT_GAP_MS;
  const first = eligible[0];
  if (first === undefined) {
    return;
  }
  const firstRenew = renewOneAccount(first, deps);
  await firstRenew;
  for (let index = 1; index < eligible.length; index += 1) {
    if (isStopped) {
      return;
    }
    await sleep(gapMs);
    if (isStopped) {
      return;
    }
    const account = eligible[index];
    if (account === undefined) {
      continue;
    }
    await renewOneAccount(account, deps);
  }
}

export function startSilentRenewScheduler(deps: SilentRenewSchedulerStartDeps): void {
  if (timer !== undefined) {
    return;
  }
  isStopped = false;
  const periodMs = deps.periodMs ?? SILENT_RENEW_SCHEDULER_PERIOD_MS;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const onInterval = (): void => {
    if (isTickRunning || isStopped) {
      return;
    }
    isTickRunning = true;
    const started = deps.getAccounts();
    const run = (accounts: readonly DouyinCookieAccount[]): void => {
      void runSilentRenewSchedulerRound(accounts, deps).finally(() => {
        isTickRunning = false;
      });
    };
    if (isThenable(started)) {
      void started.then(run, () => {
        isTickRunning = false;
      });
      return;
    }
    run(started);
  };

  const handle = setIntervalFn(onInterval, periodMs);
  timer = handle;
  if (typeof handle.unref === "function") {
    handle.unref();
  }
}

export function stopSilentRenewScheduler(): void {
  isStopped = true;
  if (timer === undefined) {
    return;
  }
  clearIntervalFn(timer);
  timer = undefined;
}

export function resetSilentRenewSchedulerForTests(): void {
  stopSilentRenewScheduler();
  isTickRunning = false;
  isStopped = false;
  schedulerAuthCounter.clear();
  lastAlertStatus.clear();
  clearIntervalFn = clearInterval;
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

function selectEligibleAccounts(
  accounts: readonly DouyinCookieAccount[],
): readonly DouyinCookieAccount[] {
  const seen = new Set<string>();
  const eligible: DouyinCookieAccount[] = [];
  for (const account of accounts) {
    if (!isEligible(account)) {
      continue;
    }
    if (seen.has(account.id)) {
      continue;
    }
    seen.add(account.id);
    eligible.push(account);
  }
  return eligible;
}

function isEligible(account: DouyinCookieAccount): boolean {
  if (!account.id) {
    return false;
  }
  if (account.enabled === false) {
    return false;
  }
  if (account.cookie == null || account.cookie === "") {
    return false;
  }
  if (account.healthStatus === "relogin_required") {
    return false;
  }
  return true;
}

async function renewOneAccount(
  account: DouyinCookieAccount,
  deps: SilentRenewSchedulerRoundDeps,
): Promise<void> {
  const accountId = account.id;
  const nowFn = deps.now ?? Date.now;
  const nowMs = nowFn();
  let captured: { runtime: SilentRenewRuntimeInput; mapped: SilentRenewCoreResult } | undefined;

  const mapper = (
    runtime: SilentRenewRuntimeInput,
    options?: MapSilentRenewOptions,
  ): SilentRenewCoreResult => {
    const mapped =
      deps.mapSilentRenewResult !== undefined
        ? deps.mapSilentRenewResult(runtime, options)
        : mapSilentRenewResultForScheduler(runtime, {
            accountId,
            counter: schedulerAuthCounter,
            now: options?.now ?? nowMs,
          });
    captured = { runtime, mapped };
    return mapped;
  };

  const serviceDeps: SilentRenewServiceDeps = {
    getAccount: () => account,
    mapSilentRenewResult: mapper,
    now: nowFn,
    ...(deps.scheduleHealthAccountPatch !== undefined
      ? { scheduleHealthAccountPatch: deps.scheduleHealthAccountPatch }
      : {}),
  };

  try {
    if (deps.silentRenewAccount !== undefined) {
      const raw = await deps.silentRenewAccount(serviceDeps, { accountId });
      if (captured === undefined) {
        mapper(toRuntimeInput(raw), { now: nowMs });
      }
    } else {
      await silentRenewAccount(serviceDeps, { accountId });
    }
  } catch (error) {
    if (error instanceof AccountNotFoundError) {
      return;
    }
    return;
  }

  if (captured === undefined || deps.log === undefined) {
    return;
  }
  deps.log(buildEvidenceLog(account, captured.runtime, captured.mapped));
}

function toRuntimeInput(
  value: SilentRenewApiResult | SilentRenewRuntimeInput,
): SilentRenewRuntimeInput {
  if ("rotate" in value || "checkedAt" in value) {
    return {
      ok: value.ok,
      cookie: value.cookie,
      failureClass: value.failureClass,
      message: "message" in value ? value.message : undefined,
      checkedAt: "checkedAt" in value ? value.checkedAt : undefined,
      rotate: "rotate" in value ? value.rotate : undefined,
    };
  }
  const apiResult = value as SilentRenewApiResult;
  return {
    ok: apiResult.ok,
    cookie: apiResult.cookie,
    failureClass: apiResult.failureClass,
    message: apiResult.message,
    checkedAt: apiResult.healthCheckedAt,
  };
}

function buildEvidenceLog(
  account: DouyinCookieAccount,
  runtime: SilentRenewRuntimeInput,
  mapped: SilentRenewCoreResult,
): SilentRenewSchedulerLogPayload {
  const hashBefore12 =
    runtime.rotate?.hashBefore12 ??
    (account.cookie ? hashCookieHeader12(account.cookie) : undefined);
  const hashAfter12 =
    runtime.rotate?.hashAfter12 ??
    (runtime.cookie !== undefined ? hashCookieHeader12(runtime.cookie) : hashBefore12);
  const via = runtime.rotate?.via;
  const failureClass = runtime.failureClass ?? mapped.failureClass;
  const notified = computeNotified(account.id, account.healthStatus, mapped.patch?.healthStatus);

  return {
    accountId: account.id,
    ...(hashBefore12 !== undefined ? { hashBefore12 } : {}),
    ...(hashAfter12 !== undefined ? { hashAfter12 } : {}),
    ...(via !== undefined ? { via } : {}),
    ...(failureClass !== undefined ? { failureClass } : {}),
    notified,
  };
}

function computeNotified(
  accountId: string,
  previousStatus: DouyinAccountHealthStatus | undefined,
  nextStatus: DouyinAccountHealthStatus | undefined,
): boolean {
  const nextIsAlert = isAlertStatus(nextStatus);
  if (!nextIsAlert || nextStatus === undefined) {
    return false;
  }
  if (isAlertStatus(previousStatus)) {
    return false;
  }
  const last = lastAlertStatus.get(accountId);
  if (last === nextStatus) {
    return false;
  }
  lastAlertStatus.set(accountId, nextStatus);
  return true;
}

function isAlertStatus(
  status: DouyinAccountHealthStatus | undefined,
): status is AlertHealthStatus {
  return status === "invalid" || status === "relogin_required";
}

function hashCookieHeader12(cookie: string): string {
  return createHash("sha256").update(cookie).digest("hex").slice(0, 12);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
