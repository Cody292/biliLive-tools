/**
 * 抖音扫码登录 · HTTP 协议层（主路径）
 *
 * 对齐附录 B.7：
 * - 出码：login.douyin.com/passport/web/get_qrcode/ + ttwid jar；兼容裸 base64 PNG 与 qrcode_index_url
 * - check：passport 形态 query（禁止 thin 仅 token+service 当主路径语义）
 * - 状态机：waiting / scanned / expired / confirmed / need_app_verify(2046) / illegal_app(22)
 * - 禁止 Node 裸拼 a_bogus 冒充签名
 */

const DOUYIN_SERVICE_URL = "https://www.douyin.com";
const DOUYIN_TTWID_URL = "https://ttwid.bytedance.com/ttwid/union/register/";
/** 研究稳定 JSON 路径（B.7） */
const DOUYIN_PASSPORT_GET_QRCODE_URL =
  "https://login.douyin.com/passport/web/get_qrcode/?aid=6383&service=https%3A%2F%2Fwww.douyin.com&need_logo=false&need_short_url=true&device_platform=web_app&account_sdk_source=web&sdk_version=2.2.5&language=zh&passport_jssdk_version=2.2.5&passport_jssdk_type=web";
/** 兼容回退：历史 sso 入口（常 HTML challenge） */
const DOUYIN_SSO_QR_URL =
  "https://sso.douyin.com/get_qrcode/?aid=6383&service=https%3A%2F%2Fwww.douyin.com&need_logo=false&need_short_url=true";
/** 原生 check 宿主（B.7）；禁止 thin sso?token=&service= 主路径 */
const DOUYIN_PASSPORT_CHECK_URL = "https://login.douyin.com/passport/web/check_qrconnect/";
const DOUYIN_QR_FETCH_TIMEOUT_MS = 8_000;

const DOUYIN_LOGIN_URL_HOSTS = new Set([
  "sso.douyin.com",
  "www.douyin.com",
  "login.douyin.com",
  "api.amemv.com",
]);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 进程内最小 Cookie jar（仅 ttwid 等门禁键；值不落日志） */
const cookieJar = new Map<string, string>();

export type DouyinHTTPQRCode = {
  readonly qrCode: string;
  readonly token: string;
};

export type DouyinQRCodeStatus =
  | { readonly kind: "waiting" }
  | { readonly kind: "scanned" }
  | { readonly kind: "expired" }
  | { readonly kind: "confirmed"; readonly redirectURL: string }
  | {
      readonly kind: "need_app_verify";
      readonly errorCode: 2046;
      readonly description?: string;
    }
  | {
      readonly kind: "illegal_app";
      readonly errorCode: 22;
      readonly description?: string;
    };

export type QRCodeFetchResponse = {
  readonly ok: boolean;
  readonly headers: {
    readonly get: (name: string) => string | null;
  };
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
};

export type DouyinQRCodeFetchOptions = {
  readonly cookieHeader?: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export class DouyinSSOChallengeError extends Error {
  readonly name = "DouyinSSOChallengeError";
  constructor() {
    super("抖音 SSO 接口返回非 JSON 内容，可能触发了安全挑战");
  }
}

function jarCookieHeader(): string {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function applySetCookieHeaders(headers: QRCodeFetchResponse["headers"]): void {
  const single = headers.get("set-cookie");
  if (!single) {
    return;
  }
  for (const part of single.split(/,(?=[^;]+?=)/)) {
    const pair = part.split(";")[0]?.trim();
    if (!pair) {
      continue;
    }
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name.length > 0 && value.length > 0) {
      cookieJar.set(name, value);
    }
  }
}

async function fetchDouyin(
  url: string | URL,
  options: DouyinQRCodeFetchOptions = {},
): Promise<QRCodeFetchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOUYIN_QR_FETCH_TIMEOUT_MS);
  try {
    const cookie = options.cookieHeader ?? jarCookieHeader();
    const headers: Record<string, string> = {
      ...createDouyinHeaders(),
      ...(options.headers ?? {}),
    };
    if (cookie.length > 0) {
      headers.Cookie = cookie;
    }
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: controller.signal,
      redirect: "follow",
    });
    applySetCookieHeaders(response.headers);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function createDouyinHeaders(): Readonly<Record<string, string>> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Origin: DOUYIN_SERVICE_URL,
    Referer: `${DOUYIN_SERVICE_URL}/`,
    "User-Agent": DEFAULT_UA,
  };
}

/**
 * 确保 ttwid（B.7 A）。失败不抛，调用方可继续出码。
 */
export async function ensureDouyinTtwid(): Promise<boolean> {
  if (cookieJar.has("ttwid")) {
    return true;
  }
  try {
    const response = await fetchDouyin(DOUYIN_TTWID_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        region: "cn",
        aid: 1768,
        needFid: false,
        service: "www.douyin.com",
        migrate_info: { ticket: "", source: "node" },
        cbUrlProtocol: "https",
        union: true,
      }),
    });
    if (!response.ok) {
      return cookieJar.has("ttwid");
    }
    if (hasJSONContent(response)) {
      try {
        const payload = await response.json();
        if (isRecord(payload) && typeof payload.redirect_url === "string") {
          await fetchDouyin(payload.redirect_url);
        }
      } catch {
        // ignore parse errors
      }
    }
    cookieJar.set("gfkadpd", "10006,31827");
    return cookieJar.has("ttwid");
  } catch {
    return cookieJar.has("ttwid");
  }
}

/** 测试 / 会话注入用：清空或设置 jar（值勿日志） */
export function resetDouyinCookieJar(): void {
  cookieJar.clear();
}

export function seedDouyinCookieJar(entries: Readonly<Record<string, string>>): void {
  for (const [k, v] of Object.entries(entries)) {
    if (k && v) {
      cookieJar.set(k, v);
    }
  }
}

export function getDouyinCookieJarKeys(): readonly string[] {
  return [...cookieJar.keys()];
}

/**
 * 构建 passport 形态 check URL（禁止 thin 仅 token+service）。
 * 不拼 a_bogus；仅附官方常见 jssdk 标识键。
 */
export function buildPassportCheckURL(token: string): URL {
  const url = new URL(DOUYIN_PASSPORT_CHECK_URL);
  url.searchParams.set("token", token);
  url.searchParams.set("service", DOUYIN_SERVICE_URL);
  url.searchParams.set("aid", "6383");
  url.searchParams.set("account_sdk_source", "web");
  url.searchParams.set("sdk_version", "2.2.5");
  url.searchParams.set("language", "zh");
  url.searchParams.set("device_platform", "web_app");
  url.searchParams.set("passport_jssdk_version", "2.2.5");
  url.searchParams.set("passport_jssdk_type", "web");
  url.searchParams.set("is_from_ttaccountsdk", "1");
  url.searchParams.set("need_logo", "false");
  return url;
}

/** 是否 thin check（仅 token+service）—— 产品主路径禁止 */
export function isThinCheckURL(url: string | URL): boolean {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    const keys = [...u.searchParams.keys()];
    const hasToken = u.searchParams.has("token");
    const hasService = u.searchParams.has("service");
    if (!hasToken || !hasService) {
      return false;
    }
    return !keys.includes("passport_jssdk_version");
  } catch {
    return false;
  }
}

async function defaultFetchDouyinQRCode(): Promise<QRCodeFetchResponse> {
  await ensureDouyinTtwid();
  const primary = await fetchDouyin(DOUYIN_PASSPORT_GET_QRCODE_URL);
  if (primary.ok && hasJSONContent(primary)) {
    return primary;
  }
  // 仅在非 JSON / 非 ok 时回退 sso（避免 JSON 空 data 多打一次）
  const contentType = primary.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html") || !primary.ok) {
    return await fetchDouyin(DOUYIN_SSO_QR_URL);
  }
  return primary;
}


async function defaultFetchDouyinQRCodeStatus(token: string): Promise<QRCodeFetchResponse> {
  const url = buildPassportCheckURL(token);
  if (isThinCheckURL(url)) {
    throw new Error("thin check is forbidden on product path");
  }
  return await fetchDouyin(url);
}

export class DouyinRisk4031Error extends Error {
  readonly name = "DouyinRisk4031Error";
  readonly errorCode = 4031 as const;
  constructor(message = "抖音返回 error_code=4031 安全风险拦截") {
    super(message);
  }
}

export async function acquireDouyinQRCode(): Promise<DouyinHTTPQRCode | undefined> {
  try {
    const response = await defaultFetchDouyinQRCode();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !hasJSONContent(response)) {
      if (contentType.includes("text/html")) {
        throw new DouyinSSOChallengeError();
      }
      return undefined;
    }
    const payload = await response.json();
    if (isRecord(payload)) {
      const data = isRecord(payload.data) ? payload.data : payload;
      const raw = data.error_code ?? payload.error_code;
      const code = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
      if (code === 4031) {
        throw new DouyinRisk4031Error();
      }
    }
    return extractQRCode(payload);
  } catch (error) {
    if (error instanceof DouyinSSOChallengeError || error instanceof DouyinRisk4031Error) {
      throw error;
    }
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

export async function checkDouyinQRCodeStatus(token: string): Promise<DouyinQRCodeStatus | undefined> {
  try {
    const response = await defaultFetchDouyinQRCodeStatus(token);
    if (!response.ok || !hasJSONContent(response)) {
      return undefined;
    }
    return extractQRCodeStatus(await response.json());
  } catch (error) {
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

function hasJSONContent(response: Pick<QRCodeFetchResponse, "headers">): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

/**
 * 出码字段兼容：裸 base64 PNG / data:image / 安全 index_url
 */
export function extractQRCode(payload: unknown): DouyinHTTPQRCode | undefined {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    return undefined;
  }
  const token = payload.data.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    return undefined;
  }
  const trimmedToken = token.trim();
  const rawQrcode = payload.data.qrcode;
  const qrcodeIndexURL = payload.data.qrcode_index_url;

  if (typeof rawQrcode === "string" && rawQrcode.trim().length > 0) {
    const materialised = materializeQRCodeImage(rawQrcode.trim());
    if (materialised !== undefined) {
      return { qrCode: materialised, token: trimmedToken };
    }
  }

  if (typeof qrcodeIndexURL === "string") {
    const trimmedURL = qrcodeIndexURL.trim();
    if (isSafeQRCodeURL(trimmedURL)) {
      return { qrCode: trimmedURL, token: trimmedToken };
    }
  }
  return undefined;
}

/**
 * 将 passport 响应映射为产品状态机（含 2046 / 22；字符串 status）
 */
export function extractQRCodeStatus(payload: unknown): DouyinQRCodeStatus | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  const errorCodeRaw = payload.error_code ?? data.error_code;
  const errorCode =
    typeof errorCodeRaw === "number"
      ? errorCodeRaw
      : typeof errorCodeRaw === "string" && errorCodeRaw.trim() !== ""
        ? Number(errorCodeRaw)
        : undefined;
  const description =
    typeof payload.description === "string"
      ? payload.description
      : typeof data.description === "string"
        ? data.description
        : typeof payload.message === "string"
          ? payload.message
          : undefined;

  if (errorCode === 2046) {
    return {
      kind: "need_app_verify",
      errorCode: 2046,
      ...(description === undefined ? {} : { description }),
    };
  }
  if (errorCode === 22) {
    return {
      kind: "illegal_app",
      errorCode: 22,
      ...(description === undefined ? {} : { description }),
    };
  }

  const rawStatus = data.status != null ? String(data.status) : "";
  if (rawStatus === "1" || rawStatus === "new" || rawStatus === "waiting") {
    return { kind: "waiting" };
  }
  if (rawStatus === "2" || rawStatus === "scanned" || rawStatus === "pending") {
    return { kind: "scanned" };
  }
  if (rawStatus === "5" || rawStatus === "expired") {
    return { kind: "expired" };
  }
  if (
    rawStatus === "3" ||
    rawStatus === "confirmed" ||
    rawStatus === "success" ||
    rawStatus === "done"
  ) {
    const redirectURL = data.redirect_url;
    if (typeof redirectURL !== "string") {
      return undefined;
    }
    const trimmedURL = redirectURL.trim();
    return isSafeQRCodeURL(trimmedURL) ? { kind: "confirmed", redirectURL: trimmedURL } : undefined;
  }
  if ((errorCode === 0 || errorCode === undefined) && rawStatus === "") {
    return { kind: "waiting" };
  }
  return undefined;
}

/**
 * Cookie 成功判定：sessionid 且 (sid_tt | uid_tt | sid_guard 等)
 * 对齐 B.7；单独 sessionid 不足
 */
export function isDouyinAuthCookieSuccess(
  cookies: readonly { readonly name: string }[],
): boolean {
  const names = new Set(cookies.map((c) => c.name));
  if (!names.has("sessionid") && !names.has("sessionid_ss")) {
    return false;
  }
  return (
    names.has("sid_tt") ||
    names.has("uid_tt") ||
    names.has("uid_tt_ss") ||
    names.has("sid_guard")
  );
}

function materializeQRCodeImage(value: string): string | undefined {
  if (value.startsWith("data:image/")) {
    return value;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return isSafeQRCodeURL(value) ? value : undefined;
  }
  const cleaned = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(cleaned) || cleaned.length < 32) {
    return undefined;
  }
  try {
    const buf = Buffer.from(cleaned, "base64");
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return `data:image/png;base64,${cleaned}`;
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
      return `data:image/jpeg;base64,${cleaned}`;
    }
    if (buf.length > 64) {
      return `data:image/png;base64,${cleaned}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeQRCodeURL(value: string): boolean {
  if (value.length === 0 || !URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    (DOUYIN_LOGIN_URL_HOSTS.has(url.hostname) ||
      url.hostname.endsWith(".douyin.com") ||
      url.hostname.endsWith(".amemv.com"))
  );
}

export const __private__ = {
  DOUYIN_PASSPORT_GET_QRCODE_URL,
  DOUYIN_SSO_QR_URL,
  DOUYIN_PASSPORT_CHECK_URL,
  buildPassportCheckURL,
  isThinCheckURL,
  materializeQRCodeImage,
  createDouyinHeaders,
  jarCookieHeader,
};
