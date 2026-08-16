/**
 * 方案 B · 持久 Profile 静默续期运行时（Playwright launchPersistentContext）
 *
 * 边界：
 * - 一号一目录 + flock；不改 Mode A 无痕 create 语义
 * - 依赖可注入，便于 T5 mock
 * - 日志仅 phase + cookieLen/prefix；永不打印完整 cookie
 * - 不宣称 24h 可靠；不引入 modeBEnabled
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  ensureProfileDir,
  acquireProfileLock,
  writeSecretsSidecar,
  redactCookieMeta,
  MissingBilikeyError,
  ProfileLockTimeoutError,
  InvalidAccountIdError,
  hashCookieHeader12,
  isCookieRotated,
  collectSetCookieNames,
  collectQueryUserIdentityKeys,
  reconcileDouyinAccountUid,
  type DouyinIdentityReconcileReason,
  type ProfileLockHandle,
  type SilentRenewRuntimeInput,
  type SilentRenewFailureClass,
  type SilentRenewRotateEvidence,
} from "@biliLive-tools/shared";

/** 桌面 Windows UA；与 Mode A 对齐，不写 Spike 加速参数为产品默认 */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 轻量触达主站，足以刷新会话 cookie（显式超时，非 Spike 默认） */
const DEFAULT_TOUCH_URL = "https://www.douyin.com/";
/** 同 hash 未轮换时的二次触达（个人页）；非 Spike 加速参数 */
export const DEFAULT_SECOND_TOUCH_URL = "https://www.douyin.com/user/self";
/** 同域探测 query/user；hasUser 与身份键分离，日志只记 uid 长度 */
const QUERY_USER_URL = "https://www.douyin.com/aweme/v1/web/query/user/?aid=6383";
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_HEADLESS = true;

const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--lang=zh-CN",
] as const;

// ── Playwright 最小类型（可注入，不污染 Mode A） ──────────────────────────

export type ProfileCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly expires?: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
};

export type ProfileBrowserContext = {
  readonly newPage: () => Promise<ProfilePage>;
  readonly cookies: (urls?: readonly string[]) => Promise<readonly ProfileCookie[]>;
  readonly addCookies: (cookies: readonly ProfileCookie[]) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type ProfilePage = {
  readonly goto: (
    url: string,
    options?: {
      readonly waitUntil?: "domcontentloaded" | "load" | "commit" | "networkidle";
      readonly timeout?: number;
    },
  ) => Promise<unknown>;
  readonly close?: () => Promise<void>;
  /** 响应监听；安装后仅收集 Set-Cookie 名（不含值） */
  readonly on?: (event: string, listener: (...args: unknown[]) => void) => void;
  readonly url?: () => string;
  readonly title?: () => Promise<string> | string;
  readonly screenshot?: (options?: {
    path?: string;
    type?: "png";
    fullPage?: boolean;
    timeout?: number;
    animations?: "disabled";
  }) => Promise<unknown>;
  readonly evaluate?: (pageFunction: unknown, arg?: unknown) => Promise<unknown>;
  readonly content?: () => Promise<string>;
};

export type LaunchPersistentContextOptions = {
  readonly userDataDir: string;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly args?: readonly string[];
  readonly userAgent?: string;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
};

export type PlaywrightChromiumPersistent = {
  readonly launchPersistentContext: (
    userDataDir: string,
    options?: Omit<LaunchPersistentContextOptions, "userDataDir">,
  ) => Promise<ProfileBrowserContext>;
};

// ── 依赖注入 ──────────────────────────────────────────────────────────────

export type EnsureProfileDirFn = (
  accountId: string,
  options?: { baseDir?: string },
) => Promise<string>;

export type AcquireProfileLockFn = (options: {
  profileDir: string;
  timeoutMs: number;
}) => Promise<ProfileLockHandle>;

export type WriteSecretsSidecarFn = (
  profileDir: string,
  payload: { cookie: string; session?: string },
  key?: string,
) => Promise<string>;

export type ResolveChromeExecutableFn = (override?: string) => string | undefined;
export type LoadPlaywrightChromiumFn = () => PlaywrightChromiumPersistent;
export type IsColdProfileFn = (profileDir: string) => boolean | Promise<boolean>;

/**
 * secrets 写入策略：
 * - write：缺 BILIKEY / 写失败 → profile_error（诚实失败，非假成功）
 * - soft：主路径 cookie 成功则 ok；侧车失败仅记 message，不伪装已写入
 * - skip：不写侧车
 */
export type SecretsWriteMode = "write" | "soft" | "skip";

export type ProfileRuntimeDeps = {
  readonly ensureProfileDir?: EnsureProfileDirFn;
  readonly acquireProfileLock?: AcquireProfileLockFn;
  readonly writeSecretsSidecar?: WriteSecretsSidecarFn;
  readonly resolveChromeExecutable?: ResolveChromeExecutableFn;
  readonly loadPlaywrightChromium?: LoadPlaywrightChromiumFn;
  readonly isColdProfile?: IsColdProfileFn;
  readonly now?: () => number;
  readonly log?: (payload: Record<string, string | number | boolean | undefined>) => void;
};

export type RunSilentProfileRenewOptions = {
  readonly accountId: string;
  /** Profile 根目录；缺省走 shared 生产默认 */
  readonly baseDir?: string;
  /** 注入 Profile 的 cookie header 或原始 cookie 串 */
  readonly seedCookie?: string;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly lockTimeoutMs?: number;
  readonly navTimeoutMs?: number;
  /** 轻量触达 URL；缺省 www.douyin.com */
  readonly touchUrl?: string;
  /** 二次触达 URL；缺省 DEFAULT_SECOND_TOUCH_URL */
  readonly secondTouchUrl?: string;
  readonly secretsMode?: SecretsWriteMode;
  /** 可显式注入 bilikey；缺省走环境变量 */
  readonly bilikey?: string;
  /** 账号池 accountUid；旋转成功后与 query/user 身份键对账 */
  readonly expectedAccountUid?: string;
  readonly deps?: ProfileRuntimeDeps;
};

// ── Chrome 解析（本地最小复制，不 import/改 Mode A 私有函数） ─────────────

/**
 * 解析 Chromium/Chrome 可执行路径；逻辑对齐 Mode A resolveChromeExecutable，
 * 但独立实现，避免耦合 Session 运行时。
 */
export function resolveChromeExecutable(override?: string): string | undefined {
  if (override && existsSync(override)) {
    return override;
  }
  const envPath =
    process.env.DOUYIN_CHROME_PATH ??
    process.env.CHROME_PATH ??
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const candidates = [
    "/usr/local/bin/douyin-chrome",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (hit) {
    return hit;
  }
  try {
    const roots = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      "/ms-playwright",
      `${process.env.HOME ?? ""}/.cache/ms-playwright`,
    ].filter((v): v is string => Boolean(v));
    for (const root of roots) {
      if (!existsSync(root)) {
        continue;
      }
      for (const name of readdirSync(root)) {
        const under = [
          `${root}/${name}/chrome-linux64/chrome`,
          `${root}/${name}/chrome-linux/chrome`,
        ];
        for (const chrome of under) {
          if (existsSync(chrome) && statSync(chrome).isFile()) {
            return chrome;
          }
        }
      }
    }
  } catch {
    // ignore fs 探测失败
  }
  return undefined;
}

/**
 * 加载 playwright-core.chromium（需 launchPersistentContext）。
 * 缺失/形态不对 → 抛带 code 的 Error，由上层映射 engine_unavailable。
 */
export function loadPlaywrightChromium(): PlaywrightChromiumPersistent {
  const nodeRequire = createRequire(import.meta.url);
  let imported: unknown;
  try {
    imported = nodeRequire("playwright-core");
  } catch (error) {
    const err = new Error("playwright-core 不可用，无法启动持久 Profile 浏览器。", {
      cause: error instanceof Error ? error : undefined,
    });
    (err as Error & { code: string }).code = "engine_unavailable";
    throw err;
  }
  const chromium =
    typeof imported === "object" &&
    imported !== null &&
    "chromium" in imported &&
    typeof (imported as { chromium: unknown }).chromium === "object" &&
    (imported as { chromium: { launchPersistentContext?: unknown } }).chromium !== null
      ? (imported as { chromium: PlaywrightChromiumPersistent }).chromium
      : undefined;
  if (typeof chromium?.launchPersistentContext !== "function") {
    const err = new Error("playwright-core.chromium.launchPersistentContext 不可用。");
    (err as Error & { code: string }).code = "engine_unavailable";
    throw err;
  }
  return chromium;
}

/**
 * 冷 profile：尚无 Chromium Default 用户目录（或等价标记）。
 * 可注入覆盖，便于单测。
 */
export function isColdProfileDir(profileDir: string): boolean {
  const defaultDir = path.join(profileDir, "Default");
  if (existsSync(defaultDir)) {
    return false;
  }
  // 部分环境 userDataDir 直接落 Cookies / Local State
  if (existsSync(path.join(profileDir, "Local State"))) {
    return false;
  }
  if (existsSync(path.join(profileDir, "Cookies"))) {
    return false;
  }
  return true;
}

// ── Cookie 工具 ───────────────────────────────────────────────────────────

/** 将 `a=b; c=d` 解析为 Playwright cookie 列表（douyin 域） */
export function parseCookieHeaderToPlaywright(
  cookieHeader: string,
  domain = ".douyin.com",
): ProfileCookie[] {
  const trimmed = cookieHeader.trim();
  if (!trimmed) {
    return [];
  }
  const out: ProfileCookie[] = [];
  for (const part of trimmed.split(";")) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    if (eq <= 0) continue;
    const name = seg.slice(0, eq).trim();
    const value = seg.slice(eq + 1).trim();
    if (!name) continue;
    out.push({
      name,
      value,
      domain,
      path: "/",
    });
  }
  return out;
}

/** Playwright cookies → Cookie header 字符串 */
export function cookiesToHeader(cookies: readonly ProfileCookie[]): string {
  const seen = new Map<string, string>();
  for (const c of cookies) {
    if (!c.name) continue;
    // 后写覆盖同名（同域多 path 时取最后一条）
    seen.set(c.name, c.value);
  }
  return [...seen.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 是否具备可判定的登录会话 cookie（明确未登录才标 auth_expired） */
export function hasSessionAuthCookie(cookies: readonly ProfileCookie[]): boolean {
  const names = new Set(cookies.map((c) => c.name));
  return names.has("sessionid") || names.has("sessionid_ss");
}

const COOKIE_EXTRACT_URLS = [
  "https://www.douyin.com/",
  "https://douyin.com/",
  "https://www.iesdouyin.com/",
] as const;

type ProfileResponseLike = {
  readonly headers?: () => Record<string, string | string[] | undefined>;
};

function readSetCookieHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | string[] | undefined {
  if (headers == null) return undefined;
  const direct = headers["set-cookie"];
  if (direct != null) return direct;
  const lower = headers["Set-Cookie"];
  if (lower != null) return lower;
  return undefined;
}

/** 仅收集 Set-Cookie 名；永不记录 header 值 */
function attachSetCookieNameObserver(
  page: ProfilePage,
  sink: Set<string>,
): void {
  if (typeof page.on !== "function") return;
  page.on("response", (...args: unknown[]) => {
    const response = args[0] as ProfileResponseLike | undefined;
    if (response == null || typeof response.headers !== "function") return;
    let headers: Record<string, string | string[] | undefined>;
    try {
      headers = response.headers();
    } catch {
      return;
    }
    for (const name of collectSetCookieNames(readSetCookieHeader(headers))) {
      sink.add(name);
    }
  });
}

async function extractProfileCookies(
  context: ProfileBrowserContext,
): Promise<readonly ProfileCookie[]> {
  let cookies = await context.cookies(COOKIE_EXTRACT_URLS);
  if (!hasSessionAuthCookie(cookies)) {
    cookies = await context.cookies();
  }
  return cookies;
}

async function gotoTouch(
  page: ProfilePage,
  url: string,
  navTimeoutMs: number,
  log: ProfileRuntimeDeps["log"],
  phase: string,
): Promise<{ timedOut: boolean; errorMessage?: string }> {
  const navStartedAt = Date.now();
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navTimeoutMs,
    });
    phaseLog(log, phase, navStartedAt, { ok: true, url });
    return { timedOut: false };
  } catch (err) {
    phaseLog(log, phase, navStartedAt, { ok: false });
    if (isTimeoutError(err)) {
      return { timedOut: true, errorMessage: errorMessageOf(err) };
    }
    phaseLog(log, `${phase}_continue`, navStartedAt, {
      reason: errorMessageOf(err),
    });
    return { timedOut: false, errorMessage: errorMessageOf(err) };
  }
}

function evaluateRotate(input: {
  hashBefore12: string;
  cookieHeader: string;
  setCookieNames: readonly string[];
}): {
  hashAfter12: string;
  rotated: boolean;
  via: SilentRenewRotateEvidence["via"] | undefined;
  evidence: Omit<SilentRenewRotateEvidence, "via"> & {
    via?: SilentRenewRotateEvidence["via"];
  };
} {
  const hashAfter12 = hashCookieHeader12(input.cookieHeader);
  const rotated = isCookieRotated({
    hashBefore12: input.hashBefore12,
    hashAfter12,
    setCookieNames: input.setCookieNames,
  });
  const via: SilentRenewRotateEvidence["via"] | undefined = rotated
    ? input.hashBefore12 !== hashAfter12
      ? "hash"
      : "set-cookie"
    : undefined;
  return {
    hashAfter12,
    rotated,
    via,
    evidence: {
      ...(via !== undefined ? { via } : {}),
      hashBefore12: input.hashBefore12,
      hashAfter12,
      setCookieCaptured: input.setCookieNames.length > 0,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mentionsCaptcha(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("verify") ||
    lower.includes("captcha") ||
    lower.includes("verify_center")
  );
}

type QueryUserProbe = {
  readonly hasUser: boolean;
  readonly errorCode: number | undefined;
  readonly captchaHint: boolean;
  readonly user_uid?: string;
  readonly uid?: string;
  readonly sec_uid?: string;
  readonly body: unknown;
};

function readOptionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 解析 query/user JSON：hasUser 逻辑不变；可选回传身份键，永不打完整 cookie */
function readQueryUserHasUser(body: unknown): {
  hasUser: boolean;
  errorCode: number | undefined;
  user_uid?: string;
  uid?: string;
  sec_uid?: string;
} {
  if (!isRecord(body)) return { hasUser: false, errorCode: undefined };
  const errorCode = typeof body.error_code === "number" ? body.error_code : undefined;
  const user = isRecord(body.user) ? body.user : undefined;
  const user_uid = readOptionalStringField(body.user_uid);
  const uid = readOptionalStringField(user?.uid);
  const sec_uid = readOptionalStringField(user?.sec_uid);
  const hasUid = body.user_uid != null || user?.uid != null || user?.sec_uid != null;
  const errorOk = errorCode === 0 || errorCode === undefined;
  return { hasUser: Boolean(hasUid) && errorOk, errorCode, user_uid, uid, sec_uid };
}

/**
 * 页内 GET /aweme/v1/web/query/user/（credentials include）。
 * query/user 失败时用 HTML `secUid` 作次级 hasUser。HTML 回退不影响对账键。
 */
async function probeQueryUser(page: ProfilePage): Promise<QueryUserProbe> {
  let body: unknown;
  let evaluateFailed = true;
  if (typeof page.evaluate === "function") {
    try {
      body = await page.evaluate(async (url: unknown) => {
        const res = await fetch(String(url), { credentials: "include" });
        return await res.json();
      }, QUERY_USER_URL);
      evaluateFailed = false;
    } catch {
      evaluateFailed = true;
    }
  }

  const parsed = readQueryUserHasUser(body);
  let hasUser = parsed.hasUser;
  let captchaHint = isRecord(body) ? mentionsCaptcha(JSON.stringify(body)) : false;

  if (!hasUser && (evaluateFailed || !isRecord(body) || (parsed.errorCode !== 0 && parsed.errorCode !== undefined))) {
    if (typeof page.content === "function") {
      try {
        const html = await page.content();
        if (html.includes("secUid")) hasUser = true;
        if (mentionsCaptcha(html)) captchaHint = true;
      } catch {
        // content 失败不影响主判定
      }
    }
  }

  return {
    hasUser,
    errorCode: parsed.errorCode,
    captchaHint,
    ...(parsed.user_uid !== undefined ? { user_uid: parsed.user_uid } : {}),
    ...(parsed.uid !== undefined ? { uid: parsed.uid } : {}),
    ...(parsed.sec_uid !== undefined ? { sec_uid: parsed.sec_uid } : {}),
    body,
  };
}

const IDENTITY_UNBOUND_MESSAGE = "账号重登失败：未绑定身份，请重新扫码";
const IDENTITY_MISMATCH_MESSAGE = "账号重登失败：登录身份与账号不一致";

function identityFailureMessage(reason: DouyinIdentityReconcileReason): string {
  switch (reason) {
    case "empty_account_uid":
      return IDENTITY_UNBOUND_MESSAGE;
    case "empty_probe_identity":
    case "identity_mismatch":
      return IDENTITY_MISMATCH_MESSAGE;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

async function readPageTitle(page: ProfilePage): Promise<string | undefined> {
  if (typeof page.title !== "function") return undefined;
  try {
    const raw = await page.title();
    return typeof raw === "string" ? raw.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

// ── 错误分类 ──────────────────────────────────────────────────────────────

function errorCodeOf(err: unknown): string | undefined {
  if (err == null || typeof err !== "object") return undefined;
  if ("code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return undefined;
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

function isTimeoutError(err: unknown): boolean {
  const msg = errorMessageOf(err).toLowerCase();
  const code = errorCodeOf(err);
  if (code === "ETIMEDOUT" || code === "ERR_TIMED_OUT") return true;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return true;
  }
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("navigation timeout") ||
    msg.includes("exceeded")
  );
}

function isEngineError(err: unknown): boolean {
  const code = errorCodeOf(err);
  if (code === "engine_unavailable") return true;
  const msg = errorMessageOf(err).toLowerCase();
  return (
    msg.includes("playwright") ||
    msg.includes("browser has been closed") ||
    msg.includes("executable doesn't exist") ||
    msg.includes("failed to launch") ||
    msg.includes("chromium") ||
    msg.includes("target closed")
  );
}

function isProfileFsError(err: unknown): boolean {
  if (err instanceof InvalidAccountIdError) return true;
  if (err instanceof MissingBilikeyError) return true;
  const code = errorCodeOf(err);
  if (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOTDIR" ||
    code === "EISDIR" ||
    code === "INVALID_ACCOUNT_ID" ||
    code === "MISSING_BILIKEY"
  ) {
    return true;
  }
  const msg = errorMessageOf(err).toLowerCase();
  return (
    msg.includes("enoent") ||
    msg.includes("eacces") ||
    msg.includes("bilikey") ||
    msg.includes("encrypt") ||
    msg.includes("decrypt") ||
    msg.includes("profile")
  );
}

function classifyFailure(err: unknown): {
  failureClass: SilentRenewFailureClass;
  message: string;
} {
  if (err instanceof ProfileLockTimeoutError) {
    return { failureClass: "lock_busy", message: err.message };
  }
  if (err instanceof InvalidAccountIdError) {
    return { failureClass: "profile_error", message: err.message };
  }
  if (err instanceof MissingBilikeyError) {
    return { failureClass: "profile_error", message: err.message };
  }
  if (isTimeoutError(err)) {
    return { failureClass: "network_timeout", message: errorMessageOf(err) };
  }
  if (isEngineError(err)) {
    return { failureClass: "engine_unavailable", message: errorMessageOf(err) };
  }
  if (isProfileFsError(err)) {
    return { failureClass: "profile_error", message: errorMessageOf(err) };
  }
  return { failureClass: "unknown", message: errorMessageOf(err) };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

function phaseLog(
  log: ProfileRuntimeDeps["log"],
  phase: string,
  startedAt: number,
  extra?: Record<string, string | number | boolean | undefined>,
): void {
  const payload: Record<string, string | number | boolean | undefined> = {
    phase,
    ms: Date.now() - startedAt,
    ...extra,
  };
  if (log) {
    log(payload);
    return;
  }
  console.info(`[douyin-profile] ${JSON.stringify(payload)}`);
}

/**
 * 使用持久 Profile 执行静默续期，返回 SilentRenewRuntimeInput 形状。
 *
 * 流程：sanitize/ensure → lock → launchPersistentContext → seed →
 * 导航 + Set-Cookie 名观察 → 轮换判定（必要时二次触达）→ 仅真实成功写 secrets。
 */
export async function runSilentProfileRenew(
  options: RunSilentProfileRenewOptions,
): Promise<SilentRenewRuntimeInput> {
  const deps = options.deps ?? {};
  const ensureDir = deps.ensureProfileDir ?? ensureProfileDir;
  const acquireLock = deps.acquireProfileLock ?? acquireProfileLock;
  const writeSecrets = deps.writeSecretsSidecar ?? writeSecretsSidecar;
  const resolveChrome = deps.resolveChromeExecutable ?? resolveChromeExecutable;
  const loadChromium = deps.loadPlaywrightChromium ?? loadPlaywrightChromium;
  const coldCheck = deps.isColdProfile ?? isColdProfileDir;
  const now = deps.now ?? Date.now;
  const log = deps.log;

  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const navTimeoutMs = options.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  const touchUrl = options.touchUrl ?? DEFAULT_TOUCH_URL;
  const secondTouchUrl = options.secondTouchUrl ?? DEFAULT_SECOND_TOUCH_URL;
  const secretsMode: SecretsWriteMode = options.secretsMode ?? "write";
  const headless = options.headless ?? DEFAULT_HEADLESS;
  const runStartedAt = now();

  let lock: ProfileLockHandle | undefined;
  let context: ProfileBrowserContext | undefined;
  let profileDir = "";

  try {
    phaseLog(log, "start", runStartedAt, { accountId: options.accountId });

    profileDir = await ensureDir(options.accountId, { baseDir: options.baseDir });
    phaseLog(log, "ensure_profile_dir", runStartedAt, { profileDir });

    try {
      lock = await acquireLock({ profileDir, timeoutMs: lockTimeoutMs });
    } catch (err) {
      if (err instanceof ProfileLockTimeoutError) {
        phaseLog(log, "lock_busy", runStartedAt, { profileDir });
        return {
          ok: false,
          failureClass: "lock_busy",
          message: err.message,
          checkedAt: now(),
        };
      }
      throw err;
    }
    phaseLog(log, "lock_acquired", runStartedAt, { lockPath: lock.lockPath });

    const executablePath = resolveChrome(options.executablePath);
    if (!executablePath) {
      phaseLog(log, "engine_unavailable", runStartedAt, { reason: "chrome_not_found" });
      return {
        ok: false,
        failureClass: "engine_unavailable",
        message:
          "未找到 Chromium/Chrome 可执行文件（请安装 Playwright Chromium 或设置 DOUYIN_CHROME_PATH）。",
        checkedAt: now(),
      };
    }

    let chromium: PlaywrightChromiumPersistent;
    try {
      chromium = loadChromium();
    } catch (err) {
      const classified = classifyFailure(err);
      phaseLog(log, "engine_unavailable", runStartedAt, { reason: "playwright_load" });
      return {
        ok: false,
        failureClass: "engine_unavailable",
        message: classified.message,
        checkedAt: now(),
      };
    }

    // 必须在 launch 前判定冷 profile：launch 后 Chromium 会创建 Default/
    const cold = options.seedCookie ? await coldCheck(profileDir) : false;

    const launchStartedAt = now();
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless,
        executablePath,
        args: [...CHROMIUM_ARGS],
        userAgent: DEFAULT_UA,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1280, height: 720 },
      });
      phaseLog(log, "browser_launch", launchStartedAt, { ok: true });
    } catch (err) {
      phaseLog(log, "browser_launch", launchStartedAt, { ok: false });
      return {
        ok: false,
        failureClass: "engine_unavailable",
        message: `服务端 Chromium 持久 Profile 启动失败: ${errorMessageOf(err)}`,
        checkedAt: now(),
      };
    }

    // 修复空/访客 Profile：只要有账号池 seed，就始终注入并与账号池 cookie 对齐；cold 仅用于诊断。
    if (options.seedCookie) {
      const seed = parseCookieHeaderToPlaywright(options.seedCookie);
      if (seed.length > 0) {
        await context.addCookies(seed);
        const meta = redactCookieMeta(options.seedCookie);
        phaseLog(log, "seed_cookie", runStartedAt, {
          cold,
          cookieLen: meta.cookieLen,
          prefix: meta.prefix,
          count: seed.length,
        });
      }
    }

    const hashBefore12 = hashCookieHeader12(options.seedCookie ?? "");
    const setCookieNames = new Set<string>();

    const page = await context.newPage();
    attachSetCookieNameObserver(page, setCookieNames);

    const firstNav = await gotoTouch(page, touchUrl, navTimeoutMs, log, "touch_nav");
    if (firstNav.timedOut) {
      return {
        ok: false,
        failureClass: "network_timeout",
        message: `导航超时: ${firstNav.errorMessage ?? "timeout"}`,
        checkedAt: now(),
      };
    }

    let cookies = await extractProfileCookies(context);
    let cookieHeader = cookiesToHeader(cookies);
    let meta = redactCookieMeta(cookieHeader);
    phaseLog(log, "cookies_extracted", runStartedAt, {
      cookieLen: meta.cookieLen,
      prefix: meta.prefix,
      count: cookies.length,
    });

    if (!hasSessionAuthCookie(cookies) || cookieHeader.length === 0) {
      phaseLog(log, "auth_expired", runStartedAt, {
        cookieLen: meta.cookieLen,
        prefix: meta.prefix,
      });
      return {
        ok: false,
        failureClass: "auth_expired",
        message: "silent renew: no session cookie after profile touch",
        checkedAt: now(),
      };
    }

    let names = [...setCookieNames];
    let rotateEval = evaluateRotate({
      hashBefore12,
      cookieHeader,
      setCookieNames: names,
    });
    let secondNav = false;
    let loginProbe: QueryUserProbe | undefined;

    phaseLog(log, "rotate_check", runStartedAt, {
      hashBefore12: rotateEval.evidence.hashBefore12,
      hashAfter12: rotateEval.hashAfter12,
      setCookieNames: names.join(","),
      secondNav,
      via: rotateEval.via,
    });

    if (!rotateEval.rotated) {
      secondNav = true;
      const second = await gotoTouch(
        page,
        secondTouchUrl,
        navTimeoutMs,
        log,
        "second_touch_nav",
      );
      if (second.timedOut) {
        return {
          ok: false,
          failureClass: "network_timeout",
          message: `导航超时: ${second.errorMessage ?? "timeout"}`,
          checkedAt: now(),
        };
      }

      const probe = await probeQueryUser(page);
      loginProbe = probe;
      const finalUrl = typeof page.url === "function" ? page.url() : undefined;
      const title = await readPageTitle(page);
      phaseLog(log, "login_probe", runStartedAt, {
        hasUser: probe.hasUser,
        errorCode: probe.errorCode,
        captchaHint: probe.captchaHint,
        finalUrl,
        title,
        secondNav: true,
      });

      cookies = await extractProfileCookies(context);
      cookieHeader = cookiesToHeader(cookies);
      meta = redactCookieMeta(cookieHeader);
      phaseLog(log, "cookies_extracted", runStartedAt, {
        cookieLen: meta.cookieLen,
        prefix: meta.prefix,
        count: cookies.length,
        secondNav: true,
      });

      if (!hasSessionAuthCookie(cookies) || cookieHeader.length === 0) {
        phaseLog(log, "auth_expired", runStartedAt, {
          cookieLen: meta.cookieLen,
          prefix: meta.prefix,
        });
        return {
          ok: false,
          failureClass: "auth_expired",
          message: "silent renew: no session cookie after profile touch",
          checkedAt: now(),
        };
      }

      names = [...setCookieNames];
      rotateEval = evaluateRotate({
        hashBefore12,
        cookieHeader,
        setCookieNames: names,
      });
      phaseLog(log, "rotate_check", runStartedAt, {
        hashBefore12: rotateEval.evidence.hashBefore12,
        hashAfter12: rotateEval.hashAfter12,
        setCookieNames: names.join(","),
        secondNav,
        via: rotateEval.via,
      });
    }

    if (!rotateEval.rotated) {
      phaseLog(log, "not_rotated", runStartedAt, {
        hashBefore12: rotateEval.evidence.hashBefore12,
        hashAfter12: rotateEval.hashAfter12,
        setCookieNames: names.join(","),
        secondNav,
        cookieLen: meta.cookieLen,
        prefix: meta.prefix,
      });
      return {
        ok: false,
        failureClass: "not_rotated",
        message: "silent renew: cookie not rotated",
        checkedAt: now(),
        rotate: {
          hashBefore12: rotateEval.evidence.hashBefore12,
          hashAfter12: rotateEval.hashAfter12,
          setCookieCaptured: rotateEval.evidence.setCookieCaptured,
        } as SilentRenewRotateEvidence,
      };
    }

    const rotate: SilentRenewRotateEvidence = {
      via: rotateEval.via!,
      hashBefore12: rotateEval.evidence.hashBefore12,
      hashAfter12: rotateEval.hashAfter12,
      setCookieCaptured: rotateEval.evidence.setCookieCaptured,
    };

    const identityProbe = loginProbe ?? (await probeQueryUser(page));
    const identityKeys = collectQueryUserIdentityKeys(identityProbe.body);
    const identity = reconcileDouyinAccountUid(options.expectedAccountUid, identityKeys);
    phaseLog(log, "identity_reconcile", runStartedAt, {
      match: identity.ok,
      reason: identity.ok ? undefined : identity.reason,
      hasUser: identityProbe.hasUser,
      userUidLen: identityProbe.user_uid?.length ?? 0,
      uidLen: identityProbe.uid?.length ?? 0,
      secUidLen: identityProbe.sec_uid?.length ?? 0,
    });
    if (!identity.ok) {
      return {
        ok: false,
        failureClass: "identity_mismatch",
        message: identityFailureMessage(identity.reason),
        checkedAt: now(),
      };
    }

    if (secretsMode !== "skip") {
      try {
        await writeSecrets(profileDir, { cookie: cookieHeader }, options.bilikey);
        phaseLog(log, "secrets_written", runStartedAt, {
          cookieLen: meta.cookieLen,
          prefix: meta.prefix,
        });
      } catch (err) {
        const secretsMsg = errorMessageOf(err);
        phaseLog(log, "secrets_write_failed", runStartedAt, {
          soft: secretsMode === "soft",
          reason: err instanceof MissingBilikeyError ? "missing_bilikey" : "write_error",
        });
        if (secretsMode === "write") {
          return {
            ok: false,
            failureClass: "profile_error",
            message:
              err instanceof MissingBilikeyError
                ? secretsMsg
                : `secrets sidecar write failed: ${secretsMsg}`,
            checkedAt: now(),
          };
        }
        return {
          ok: true,
          cookie: cookieHeader,
          message: `silent renew: ok; secrets soft-fail: ${secretsMsg}`,
          checkedAt: now(),
          rotate,
        };
      }
    }

    phaseLog(log, "success", runStartedAt, {
      cookieLen: meta.cookieLen,
      prefix: meta.prefix,
      hashBefore12: rotate.hashBefore12,
      hashAfter12: rotate.hashAfter12,
      setCookieNames: names.join(","),
      secondNav,
      via: rotate.via,
    });
    return {
      ok: true,
      cookie: cookieHeader,
      message: "silent renew: ok",
      checkedAt: now(),
      rotate,
    };
  } catch (err) {
    const classified = classifyFailure(err);
    phaseLog(log, "failure", runStartedAt, {
      failureClass: classified.failureClass,
      // 禁止完整 cookie；仅 phase + class
    });
    return {
      ok: false,
      failureClass: classified.failureClass,
      message: classified.message,
      checkedAt: now(),
    };
  } finally {
    if (context) {
      try {
        await context.close();
        phaseLog(log, "context_closed", runStartedAt, {});
      } catch {
        // close 失败不掩盖主结果
      }
    }
    if (lock) {
      try {
        await lock.release();
        phaseLog(log, "lock_released", runStartedAt, {});
      } catch {
        // release 幂等；失败仅记 phase
        phaseLog(log, "lock_release_failed", runStartedAt, {});
      }
    }
  }
}
