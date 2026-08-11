import type { DouyinAccountHealthStatus } from "@biliLive-tools/types";
import request from "./request";

export interface DouyinCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

export interface DouyinLoginWaitingResult {
  readonly id: string;
  readonly status: "waiting";
  readonly qrCode: string;
  readonly expiresAt: number;
}

export interface DouyinLoginCompletedResult {
  readonly id: string;
  readonly status: "completed";
  readonly cookies: readonly DouyinCookie[];
}

export interface DouyinLoginManualVerificationResult {
  readonly id: string;
  readonly status: "manual_verification";
  readonly reason: "captcha_required";
  readonly expiresAt: number;
  readonly verification: {
    readonly transport: "cdp";
    readonly input: readonly ("mouse" | "key")[];
    readonly screencast: "active" | "unavailable";
  };
}

export interface DouyinLoginScannedResult {
  readonly id: string;
  readonly status: "scanned";
  readonly qrCode: string;
  readonly expiresAt: number;
}

export interface DouyinLoginWebSmsState {
  readonly tried: boolean;
  readonly smsApiSeen: boolean;
  readonly sendResult?: {
    readonly hostPath: string;
    readonly ok: boolean;
    readonly message?: string;
  };
}

export interface DouyinLoginNeedAppVerifyResult {
  readonly id: string;
  readonly status: "need_app_verify";
  readonly error_code: 2046;
  readonly qrCode: string;
  readonly expiresAt: number;
  readonly webSms: DouyinLoginWebSmsState;
  readonly description?: string;
}

export type DouyinLoginPollResult =
  | DouyinLoginWaitingResult
  | DouyinLoginScannedResult
  | DouyinLoginNeedAppVerifyResult
  | DouyinLoginCompletedResult
  | DouyinLoginManualVerificationResult
  | { readonly status: "expired" }
  | { readonly status: "not_found" };

export type DouyinLoginCancelResult =
  | { readonly status: "cancelled" }
  | { readonly status: "not_found" };

export type DouyinSubmitSmsCodeResult =
  | {
      readonly status: "accepted";
      readonly id: string;
      readonly validate: {
        readonly attempted: boolean;
        readonly ok: boolean;
        readonly hostPath?: string;
        readonly message?: string;
      };
    }
  | { readonly status: "not_found" }
  | { readonly status: "invalid_code" }
  | { readonly status: "not_applicable" };

export interface DouyinAccountIdentity {
  readonly nickname?: string;
  readonly uid?: string;
  readonly sec_user_id?: string;
}

export interface DouyinAccountProbeParams {
  readonly accountId?: string;
  readonly cookie?: string;
}

export interface DouyinAccountProbeResult {
  readonly ok: boolean;
  readonly class?: string;
  readonly reason?: string;
  readonly healthHint?: DouyinAccountHealthStatus | null;
  readonly accountId?: string | null;
  readonly message?: string;
}

const qrcode = async (): Promise<DouyinLoginWaitingResult | DouyinLoginManualVerificationResult> => {
  const res = await request.post("/douyin/login");
  return res.data;
};

const loginCancel = async (id: string): Promise<DouyinLoginCancelResult> => {
  const res = await request.post("/douyin/login/cancel", { id });
  return res.data;
};

const loginPoll = async (id: string): Promise<DouyinLoginPollResult> => {
  const res = await request.get("/douyin/login/poll", {
    params: { id },
  });
  return res.data;
};

const submitSms = async (id: string, code: string): Promise<DouyinSubmitSmsCodeResult> => {
  const res = await request.post("/douyin/login/sms", { id, code });
  return res.data;
};

const getAccountIdentity = async (cookie: string): Promise<DouyinAccountIdentity> => {
  const res = await request.post("/douyin/account/identity", { cookie });
  return res.data;
};

const probeAccount = async (
  params: DouyinAccountProbeParams,
): Promise<DouyinAccountProbeResult> => {
  const res = await request.post("/douyin/account/probe", params);
  return res.data;
};

export interface ManualVerificationFrame {
  readonly data: string;
  readonly format: string;
}

export interface ManualVerificationStreamHandlers {
  readonly onFrame: (frame: ManualVerificationFrame) => void;
  readonly onError?: (err: Event) => void;
}

const getBaseURL = (): string => {
  const baseURL = request.defaults.baseURL || "";
  if (baseURL.startsWith("http")) {
    return baseURL;
  }
  const apiStorage = window.localStorage.getItem("api");
  if (apiStorage) {
    return apiStorage;
  }
  return "http://127.0.0.1:18010";
};

export const openManualVerificationStream = (
  id: string,
  handlers: ManualVerificationStreamHandlers
): EventSource => {
  const baseUrl = getBaseURL();
  const url = `${baseUrl.replace(/\/$/, "")}/douyin/login/manual/stream?id=${encodeURIComponent(id)}`;
  const es = new EventSource(url);
  es.addEventListener("frame", (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      handlers.onFrame(data);
    } catch (e) {
      console.error("Failed to parse SSE frame data", e);
    }
  });
  if (handlers.onError) {
    es.onerror = (err) => {
      handlers.onError!(err);
    };
  }
  return es;
};

export const sendManualVerificationInput = async (id: string, event: unknown): Promise<void> => {
  await request.post("/douyin/login/manual/input", { id, event });
};

export const formatDouyinCookieHeader = (cookies: readonly DouyinCookie[]): string => {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
};

export type DouyinLoginDiagnosticReason =
  | "sso_challenge"
  | "sso_blocked"
  | "risk_4031"
  | "illegal_app"
  | "cdp_unavailable"
  | "engine_unavailable"
  | "browser_timeout"
  | "qr_unavailable"
  | "generic_failure";

export interface DouyinLoginDiagnostic {
  readonly reason: DouyinLoginDiagnosticReason;
  readonly message: string;
  readonly nextActions?: readonly string[];
}

const DOUYIN_LOGIN_DIAGNOSTIC_REASONS = new Set<string>([
  "sso_challenge",
  "sso_blocked",
  "risk_4031",
  "illegal_app",
  "cdp_unavailable",
  "engine_unavailable",
  "browser_timeout",
  "qr_unavailable",
  "generic_failure",
]);

export const isDouyinLoginDiagnostic = (error: unknown): error is DouyinLoginDiagnostic => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if (!("reason" in error) || !("message" in error)) {
    return false;
  }
  if (
    typeof error.reason !== "string" ||
    !DOUYIN_LOGIN_DIAGNOSTIC_REASONS.has(error.reason) ||
    typeof error.message !== "string"
  ) {
    return false;
  }
  if ("nextActions" in error && error.nextActions !== undefined) {
    if (!Array.isArray(error.nextActions)) {
      return false;
    }
    for (const item of error.nextActions) {
      if (typeof item !== "string") {
        return false;
      }
    }
  }
  return true;
};

const douyin = {
  qrcode,
  loginCancel,
  loginPoll,
  submitSms,
  getAccountIdentity,
  probeAccount,
  formatDouyinCookieHeader,
  isDouyinLoginDiagnostic,
  openManualVerificationStream,
  sendManualVerificationInput,
};

export default douyin;
