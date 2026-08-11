import { get } from "lodash-es";
import type { DouyinCookieAccount } from "@biliLive-tools/types";

import log from "./utils/log.js";
import {
  applyHealthPatch,
  isQuarantinedAccount,
  type DouyinAccountHealthPatch,
} from "./douyinAccountHealth.js";

/** 健康字段写盘防抖窗口（ms） */
export var DEBOUNCE_MS = 500;

/** AppConfig 内抖音账号池默认路径 */
export var DEFAULT_ACCOUNTS_PATH = "recorder.douyin.accounts";

import { send } from "./notify.js";

export type HealthPersistHost = {
  /** 返回可就地 mutate 的配置根对象（通常为 AppConfig.data） */
  getData: () => Record<string, unknown> | null | undefined;
  /** 立即同步写盘（best-effort 由本模块捕获） */
  save: () => void;
};

export type ScheduleHealthAccountPatchInput = {
  accountId: string;
  patch: DouyinAccountHealthPatch;
  /** 覆盖默认 accounts 挂载路径 */
  accountsPath?: string;
  /** 可选注入 notification 发送逻辑（默认为 shared/notify 的 send） */
  notifyFn?: (title: string, desp: string) => Promise<any> | void;
};

var host: HealthPersistHost | null = null;
var timer: ReturnType<typeof setTimeout> | null = null;
var dirty = false;
const quarantinedAccountIds = new Set<string>();

/**
 * 绑定写盘宿主（通常为 AppConfig 实例）。
 * 未绑定前 schedule 只做内存 merge 的 no-op save 路径。
 */
export function bindHealthPersistHost(next: HealthPersistHost | null): void {
  host = next;
  initQuarantinedAccountsFromHost();
}

/**
 * 初始化已处于隔离区 (invalid/relogin_required) 的账号集合，防止重启时重复发通知。
 */
export function initQuarantinedAccountsFromHost(): void {
  if (!host) return;
  const accounts = getAccountsArray(DEFAULT_ACCOUNTS_PATH);
  if (!Array.isArray(accounts)) return;
  for (const acc of accounts) {
    if (acc?.id && isQuarantinedAccount(acc)) {
      quarantinedAccountIds.add(acc.id);
    }
  }
}

function clearTimer(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function getAccountsArray(accountsPath: string): DouyinCookieAccount[] | null {
  if (!host) return null;
  const data = host.getData();
  if (data == null) return null;
  const accounts = get(data, accountsPath);
  if (!Array.isArray(accounts)) return null;
  return accounts as DouyinCookieAccount[];
}

/**
 * 校验并触发账号健康离线/失效边沿通知。
 * - 边沿进入 invalid 或 relogin_required 时发送通知
 * - 连续 invalid 不重复发送 (防抖去重)
 * - 正文包含账号 remark/id 摘要与 reason，严禁包含 cookie
 * - 恢复为 healthy/expiring/unknown 时解除 quarantine 跟踪
 */
export function checkAndNotifyHealthEdge(
  account: DouyinCookieAccount,
  patch: DouyinAccountHealthPatch,
  notifyFn: (title: string, desp: string) => Promise<any> | void = (title, desp) => send(title, desp),
): boolean {
  const accountId = account.id?.trim();
  if (!accountId) return false;

  const targetStatus = patch.healthStatus;
  if (!targetStatus) return false;

  const isPatchQuarantined = targetStatus === "invalid" || targetStatus === "relogin_required";

  if (isPatchQuarantined) {
    if (quarantinedAccountIds.has(accountId)) {
      return false;
    }

    quarantinedAccountIds.add(accountId);

    const remark = account.remark?.trim();
    const remarkOrId = remark ? `${remark} (${accountId})` : accountId;
    const statusText = targetStatus === "relogin_required" ? "需要重新登录" : "授权失效";
    const reasonText = patch.healthReason ?? account.healthReason ?? "鉴权失败";

    const title = `[抖音账号] 账号${statusText}`;
    const desp = `账号 ${remarkOrId} 状态变更为 ${targetStatus} (${statusText})，原因：${reasonText}。`;

    try {
      const res = notifyFn(title, desp);
      if (res && typeof (res as Promise<any>).catch === "function") {
        (res as Promise<any>).catch((err: unknown) => {
          log.error("health edge notify error", err);
        });
      }
    } catch (err) {
      log.error("health edge notify error", err);
    }
    return true;
  } else {
    quarantinedAccountIds.delete(accountId);
    return false;
  }
}

/**
 * 立即将脏健康字段写盘；无脏标记时为 no-op。
 * 用户显式全量 Save 前应调用以 flush 待写健康 debounce。
 */
export function flushHealthPersist(): void {
  clearTimer();
  if (!dirty) return;
  if (!host) {
    dirty = false;
    return;
  }
  try {
    host.save();
  } catch (err) {
    // best-effort：磁盘失败不抛，内存状态保留
    log.error("douyin health persist save failed", err);
  } finally {
    dirty = false;
  }
}

function scheduleSave(): void {
  dirty = true;
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    flushHealthPersist();
  }, DEBOUNCE_MS);
}

/**
 * 合并健康 patch 到内存账号池，并 500ms debounce 写盘。
 * - 边沿检测：进入 invalid / relogin_required 时发通知并去重
 * - 立即 mutate 内存 accounts（applyHealthPatch：默认不改 updatedAt/cookie）
 * - 窗口内多次调用 coalesce 为一次 save
 * - 不打印 cookie
 */
export function scheduleHealthAccountPatch(input: ScheduleHealthAccountPatchInput): void {
  const accountsPath = input.accountsPath ?? DEFAULT_ACCOUNTS_PATH;
  const accounts = getAccountsArray(accountsPath);
  if (accounts == null) return;

  const idx = accounts.findIndex((a) => a?.id === input.accountId);
  if (idx < 0) return;

  const targetAccount = accounts[idx];
  const notifyFn = input.notifyFn ?? send;

  checkAndNotifyHealthEdge(targetAccount, input.patch, notifyFn);

  accounts[idx] = applyHealthPatch(accounts[idx], input.patch);
  scheduleSave();
}

/** 测试用：清空宿主、定时器、脏标记与隔离区追踪 */
export function resetHealthPersistForTests(): void {
  clearTimer();
  dirty = false;
  host = null;
  quarantinedAccountIds.clear();
}
