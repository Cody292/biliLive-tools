/** 可分类 probeOnce（§9.3.1）；禁止吞 `{}`；超时/网络永不 relogin_required。 */
import type { DouyinAccountHealthStatus } from "@biliLive-tools/types";

export type ProbeFailureClass =
  | "auth_failed"
  | "http_error"
  | "timeout"
  | "parse_error"
  | "network"
  | "unknown";

export type DouyinAccountIdentity = {
  readonly nickname?: string;
  readonly uid?: string;
  readonly sec_user_id?: string;
};

export type ProbeOnceOk = { readonly ok: true; readonly identity?: DouyinAccountIdentity };
export type ProbeOnceFail = {
  readonly ok: false;
  readonly class: ProbeFailureClass;
  readonly httpStatus?: number;
  readonly reason?: string;
};
export type ProbeOnceResult = ProbeOnceOk | ProbeOnceFail;
export type ProbeOnceOptions = {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 3500;
const IDENTITY_URL =
  "https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383&device_platform=webapp";
const IDENTITY_HEADERS = {
  accept: "application/json, text/plain, */*",
  referer: "https://www.douyin.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
} as const;

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function pickText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function firstText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const picked = pickText(value);
    if (picked !== undefined) return picked;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUser(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = payload.user ?? payload.user_info ?? payload.userInfo;
  if (isPlainRecord(direct)) return direct;
  const data = payload.data;
  if (!isPlainRecord(data)) return undefined;
  const nested = data.user ?? data.user_info ?? data.userInfo;
  return isPlainRecord(nested) ? nested : undefined;
}

export function normalizeDouyinIdentityPayload(payload: unknown): DouyinAccountIdentity {
  if (!isPlainRecord(payload)) return {};
  const user = readUser(payload) ?? payload;
  const nickname = firstText(user.nickname, user.nick_name, user.name, payload.nickname);
  const uid = firstText(user.uid, user.user_id, user.userId, payload.uid);
  const secUserID = firstText(user.sec_uid, user.sec_user_id, user.secUid, payload.sec_user_id);
  return {
    ...(nickname === undefined ? {} : { nickname }),
    ...(uid === undefined ? {} : { uid }),
    ...(secUserID === undefined ? {} : { sec_user_id: secUserID }),
  };
}

function hasIdentity(identity: DouyinAccountIdentity): boolean {
  return identity.nickname !== undefined || identity.uid !== undefined || identity.sec_user_id !== undefined;
}

function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  return "code" in error && error.code === "ABORT_ERR";
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error == null || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (NETWORK_CODES.has(code)) return true;
  const message =
    "message" in error && typeof error.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("fetch failed") || message.includes("network") || message.includes("enotfound");
}

function fail(
  className: ProbeFailureClass,
  extras: { readonly httpStatus?: number; readonly reason?: string } = {},
): ProbeOnceFail {
  return {
    ok: false,
    class: className,
    ...(extras.httpStatus === undefined ? {} : { httpStatus: extras.httpStatus }),
    ...(extras.reason === undefined ? {} : { reason: extras.reason }),
  };
}

function classifyFetchError(error: unknown, aborted: boolean): ProbeOnceFail {
  if (isAbortError(error) || aborted) {
    return fail("timeout", { reason: "identity probe aborted or timed out" });
  }
  if (isNetworkError(error)) {
    return fail("network", { reason: error instanceof Error ? error.message : "network error" });
  }
  return fail("unknown", { reason: error instanceof Error ? error.message : "unknown fetch error" });
}

/** 单次身份探针：结构化 class；auth_failed=401/403 或 200 无 identity。 */
export async function probeOnce(
  cookie: string,
  options: ProbeOnceOptions = {},
): Promise<ProbeOnceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(IDENTITY_URL, {
        method: "GET",
        signal: controller.signal,
        headers: { ...IDENTITY_HEADERS, cookie },
      });
    } catch (error) {
      return classifyFetchError(error, controller.signal.aborted);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return fail("auth_failed", { httpStatus: response.status, reason: `HTTP ${response.status}` });
      }
      return fail("http_error", { httpStatus: response.status, reason: `HTTP ${response.status}` });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        return fail("timeout", { reason: "identity body read aborted" });
      }
      return fail("parse_error", {
        httpStatus: response.status,
        reason: error instanceof Error ? error.message : "failed to read body",
      });
    }

    if (text.trim() === "") {
      return fail("parse_error", { httpStatus: response.status, reason: "empty response body" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return fail("parse_error", { httpStatus: response.status, reason: "invalid JSON body" });
    }

    const identity = normalizeDouyinIdentityPayload(payload);
    if (!hasIdentity(identity)) {
      return fail("auth_failed", {
        httpStatus: response.status,
        reason: "no identity fields in profile payload",
      });
    }
    return { ok: true, identity };
  } finally {
    clearTimeout(timeout);
  }
}

/** 本层不写盘：ok→healthy；auth_failed→invalid；其余 undefined（永不 relogin_required）。 */
export function mapProbeToHealthHint(result: ProbeOnceResult): DouyinAccountHealthStatus | undefined {
  if (result.ok) return "healthy";
  if (result.class === "auth_failed") return "invalid";
  return undefined;
}

/** 兼容旧调用方：成功 identity，失败 `{}`。新路径用 {@link probeOnce}。 */
export async function fetchDouyinAccountIdentity(
  cookie: string,
  options: ProbeOnceOptions = {},
): Promise<DouyinAccountIdentity> {
  const result = await probeOnce(cookie, options);
  if (result.ok) return result.identity ?? {};
  return {};
}

