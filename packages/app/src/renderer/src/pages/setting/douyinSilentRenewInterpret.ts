import type { DouyinAccountHealthStatus } from "@biliLive-tools/types";

const IDENTITY_MISMATCH_NOTICE = "账号重登失败：登录身份与账号不一致";

const SILENT_RENEW_FAILURE_CLASSES = [
  "auth_expired",
  "engine_unavailable",
  "lock_busy",
  "profile_error",
  "network_timeout",
  "not_rotated",
  "identity_mismatch",
  "unknown",
] as const;

type SilentRenewFailureClass = (typeof SILENT_RENEW_FAILURE_CLASSES)[number];

const assertNever = (value: never): never => {
  throw new Error(`Unexpected silent-renew failure class: ${String(value)}`);
};

export type DouyinSilentRenewUiDecision = {
  readonly openQr: boolean;
  readonly writeCookie: boolean;
  readonly writeUpdatedAt: boolean;
  readonly healthStatus?: DouyinAccountHealthStatus;
  readonly healthReason?: string;
  readonly notice: string;
  readonly message: string;
  readonly noticeLevel: "success" | "error" | "warning";
};

export type DouyinSilentRenewInterpretInput = {
  readonly ok: boolean;
  readonly message?: string;
  readonly healthStatus?: DouyinAccountHealthStatus;
  readonly failureClass?: SilentRenewFailureClass;
  readonly cookie?: string;
  readonly updatedAt?: string;
};

const authExpiredDecision = (
  message: string,
  healthStatus: DouyinAccountHealthStatus | undefined,
): DouyinSilentRenewUiDecision => {
  const reason = message || "登录已失效，需重新扫码";
  return {
    openQr: true,
    writeCookie: false,
    writeUpdatedAt: false,
    healthStatus: healthStatus ?? "relogin_required",
    healthReason: reason,
    notice: `账号重登失败：${message || "登录失效，需重新扫码"}`,
    message: reason,
    noticeLevel: "error",
  };
};

/** UI 解释器：identity_mismatch（含空 uid）必须先于 auth_expired，禁止自动弹码。 */
export const interpretDouyinSilentRenewResult = (
  res: DouyinSilentRenewInterpretInput,
): DouyinSilentRenewUiDecision => {
  const message = res.message ?? "";
  if (res.ok) {
    const notice = message || "账号重登成功：状态正常";
    return {
      openQr: false,
      writeCookie: true,
      writeUpdatedAt: true,
      healthStatus: res.healthStatus ?? "healthy",
      notice,
      message: notice,
      noticeLevel: "success",
    };
  }

  const failureClass: SilentRenewFailureClass = res.failureClass ?? "unknown";
  switch (failureClass) {
    case "identity_mismatch": {
      const notice = message || IDENTITY_MISMATCH_NOTICE;
      return {
        openQr: false,
        writeCookie: false,
        writeUpdatedAt: false,
        healthStatus: res.healthStatus ?? "invalid",
        healthReason: notice,
        notice,
        message: notice,
        noticeLevel: "error",
      };
    }
    case "not_rotated": {
      const reason = message || "未刷新 cookie";
      return {
        openQr: false,
        writeCookie: false,
        writeUpdatedAt: false,
        ...(res.healthStatus !== undefined ? { healthStatus: res.healthStatus } : {}),
        healthReason: reason,
        notice: `账号重登失败：未刷新 cookie${message ? `（${message}）` : ""}`,
        message: reason,
        noticeLevel: "error",
      };
    }
    case "auth_expired":
      return authExpiredDecision(message, res.healthStatus);
    case "engine_unavailable":
    case "lock_busy":
    case "profile_error":
    case "network_timeout":
    case "unknown":
      if (res.healthStatus === "relogin_required") {
        return authExpiredDecision(message, res.healthStatus);
      }
      {
        const fallback = message || "服务受限，请稍后重试";
        return {
          openQr: false,
          writeCookie: false,
          writeUpdatedAt: false,
          ...(res.healthStatus !== undefined && res.healthStatus !== "invalid"
            ? { healthStatus: res.healthStatus }
            : {}),
          ...(message !== "" ? { healthReason: message } : {}),
          notice: `账号重登完成：${fallback}`,
          message: fallback,
          noticeLevel: "warning",
        };
      }
    default:
      return assertNever(failureClass);
  }
};
