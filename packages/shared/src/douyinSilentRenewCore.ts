import type { DouyinAccountHealthPatch } from "./douyinAccountHealth.js";

/** 账号 pool 展示及更新使用；月日不补零，时分补零，如 2026.8.5 00:00 */
export function formatDouyinAccountUpdatedAt(date: Date = new Date()): string {
  const d = date ?? new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  return `${year}.${month}.${day} ${hour}:${minute}`;
}

/**
 * 静默续期失败分类（runtime 侧错误归类，非 Schema B 健康态）。
 * Schema B 五态仍只通过 DouyinAccountHealthPatch.healthStatus 表达。
 */
export type SilentRenewFailureClass =
  | "auth_expired"
  | "engine_unavailable"
  | "lock_busy"
  | "profile_error"
  | "network_timeout"
  | "not_rotated"
  | "identity_mismatch"
  | "unknown";

export type SilentRenewRotateEvidence = {
  via: "hash" | "set-cookie";
  hashBefore12: string;
  hashAfter12: string;
  setCookieCaptured: boolean;
};

/** runtime 执行静默续期后的输入（纯映射，无 I/O） */
export type SilentRenewRuntimeInput = {
  ok: boolean;
  /** 成功时可选写入的 cookie；失败默认不传（不强制清空） */
  cookie?: string;
  failureClass?: SilentRenewFailureClass;
  message?: string;
  /** 健康检查时间戳；缺省由 options.now 填充 */
  checkedAt?: number;
  rotate?: SilentRenewRotateEvidence;
};

export type SilentRenewCoreResult = {
  ok: boolean;
  failureClass?: SilentRenewFailureClass;
  message: string;
  /** 可直接交给 applyHealthPatch */
  patch?: DouyinAccountHealthPatch;
};

export type MapSilentRenewOptions = {
  now?: number;
};

const DEFAULT_MESSAGES: Record<SilentRenewFailureClass, string> = {
  auth_expired: "silent renew: auth expired",
  engine_unavailable: "silent renew: engine unavailable",
  lock_busy: "silent renew: profile lock busy",
  profile_error: "silent renew: profile error",
  network_timeout: "silent renew: network timeout",
  not_rotated: "silent renew: cookie not rotated",
  identity_mismatch: "账号重登失败：登录身份与账号不一致",
  unknown: "silent renew: unknown error",
};

const SUCCESS_DEFAULT_MESSAGE = "silent renew: ok";

function resolveMessage(
  input: SilentRenewRuntimeInput,
  failureClass: SilentRenewFailureClass | undefined,
): string {
  if (input.message != null && input.message.length > 0) return input.message;
  if (input.ok) return SUCCESS_DEFAULT_MESSAGE;
  if (failureClass != null) return DEFAULT_MESSAGES[failureClass];
  return DEFAULT_MESSAGES.unknown;
}

/**
 * 将 silent renew runtime 结果映射为 Schema B 健康 patch。
 *
 * 语义：
 * - 成功必须带 rotate.via（"hash" | "set-cookie"）→ healthy + healthCheckedAt + updatedAt（+ 可选 cookie / healthReason）
 * - ok 但无 rotate.via 证据 → 强制 not_rotated（不写 updatedAt / cookie / healthStatus）
 * - auth_expired → relogin_required；默认不清 cookie
 * - identity_mismatch → invalid；不写 cookie / updatedAt（空 uid 同 class）
 * - engine_unavailable / lock_busy / network_timeout → 不 force invalid；不写 healthStatus
 * - profile_error / unknown → 同样不 force invalid
 */
export function mapSilentRenewResult(
  input: SilentRenewRuntimeInput,
  options: MapSilentRenewOptions = {},
): SilentRenewCoreResult {
  const checkedAt = input.checkedAt ?? options.now ?? Date.now();

  if (input.ok) {
    const via = input.rotate?.via;
    if (via !== "hash" && via !== "set-cookie") {
      const message =
        input.message != null && input.message.length > 0
          ? input.message
          : DEFAULT_MESSAGES.not_rotated;
      return {
        ok: false,
        failureClass: "not_rotated",
        message,
        patch: {
          healthCheckedAt: checkedAt,
          healthReason: message,
        },
      };
    }

    const message = resolveMessage(input, undefined);
    const patch: DouyinAccountHealthPatch = {
      healthStatus: "healthy",
      healthCheckedAt: checkedAt,
      healthReason: message,
      updatedAt: formatDouyinAccountUpdatedAt(new Date(checkedAt)),
    };
    if (input.cookie !== undefined) {
      patch.cookie = input.cookie;
    }
    return { ok: true, message, patch };
  }

  const failureClass: SilentRenewFailureClass = input.failureClass ?? "unknown";
  const message = resolveMessage(input, failureClass);

  const patch: DouyinAccountHealthPatch = {
    healthCheckedAt: checkedAt,
    healthReason: message,
  };

  // 仅鉴权过期 / 身份不一致强制切换 Schema B 态；其余失败不降级 invalid、不强制改 status
  if (failureClass === "auth_expired") {
    patch.healthStatus = "relogin_required";
  } else if (failureClass === "identity_mismatch") {
    patch.healthStatus = "invalid";
  }

  return {
    ok: false,
    failureClass,
    message,
    patch,
  };
}
