/**
 * 方案 A · 服务端 jssdk 同会话运行时（E1 Playwright Chromium）
 *
 * 边界：
 * - 主路径：在受控 Chromium 内导航 SSO HTML，拦截 passport get_qrcode / check_qrconnect 等
 * - 禁止：Node 裸拼 a_bogus；调用用户本机浏览器扩展；Obscura 主出码
 * - 不落日志：完整 cookie / token / 短信码（仅键名或 token 前 8）
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { extractQRCode, extractQRCodeStatus, type DouyinQRCodeStatus } from "./douyinQRCode.js";

/** 桌面 Windows UA（非 Linux）；容器 Chromium 仍 headless，但对外伪装 Win Chrome */
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** r9c：带 aid+service 的 SSO full 入口（短 need_logo 壳易白屏/跳主站） */
const SSO_HTML_URL =
  "https://sso.douyin.com/get_qrcode/?aid=6383&service=https%3A%2F%2Fwww.douyin.com&need_logo=true";
/** 研究稳定 JSON 出码路径（login.douyin.com passport，非 SSO HTML 壳） */
const PASSPORT_GET_QRCODE_URL =
  "https://login.douyin.com/passport/web/get_qrcode/?aid=6383&service=https%3A%2F%2Fwww.douyin.com&need_logo=false&need_short_url=true&device_platform=web_app&account_sdk_source=web&sdk_version=2.2.5&language=zh&passport_jssdk_version=2.2.5&passport_jssdk_type=web";
const PASSPORT_GET_QRCODE_PATH = "/passport/web/get_qrcode";
const PASSPORT_CHECK_PATH = "/passport/web/check_qrconnect";
const SEND_CODE_PATH = "/passport/web/send_code";
const VALIDATE_CODE_PATH = "/passport/web/validate_code";

/** WAVE/R6：单次出码默认 40s（与 login 外层对齐；跳过无效 reload 后预算收紧） */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 40_000;
const DEFAULT_CHECK_TIMEOUT_MS = 20_000;
const DEFAULT_VALIDATE_CODE_TIMEOUT_MS = 8_000;
/** glue 仅作 jssdk 兜底上限；主路径应在 passport JSON 到达时 early settle */
const DEFAULT_QR_GLUE_WAIT_MS = 500;

function readPositiveMs(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export type SessionCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
};

export type SessionAcquireResult = {
  readonly token: string;
  readonly qrCode: string;
  /** token 前 8，仅诊断 */
  readonly tokenPrefix: string;
};

export type SessionRuntimeHandle = {
  readonly id: string;
  readonly acquireQR: () => Promise<SessionAcquireResult>;
  readonly checkStatus: (token: string) => Promise<DouyinQRCodeStatus | undefined>;
  readonly openRedirectURL: (url: string) => Promise<void>;
  readonly getCookies: () => Promise<readonly SessionCookie[]>;
  readonly submitSmsCode: (code: string) => Promise<{
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly hostPath?: string;
    readonly message?: string;
  }>;
  readonly markSmsApiSeenFromNetwork: () => boolean;
  readonly wasSmsApiSeen: () => boolean;
  readonly close: () => Promise<void>;
};

export type SessionRuntimeFactoryOptions = {
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly acquireTimeoutMs?: number;
  readonly checkTimeoutMs?: number;
  readonly glueWaitMs?: number;
  readonly createID?: () => string;
};

export class DouyinSessionEngineError extends Error {
  readonly name = "DouyinSessionEngineError";
  constructor(
    readonly code: "engine_unavailable" | "browser_timeout" | "sso_blocked" | "qr_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DouyinRiskBlockedError extends Error {
  readonly name = "DouyinRiskBlockedError";
  constructor(
    readonly errorCode: number,
    message: string,
  ) {
    super(message);
  }
}

type PlaywrightChromium = {
  readonly launch: (options?: {
    readonly executablePath?: string;
    readonly headless?: boolean;
    readonly args?: readonly string[];
  }) => Promise<PlaywrightBrowser>;
};

type PlaywrightBrowser = {
  readonly newContext: (options?: {
    readonly userAgent?: string;
    readonly locale?: string;
    readonly timezoneId?: string;
    readonly viewport?: { readonly width: number; readonly height: number };
    readonly extraHTTPHeaders?: Readonly<Record<string, string>>;
  }) => Promise<PlaywrightBrowserContext>;
  readonly close: () => Promise<void>;
};

type PlaywrightAPIResponse = {
  readonly ok: () => boolean;
  readonly status: () => number;
  readonly text: () => Promise<string>;
  readonly headers: () => Readonly<Record<string, string>>;
};

type PlaywrightAPIRequestContext = {
  readonly get: (
    url: string,
    options?: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly timeout?: number;
    },
  ) => Promise<PlaywrightAPIResponse>;
};

type PlaywrightBrowserContext = {
  readonly newPage: () => Promise<PlaywrightPage>;
  readonly cookies: () => Promise<readonly SessionCookie[]>;
  readonly close: () => Promise<void>;
  readonly addInitScript: (script: string | (() => void)) => Promise<void>;
  readonly newCDPSession?: (page: PlaywrightPage) => Promise<PlaywrightCDPSession>;
  /** Playwright APIRequestContext：带 storage cookie，不走页面 CORS */
  readonly request?: PlaywrightAPIRequestContext;
};

type PlaywrightCDPSession = {
  readonly send: (method: "Page.captureScreenshot", params: { readonly format: "png"; readonly fromSurface: boolean }) => Promise<unknown>;
};

type PlaywrightRoute = {
  readonly abort: (errorCode?: string) => Promise<void>;
  readonly continue: () => Promise<void>;
  readonly request: () => { readonly resourceType: () => string; readonly url: () => string };
};

type PlaywrightPage = {
  readonly goto: (
    url: string,
    options?: {
      readonly waitUntil?: "domcontentloaded" | "load" | "commit";
      readonly timeout?: number;
      readonly referer?: string;
    },
  ) => Promise<unknown>;
  readonly on: (event: "response", handler: (response: PlaywrightResponse) => void) => void;
  readonly off?: (event: "response", handler: (response: PlaywrightResponse) => void) => void;
  readonly route?: (
    url: string | RegExp,
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ) => Promise<void>;
  readonly evaluate: {
    <T>(fn: () => T | Promise<T>): Promise<T>;
    <T, Arg>(fn: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<T>;
  };
  readonly waitForTimeout?: (ms: number) => Promise<void>;
  readonly url: () => string;
  readonly waitForSelector?: (
    selector: string,
    options?: { readonly timeout?: number },
  ) => Promise<unknown>;
  readonly waitForResponse?: (
    predicate: (response: PlaywrightResponse) => boolean,
    options?: { readonly timeout?: number },
  ) => Promise<PlaywrightResponse>;
  readonly frames?: () => readonly Pick<PlaywrightPage, "evaluate" | "locator">[];
  readonly fill?: (selector: string, value: string) => Promise<void>;
  readonly click?: (selector: string) => Promise<void>;
  readonly keyboard?: {
    readonly press: (key: string) => Promise<void>;
    readonly type: (text: string, options?: { readonly delay?: number }) => Promise<void>;
  };
  readonly mouse?: {
    readonly click: (x: number, y: number, options?: { readonly delay?: number }) => Promise<void>;
  };
  readonly locator?: (selector: string) => PlaywrightLocator;
  readonly screenshot?: (options: {
    readonly path: string;
    readonly fullPage?: boolean;
    readonly animations?: "disabled";
    readonly timeout?: number;
  }) => Promise<unknown>;
};

type PlaywrightLocator = {
  readonly count: () => Promise<number>;
  readonly first: () => PlaywrightLocator;
  readonly nth?: (index: number) => PlaywrightLocator;
  readonly filter: (options: { readonly hasText: string | RegExp }) => PlaywrightLocator;
  readonly fill?: (value: string, options?: { readonly timeout?: number }) => Promise<void>;
  readonly type?: (text: string, options?: { readonly delay?: number; readonly timeout?: number }) => Promise<void>;
  readonly pressSequentially?: (text: string, options?: { readonly delay?: number; readonly timeout?: number }) => Promise<void>;
  readonly inputValue?: (options?: { readonly timeout?: number }) => Promise<string>;
  readonly isDisabled?: (options?: { readonly timeout?: number }) => Promise<boolean>;
  readonly click: (options?: { readonly force?: boolean; readonly timeout?: number }) => Promise<void>;
};

type PlaywrightResponse = {
  readonly url: () => string;
  readonly status: () => number;
  readonly headers: () => Readonly<Record<string, string>>;
  readonly text: () => Promise<string>;
  readonly request: () => { readonly method: () => string; readonly headers: () => Readonly<Record<string, string>> };
};

type ValidateCodeObservation = {
  readonly requestSeen: boolean;
  readonly responseSeen: boolean;
  readonly status?: number;
  readonly ok: boolean;
  readonly message: string;
};

function resolveChromeExecutable(override?: string): string | undefined {
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
        const candidatesUnder = [
          `${root}/${name}/chrome-linux64/chrome`,
          `${root}/${name}/chrome-linux/chrome`,
        ];
        for (const chrome of candidatesUnder) {
          if (existsSync(chrome) && statSync(chrome).isFile()) {
            return chrome;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function loadPlaywrightChromium(): PlaywrightChromium {
  const nodeRequire = createRequire(import.meta.url);
  let imported: unknown;
  try {
    imported = nodeRequire("playwright-core");
  } catch (error) {
    throw new DouyinSessionEngineError(
      "engine_unavailable",
      "playwright-core 不可用，无法启动服务端同会话浏览器。",
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (
    typeof imported !== "object" ||
    imported === null ||
    !("chromium" in imported) ||
    typeof (imported as { chromium: unknown }).chromium !== "object" ||
    (imported as { chromium: { launch?: unknown } }).chromium === null ||
    typeof (imported as { chromium: { launch: unknown } }).chromium.launch !== "function"
  ) {
    throw new DouyinSessionEngineError("engine_unavailable", "playwright-core.chromium.launch 不可用。");
  }
  return (imported as { chromium: PlaywrightChromium }).chromium;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function tokenPrefixOf(token: string): string {
  return token.slice(0, 8);
}

function summarizeValidateCodeResponse(response: PlaywrightResponse, body: string): ValidateCodeObservation {
  const json = parseJsonBody(body);
  if (!isRecord(json)) {
    return {
      requestSeen: true,
      responseSeen: true,
      status: response.status(),
      ok: false,
      message: "validate_code_response_parse_failed",
    };
  }
  const data = isRecord(json.data) ? json.data : undefined;
  const hasTicket = data !== undefined && typeof data.ticket === "string" && data.ticket.length > 0;
  const success = json.message === "success" || json.error_code === 0 || hasTicket;
  return {
    requestSeen: true,
    responseSeen: true,
    status: response.status(),
    ok: response.status() >= 200 && response.status() < 300 && success,
    message: success ? "validate_code_success" : "validate_code_rejected",
  };
}

/** 构建 passport 形态 check URL（与 douyinQRCode.buildPassportCheckURL 对齐，禁 thin） */
function buildSessionCheckURL(token: string): string {
  const url = new URL("https://login.douyin.com/passport/web/check_qrconnect/");
  url.searchParams.set("token", token);
  url.searchParams.set("service", "https://www.douyin.com");
  url.searchParams.set("aid", "6383");
  url.searchParams.set("account_sdk_source", "web");
  url.searchParams.set("sdk_version", "2.2.5");
  url.searchParams.set("language", "zh");
  url.searchParams.set("device_platform", "web_app");
  url.searchParams.set("passport_jssdk_version", "2.2.5");
  url.searchParams.set("passport_jssdk_type", "web");
  url.searchParams.set("is_from_ttaccountsdk", "1");
  url.searchParams.set("need_logo", "false");
  return url.toString();
}

function tryExtractAcquireFromJson(json: unknown): SessionAcquireResult | "risk_4031" | undefined {
  if (!isRecord(json)) {
    return undefined;
  }
  const data = isRecord(json.data) ? json.data : json;
  const errorCode = data.error_code ?? json.error_code;
  const codeNum = typeof errorCode === "number" ? errorCode : Number(errorCode);
  if (codeNum === 4031) {
    return "risk_4031";
  }
  const extracted = extractQRCode(json);
  if (!extracted) {
    return undefined;
  }
  return {
    token: extracted.token,
    qrCode: extracted.qrCode,
    tokenPrefix: tokenPrefixOf(extracted.token),
  };
}

/**
 * 创建同会话运行时（一会话一 browser context）。
 */
export async function createDouyinSessionRuntime(
  options: SessionRuntimeFactoryOptions = {},
): Promise<SessionRuntimeHandle> {
  const id = options.createID?.() ?? `sess-${Date.now()}`;
  const acquireTimeoutMs =
    options.acquireTimeoutMs ??
    readPositiveMs(process.env.DOUYIN_QR_ACQUIRE_TIMEOUT_MS, DEFAULT_ACQUIRE_TIMEOUT_MS);
  const checkTimeoutMs =
    options.checkTimeoutMs ??
    readPositiveMs(process.env.DOUYIN_QR_CHECK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS);
  const validateCodeTimeoutMs = readPositiveMs(
    process.env.DOUYIN_VALIDATE_CODE_TIMEOUT_MS,
    DEFAULT_VALIDATE_CODE_TIMEOUT_MS,
  );
  const glueWaitMs =
    options.glueWaitMs ??
    readPositiveMs(process.env.DOUYIN_QR_GLUE_WAIT_MS, DEFAULT_QR_GLUE_WAIT_MS);
  const executablePath = resolveChromeExecutable(options.executablePath);
  const phaseLog = (phase: string, startedAt: number, extra?: Record<string, string | number | boolean>) => {
  const payload = {
      phase,
      ms: Date.now() - startedAt,
      sessionId: id,
      ...extra,
    };
    console.info(`[douyin-session] ${JSON.stringify(payload)}`);
  };
  if (!executablePath) {
    throw new DouyinSessionEngineError(
      "engine_unavailable",
      "未找到 Chromium/Chrome 可执行文件（请安装 Playwright Chromium 或设置 DOUYIN_CHROME_PATH）。",
    );
  }

  const chromium = loadPlaywrightChromium();
  let browser: PlaywrightBrowser;
  const launchStartedAt = Date.now();
  try {
    browser = await chromium.launch({
      executablePath,
      headless: options.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--lang=zh-CN",
      ],
    });
    phaseLog("browser_launch", launchStartedAt, { ok: true });
  } catch (error) {
    phaseLog("browser_launch", launchStartedAt, { ok: false });
    throw new DouyinSessionEngineError(
      "engine_unavailable",
      "服务端 Chromium 启动失败。",
      { cause: error instanceof Error ? error : undefined },
    );
  }

  const context = await browser.newContext({
    userAgent: DEFAULT_UA,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  await context.addInitScript(() => {
    // HOTPATCH_WAVE11_STEALTH
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-expect-error product stealth shim
    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: {},
    };
    Object.defineProperty(navigator, "languages", {
      get: () => ["zh-CN", "zh", "en"],
    });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    try {
      const origQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions,
      );
      window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
        parameters && parameters.name === "notifications"
          ? Promise.resolve({
              state: Notification.permission,
            } as PermissionStatus)
          : origQuery(parameters);
    } catch {
      // ignore stealth permissions shim failures
    }
  });

  const page = await context.newPage();
  const writeDebugScreenshot = async (label: string): Promise<string | undefined> => {
    if (page.screenshot === undefined) {
      return undefined;
    }
    const screenshotStartedAt = Date.now();
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const filePath = join("/app/temp/douyin-sso-debug", `${safeLabel}_${id}_${Date.now()}.png`);
    try {
      mkdirSync("/app/temp/douyin-sso-debug", { recursive: true });
      // r9c：截图硬顶 1.5s，禁止 CDP fallback 拖死 28s+ 占用会话
      const shotPromise = page.screenshot({
        path: filePath,
        fullPage: false,
        animations: "disabled",
        timeout: 1_500,
      });
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("debug_screenshot_hard_timeout_1500ms")), 1_500);
      });
      await Promise.race([shotPromise, timeoutPromise]);
      phaseLog("debug_screenshot", screenshotStartedAt, {
        label: safeLabel,
        path: filePath,
        ok: true,
        hotpatch: "r9c",
      });
      return filePath;
    } catch (error) {
      phaseLog("debug_screenshot", screenshotStartedAt, {
        label: safeLabel,
        ok: false,
        message: error instanceof Error ? error.message.slice(0, 120) : "debug_screenshot_failed",
        hotpatch: "r9c",
      });
      return undefined;
    }
  };
  let smsApiSeen = false;
  let closed = false;
  let lastSendCodeAttemptAt = 0;
  /** 最近一次 check_qrconnect 解析结果（网络拦截，避免仅依赖页内 CORS fetch） */
  let lastCheckStatus: DouyinQRCodeStatus | undefined;
  let lastCheckAt = 0;

  // r9c：出码阶段禁用资源 abort（route 可能干扰 jssdk/get_qrcode）
  // 保留注释占位；需要限流时仅拦 image/media/font/analytics，勿拦 stylesheet/script

  const onResponse = (response: PlaywrightResponse) => {
    const url = response.url();
    if (url.includes(SEND_CODE_PATH) && response.status() >= 200 && response.status() < 300) {
      // 仅标记观测；不读 body 值
      void response
        .text()
        .then((body) => {
          const json = parseJsonBody(body);
          if (isRecord(json) && (json.message === "success" || json.error_code === 0)) {
            smsApiSeen = true;
          } else if (isRecord(json) && isRecord(json.data) && json.data.mobile_ticket) {
            smsApiSeen = true;
          }
        })
        .catch(() => {
          // ignore
        });
    }
    // 缓存 jssdk / 主动 check 的 passport 响应，供 poll 使用
    if (url.includes(PASSPORT_CHECK_PATH) && response.status() >= 200 && response.status() < 300) {
      void response
        .text()
        .then((body) => {
          const json = parseJsonBody(body);
          if (json === undefined) {
            return;
          }
          const status = extractQRCodeStatus(json);
          if (status !== undefined) {
            lastCheckStatus = status;
            lastCheckAt = Date.now();
          }
        })
        .catch(() => {
          // ignore
        });
    }
  };
  page.on("response", onResponse);

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    const closeStartedAt = Date.now();
    page.off?.("response", onResponse);
    try {
      await context.close();
    } catch {
      // ignore
    }
    try {
      await browser.close();
    } catch {
      // ignore
    }
    phaseLog("browser_close", closeStartedAt, { ok: true });
  };

  const acquireQR = async (): Promise<SessionAcquireResult> => {
    if (closed) {
      throw new DouyinSessionEngineError("engine_unavailable", "会话运行时已关闭。");
    }

    let resolveDone: ((value: SessionAcquireResult) => void) | undefined;
    let rejectDone: ((error: Error) => void) | undefined;
    const done = new Promise<SessionAcquireResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    let settled = false;
    const settleOk = (value: SessionAcquireResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveDone?.(value);
    };
    const settleErr = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      rejectDone?.(error);
    };

    // 裸 passport 请求常无 a_bogus，可能回 4031；不得因此 settleErr，否则会打断 jssdk 自然出码。
    // 仅成功 extract 才 settleOk；4031 只记日志，最终超时再走 browser_timeout。
    let sawRisk4031 = false;
    const applyJsonBody = (body: string, contentType: string): boolean => {
      if (!contentType.includes("application/json") && !/^\s*\{/.test(body)) {
        return false;
      }
      const json = parseJsonBody(body);
      if (json === undefined) {
        return false;
      }
      const hit = tryExtractAcquireFromJson(json);
      if (hit === "risk_4031") {
        sawRisk4031 = true;
        phaseLog("risk_4031", Date.now(), {
          hit: true,
          settle: "deferred",
          hotpatch: "r9c-non-terminal",
        });
        return false;
      }
      if (hit) {
        settleOk(hit);
        return true;
      }
      return false;
    };

    const handler = async (response: PlaywrightResponse) => {
      const url = response.url();
      // 只认 passport get_qrcode JSON；忽略 SSO HTML 壳页本身
      if (!url.includes(PASSPORT_GET_QRCODE_PATH)) {
        return;
      }
      const t0 = Date.now();
      let body = "";
      try {
        body = await response.text();
      } catch {
        phaseLog("passport_get_qrcode_net", t0, {
          ok: false,
          err: "response_text_failed",
          status: response.status(),
          hotpatch: "r9c",
        });
        return;
      }
      const ct = response.headers()["content-type"] ?? "";
      const applied = applyJsonBody(body, ct);
      phaseLog("passport_get_qrcode_net", t0, {
        ok: true,
        status: response.status(),
        bodyLen: body.length,
        applied,
        sawRisk4031,
        settled,
        ct: String(ct).slice(0, 40),
        head: body.slice(0, 80).replace(/\s+/g, " "),
        hotpatch: "r9c",
      });
    };

    page.on("response", handler);

    const acquireStartedAt = Date.now();
    // r9c：SSO full 自然 jssdk 出码；hard goto 二次机会；禁止 login_page 空耗；禁止 evaluate 裸 fetch（4031）
    let evaluateAttempt = 0;
    let naturalSettled = false;
    let naturalWaitMs = 0;
    let didEvaluate = false;
    let entryUsed = "sso_full";
    let reloadCount = 0;

    const sleepMs = async (ms: number): Promise<void> => {
      if (page.waitForTimeout) {
        try {
          await page.waitForTimeout(ms);
          return;
        } catch {
          // page closed
        }
      }
      await sleep(ms);
    };
    const currentUrl = (): string => {
      try {
        return typeof page.url === "function" ? String(page.url()) : "";
      } catch {
        return "";
      }
    };
    const waitQrResponse = async (timeoutMs: number, via: string): Promise<boolean> => {
      if (settled || closed) {
        return settled;
      }
      if (!page.waitForResponse) {
        await Promise.race([
          done.then(() => {
            naturalSettled = true;
          }).catch(() => undefined),
          sleepMs(timeoutMs),
        ]);
        return settled;
      }
      const t0 = Date.now();
      try {
        const resp = await page.waitForResponse((r) => {
          try {
            return String(r.url()).includes(PASSPORT_GET_QRCODE_PATH);
          } catch {
            return false;
          }
        }, { timeout: timeoutMs });
        let body = "";
        try {
          body = await resp.text();
        } catch {
          body = "";
        }
        const ct = (resp.headers && resp.headers()["content-type"]) || "application/json";
        const status = typeof resp.status === "function" ? resp.status() : 0;
        const applied = body ? applyJsonBody(body, ct) : false;
        phaseLog("passport_get_qrcode_net", t0, {
          ok: true,
          via,
          bodyLen: body.length,
          applied,
          status,
          sawRisk4031,
          settled,
          head: body.slice(0, 90).replace(/\s+/g, " "),
          hotpatch: "r9c",
        });
        return settled;
      } catch (e) {
        phaseLog("passport_get_qrcode_net", t0, {
          ok: false,
          via,
          err: e instanceof Error ? e.message.slice(0, 90) : "wait_failed",
          hotpatch: "r9c",
        });
        return false;
      }
    };
    const waitNaturalBudget = async (budgetMs: number, via: string): Promise<boolean> => {
      const end = Date.now() + budgetMs;
      while (!settled && !closed && Date.now() < end) {
        const remain = Math.max(400, end - Date.now());
        await waitQrResponse(Math.min(remain, 6_000), via);
        if (settled) {
          return true;
        }
        if (!settled && Date.now() < end) {
          await Promise.race([
            done.then(() => {
              naturalSettled = true;
            }).catch(() => undefined),
            sleepMs(150),
          ]);
        }
      }
      return settled;
    };

    phaseLog("session_start", acquireStartedAt, { acquireTimeoutMs, hotpatch: "r9c" });
    try {
      // WAVE/R6：wave12 仅 creator 轻入口，失败跳过直接 SSO（禁止 self/follow 多候选）
      try {
        await page.goto("https://creator.douyin.com/", {
          waitUntil: "domcontentloaded",
          timeout: 2500,
        });
        await sleepMs(150);
        phaseLog("wave12_prewarm", Date.now(), {
          url: "https://creator.douyin.com/",
          hotpatch: "wave12_r6",
        });
      } catch {
        phaseLog("wave12_prewarm_skip", Date.now(), {
          url: "https://creator.douyin.com/",
          hotpatch: "wave12_r6",
        });
      }

      entryUsed = "sso_full";
      // WAVE/R6：SSO 用 domcontentloaded + 20s 顶；成功后 sleep 300 给 jssdk 启动（R5_GLUE）
      await page.goto(SSO_HTML_URL, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(acquireTimeoutMs, 20_000),
        referer: "https://www.douyin.com/",
      });
      await sleepMs(300);
      phaseLog("sso_goto", acquireStartedAt, {
        waitUntil: "domcontentloaded",
        hotpatch: "r6",
        entry: entryUsed,
        url: currentUrl().slice(0, 140),
      });

      const glueStartedAt = Date.now();
      // WAVE/R6：自然 jssdk 预算 8s（禁止 10s/15s/18s）
      await waitNaturalBudget(8_000, "wait_sso_full_1");
      naturalWaitMs = Date.now() - glueStartedAt;

      // WAVE/R6：短路 sso_reload / sso_hard_goto（无效且慢），直接 Wave13
      if (!settled && !closed) {
        phaseLog("sso_reload_hard_skipped", Date.now(), {
          reason: "ineffective_and_slow",
          hotpatch: "r6",
        });
      }

      // 故意不 page.evaluate 裸 fetch：日志证明只带来 4031，不提高真码率

      phaseLog("glue_wait", glueStartedAt, {
        glueWaitMs,
        naturalWaitMs,
        settled,
        naturalSettled: naturalSettled || settled,
        sawRisk4031,
        glueTriggerCount: 0,
        evaluateAttempt,
        didEvaluate,
        entryUsed,
        reloadCount,
        elapsed: Date.now() - glueStartedAt,
        hotpatch: "r9c",
        maxEvaluate: 0,
        url: currentUrl().slice(0, 140),
      });

      // HOTPATCH_WAVE13_QR_FALLBACK
      if (!settled && !closed) {
        const wave13StartedAt = Date.now();
        try {
          await Promise.race([
            (async () => {
              const extracted = await page.evaluate(() => {
                const pickToken = (s: string | null | undefined): string => {
                  if (!s || typeof s !== "string") {
                    return "";
                  }
                  let m = s.match(/[?&#]token=([A-Za-z0-9_\-%.]+)/);
                  if (m?.[1]) {
                    return decodeURIComponent(m[1]);
                  }
                  m = s.match(/["']token["']\s*:\s*["']([A-Za-z0-9_\-%.]+)["']/);
                  if (m?.[1]) {
                    return m[1];
                  }
                  return "";
                };
                let token = pickToken(location.href) || "";
                let qrCode = "";
                let method = "";
                const selectors = [
                  "div#animate_qrcode_container img",
                  'img[aria-label="二维码"]',
                  'img[alt*="二维码"]',
                  'img[src^="data:image/"]',
                  'img[src^="blob:"]',
                ];
                let img: HTMLImageElement | null = null;
                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && el.tagName === "IMG") {
                    img = el as HTMLImageElement;
                    break;
                  }
                }
                if (img) {
                  const src = img.getAttribute("src") || img.src || "";
                  if (!token) {
                    token = pickToken(src);
                  }
                  if (src.startsWith("data:image/")) {
                    qrCode = src;
                    method = "img_data";
                  } else if (src.startsWith("http") || src.startsWith("blob:")) {
                    qrCode = src;
                    method = src.startsWith("blob:") ? "img_blob" : "img_http";
                  }
                }
                if (!qrCode) {
                  const canvas = document.querySelector("canvas");
                  if (canvas && typeof canvas.toDataURL === "function") {
                    try {
                      const dataUrl = canvas.toDataURL("image/png");
                      if (dataUrl && dataUrl.startsWith("data:image/")) {
                        qrCode = dataUrl;
                        method = "canvas";
                      }
                    } catch {
                      // ignore canvas toDataURL failures
                    }
                  }
                }
                if (!token) {
                  try {
                    const iframes = document.querySelectorAll("iframe");
                    for (const fr of iframes) {
                      const fs = fr.getAttribute("src") || "";
                      const t = pickToken(fs);
                      if (t) {
                        token = t;
                        break;
                      }
                    }
                  } catch {
                    // ignore iframe token scan
                  }
                }
                if (!token) {
                  try {
                    const html =
                      (document.documentElement && document.documentElement.innerHTML) ||
                      "";
                    const slice = html.slice(0, 200_000);
                    token = pickToken(slice) || "";
                  } catch {
                    // ignore html token scan
                  }
                }
                return { token: token || "", qrCode: qrCode || "", method: method || "" };
              });
              if (!extracted || !extracted.token || !extracted.qrCode) {
                // 非阻塞：截图失败不得占 remain 注册预算
                void writeDebugScreenshot("wave13_qr_fallback_miss").catch(() => undefined);
                phaseLog("wave13_qr_fallback_miss", wave13StartedAt, {
                  hotpatch: "wave13",
                  reason: !extracted
                    ? "no_extract"
                    : !extracted.token
                      ? "no_token"
                      : "no_qr",
                  method: extracted?.method ?? "",
                });
                return;
              }
              let token = String(extracted.token);
              let qrCode = String(extracted.qrCode);
              let method = extracted.method || "dom";
              if (
                (qrCode.startsWith("http") || qrCode.startsWith("blob:")) &&
                !qrCode.startsWith("data:")
              ) {
                try {
                  const asData = await page.evaluate(async (src: string) => {
                    try {
                      const resp = await fetch(src);
                      const blob = await resp.blob();
                      return await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result || ""));
                        reader.onerror = () => reject(new Error("fr_fail"));
                        reader.readAsDataURL(blob);
                      });
                    } catch {
                      return "";
                    }
                  }, qrCode);
                  if (asData && asData.startsWith("data:image/")) {
                    qrCode = asData;
                    method = `${method}_to_data`;
                  }
                } catch {
                  // keep original qrCode
                }
              }
              if (!settled && !closed) {
                const qrcodeField =
                  qrCode.startsWith("data:") ||
                  (!qrCode.startsWith("http") && !qrCode.startsWith("blob:"))
                    ? qrCode.startsWith("data:")
                      ? qrCode.split(",")[1] || qrCode
                      : qrCode
                    : undefined;
                const indexUrlField =
                  qrCode.startsWith("http") || qrCode.startsWith("blob:")
                    ? qrCode
                    : undefined;
                const payload = {
                  data: {
                    token,
                    qrcode: qrcodeField,
                    qrcode_index_url: indexUrlField,
                  },
                };
                const hit = tryExtractAcquireFromJson(payload);
                if (hit && typeof hit === "object") {
                  settleOk(hit);
                  phaseLog("wave13_qr_fallback_ok", wave13StartedAt, {
                    hotpatch: "wave13",
                    method,
                    tokenPrefix: hit.tokenPrefix || tokenPrefixOf(token),
                  });
                  return;
                }
                settleOk({
                  token,
                  qrCode,
                  tokenPrefix: tokenPrefixOf(token),
                });
                phaseLog("wave13_qr_fallback_ok", wave13StartedAt, {
                  hotpatch: "wave13",
                  method: `${method}_direct`,
                  tokenPrefix: tokenPrefixOf(token),
                });
              }
            })(),
            new Promise<void>((resolve) => {
              setTimeout(resolve, 1500);
            }),
          ]);
        } catch (e) {
          phaseLog("wave13_qr_fallback_error", wave13StartedAt, {
            hotpatch: "wave13",
            err: e instanceof Error ? e.message.slice(0, 120) : "wave13_fail",
          });
        }
      }

      const elapsedTotal = Date.now() - acquireStartedAt;
      // 禁止 Math.min(acquireTimeoutMs, 40_000) 双重硬顶
      const remain = Math.max(200, acquireTimeoutMs - elapsedTotal);
      const timer = setTimeout(() => {
        if (sawRisk4031 && !settled) {
          settleErr(
            new DouyinRiskBlockedError(
              4031,
              "抖音返回安全风险拦截（error_code=4031），同会话出码被拒绝。",
            ),
          );
          return;
        }
        settleErr(
          new DouyinSessionEngineError(
            "browser_timeout",
            `同会话出码超时（${acquireTimeoutMs}ms）。`,
          ),
        );
      }, remain);

      try {
        const result = await done;
        phaseLog("acquire_qr", acquireStartedAt, {
          ok: true,
          tokenPrefix: result.tokenPrefix,
          naturalWaitMs,
          didEvaluate,
          evaluateAttempt,
          entryUsed,
          reloadCount,
          hotpatch: "r9c",
        });
        void writeDebugScreenshot("after_acquire_qr");
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      let pageUrl = "";
      try {
        pageUrl = currentUrl();
      } catch {
        pageUrl = "";
      }
      try {
        void writeDebugScreenshot("acquire_fail");
      } catch {
        // ignore
      }
      phaseLog("acquire_qr", acquireStartedAt, {
        ok: false,
        sawRisk4031,
        naturalWaitMs,
        didEvaluate,
        evaluateAttempt,
        naturalSettled,
        entryUsed,
        reloadCount,
        errorName: error instanceof Error ? error.name : "unknown",
        ...(error instanceof DouyinRiskBlockedError
          ? { errorCode: error.errorCode }
          : error instanceof DouyinSessionEngineError
            ? { errorCode: error.code }
            : {}),
        message: error instanceof Error ? error.message.slice(0, 240) : String(error),
        pageUrl: String(pageUrl).slice(0, 200),
        textSummary: "",
        screenshot: "acquire_fail",
        hotpatch: "r9c-diag",
      });
      if (error instanceof DouyinSessionEngineError || error instanceof DouyinRiskBlockedError) {
        throw error;
      }
      if (error instanceof Error && /timeout/i.test(error.message)) {
        throw new DouyinSessionEngineError("browser_timeout", error.message, { cause: error });
      }
      throw new DouyinSessionEngineError(
        "qr_unavailable",
        "同会话未能获取有效登录二维码。",
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      page.off?.("response", handler);
    }
  };

  /**
   * 进入 2046 后：同 Playwright page 主动触发官方 POST send_code。
   * 优先 UI「接收短信验证码」；回退页内 fetch（浏览器会话 cookie，禁止 Node 拼 a_bogus）。
   * smsApiSeen 只由 onResponse 成功拦截置 true。
   */
  const ensureOfficialSendCode = async (): Promise<void> => {
    if (closed || smsApiSeen) {
      return;
    }
    const now = Date.now();
    if (now - lastSendCodeAttemptAt < 3000) {
      return;
    }
    lastSendCodeAttemptAt = now;
    const sendStartedAt = now;
    const sendCodeUrl = `https://www.douyin.com${SEND_CODE_PATH}/`;

    type SmsClickResult =
      | {
          readonly kind: "ui_click_receive_sms_hotfix_20260718";
          readonly marker: "HOTFIX-DOUYIN-SMS-RECEIVE-20260718";
          readonly candidateCount: number;
          readonly textCategory: string;
          readonly targetType: string;
          readonly matchedReceiveSms: true;
        }
      | {
          readonly kind: "none";
          readonly marker: "HOTFIX-DOUYIN-SMS-RECEIVE-20260718";
          readonly candidateCount: number;
          readonly matchedReceiveSms: false;
        };

    const clickReceiveSmsInContext = async (
      target: { evaluate: (fn: (arg?: string) => unknown, arg?: string) => Promise<unknown> },
    ): Promise<SmsClickResult> => {
      const result = await target.evaluate(() => {
        const marker = "HOTFIX-DOUYIN-SMS-RECEIVE-20260718" as const;
        type TextCategory =
          | "exact_receive_sms_code"
          | "exact_receive_sms_verify"
          | "contains_receive_sms_code"
          | "contains_receive_sms_verify"
          | "contains_receive_sms";
        type Candidate = {
          readonly textCategory: TextCategory;
          readonly textRank: number;
          readonly targetType: string;
          readonly targetRank: number;
          readonly sourceRank: number;
          readonly targetText: string;
          readonly target: HTMLElement;
        };

        const normalizeText = (value: string | undefined): string => (value ?? "").trim().replace(/\s+/g, " ");

        const categorizeReceiveSmsText = (text: string): { readonly category: TextCategory; readonly rank: number } | undefined => {
          if (/发送短信验证/.test(text)) {
            return undefined;
          }
          if (text === "接收短信验证码") {
            return { category: "exact_receive_sms_code", rank: 0 };
          }
          if (text === "接收短信验证") {
            return { category: "exact_receive_sms_verify", rank: 1 };
          }
          if (text.includes("接收短信验证码")) {
            return { category: "contains_receive_sms_code", rank: 2 };
          }
          if (text.includes("接收短信验证")) {
            return { category: "contains_receive_sms_verify", rank: 3 };
          }
          if (text.includes("接收短信")) {
            return { category: "contains_receive_sms", rank: 4 };
          }
          return undefined;
        };

        const isVisible = (el: HTMLElement): boolean => {
          const rect = el.getBoundingClientRect?.();
          if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
            return false;
          }
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };

        const getTargetType = (el: HTMLElement): { readonly type: string; readonly rank: number } | undefined => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          if (tag === "button") {
            return { type: "button", rank: 0 };
          }
          if (role === "button") {
            return { type: "role_button", rank: 1 };
          }
          if (tag === "a") {
            return { type: "a", rank: 2 };
          }
          if (typeof el.onclick === "function") {
            return { type: "onclick", rank: 3 };
          }
          if (getComputedStyle(el).cursor === "pointer") {
            return { type: "cursor_pointer", rank: 4 };
          }
          if (el.tabIndex >= 0) {
            return { type: "tabindex", rank: 5 };
          }
          return undefined;
        };

        const findClickableTarget = (el: HTMLElement): { readonly target: HTMLElement; readonly sourceRank: number } | undefined => {
          const closest = el.closest("button,[role='button'],a");
          if (closest instanceof HTMLElement && isVisible(closest) && getTargetType(closest) !== undefined) {
            return { target: closest, sourceRank: closest === el ? 0 : 1 };
          }
          let current: HTMLElement | null = el;
          for (let depth = 0; depth <= 5 && current !== null; depth += 1) {
            if (isVisible(current) && getTargetType(current) !== undefined) {
              return { target: current, sourceRank: current === el ? 0 : 2 };
            }
            current = current.parentElement;
          }
          return undefined;
        };

        const dispatchHumanClick = (el: HTMLElement) => {
          const rect = el.getBoundingClientRect?.() ?? { x: 0, y: 0, width: 0, height: 0 };
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
            el.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                buttons: 1,
              }),
            );
          }
          try {
            el.click();
          } catch {
            /* click may throw on detached node */
          }
        };

        const nodes = Array.from(document.querySelectorAll("a,button,[role=button],div,span,li"));
        const candidates: Candidate[] = [];
        for (const el of nodes) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) {
            continue;
          }
          const text = normalizeText(el.innerText);
          const textMatch = categorizeReceiveSmsText(text);
          if (textMatch === undefined) {
            continue;
          }
          const clickableTarget = findClickableTarget(el);
          if (clickableTarget === undefined) {
            continue;
          }
          const targetText = normalizeText(clickableTarget.target.innerText);
          if (/发送短信验证/.test(targetText)) {
            continue;
          }
          const targetType = getTargetType(clickableTarget.target);
          if (targetType === undefined) {
            continue;
          }
          candidates.push({
            textCategory: textMatch.category,
            textRank: textMatch.rank,
            targetType: targetType.type,
            targetRank: targetType.rank,
            sourceRank: clickableTarget.sourceRank,
            targetText,
            target: clickableTarget.target,
          });
        }
        candidates.sort(
          (left, right) =>
            left.textRank - right.textRank ||
            left.targetRank - right.targetRank ||
            left.sourceRank - right.sourceRank ||
            left.targetText.localeCompare(right.targetText),
        );
        const selected = candidates[0];
        if (selected === undefined) {
          return { kind: "none", marker, candidateCount: 0, matchedReceiveSms: false };
        }
        dispatchHumanClick(selected.target);
        return {
          kind: "ui_click_receive_sms_hotfix_20260718",
          marker,
          candidateCount: candidates.length,
          textCategory: selected.textCategory,
          targetType: selected.targetType,
          matchedReceiveSms: true,
        };
      });
      if (
        typeof result === "object" &&
        result !== null &&
        "kind" in result &&
        result.kind === "ui_click_receive_sms_hotfix_20260718" &&
        "candidateCount" in result &&
        typeof result.candidateCount === "number" &&
        "textCategory" in result &&
        typeof result.textCategory === "string" &&
        "targetType" in result &&
        typeof result.targetType === "string"
      ) {
        return {
          kind: "ui_click_receive_sms_hotfix_20260718",
          marker: "HOTFIX-DOUYIN-SMS-RECEIVE-20260718",
          candidateCount: result.candidateCount,
          textCategory: result.textCategory,
          targetType: result.targetType,
          matchedReceiveSms: true,
        };
      }
      return {
        kind: "none",
        marker: "HOTFIX-DOUYIN-SMS-RECEIVE-20260718",
        candidateCount: 0,
        matchedReceiveSms: false,
      };
    };

    try {
      const frames = typeof page.frames === "function" ? page.frames() : [];
      type SmsClickEvaluateTarget = {
        evaluate: (fn: (arg?: string) => unknown, arg?: string) => Promise<unknown>;
      };
      const targets: SmsClickEvaluateTarget[] = [
        page as unknown as SmsClickEvaluateTarget,
        ...(frames as unknown as SmsClickEvaluateTarget[]),
      ];

      let uiClickResult: SmsClickResult = {
        kind: "none",
        marker: "HOTFIX-DOUYIN-SMS-RECEIVE-20260718",
        candidateCount: 0,
        matchedReceiveSms: false,
      };
      for (const target of targets) {
        try {
          const clickResult = await clickReceiveSmsInContext(target);
          if (clickResult.kind !== "none") {
            uiClickResult = clickResult;
            break;
          }
        } catch {
          /* cross-origin / unloaded frame */
        }
        if (smsApiSeen) {
          break;
        }
      }

      if (uiClickResult.kind === "none" && !smsApiSeen) {
        await page.evaluate(async (url: string) => {
          try {
            await fetch(url, {
              method: "POST",
              credentials: "include",
              headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: "",
            });
            return "page_fetch";
          } catch {
            return "page_fetch_error";
          }
        }, sendCodeUrl);
      }

      for (let i = 0; i < 15 && !smsApiSeen; i += 1) {
        await sleep(200);
      }
      const uiClickExtra: Record<string, string | number | boolean> =
        uiClickResult.kind !== "none"
          ? {
              textCategory: uiClickResult.textCategory,
              targetType: uiClickResult.targetType,
            }
          : {};
      phaseLog("send_code_trigger", sendStartedAt, {
        ok: true,
        smsApiSeen,
        via: uiClickResult.kind !== "none" ? uiClickResult.kind : "same_session_page",
        matchedReceiveSms: uiClickResult.matchedReceiveSms,
        candidateCount: uiClickResult.candidateCount,
        ...uiClickExtra,
      });
    } catch {
      phaseLog("send_code_trigger", sendStartedAt, {
        ok: false,
        smsApiSeen,
        via: "same_session_page",
      });
    }
  };

  const checkStatus = async (token: string): Promise<DouyinQRCodeStatus | undefined> => {
    if (closed) {
      return undefined;
    }
    const checkStartedAt = Date.now();
    const checkURL = buildSessionCheckURL(token);

    // 1) 页内 fetch（同会话 cookie；失败不抛，交给缓存 / Node 回退）
    try {
      const result = await Promise.race([
        page.evaluate(async (url) => {
          const res = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json, text/plain, */*" },
          });
          const text = await res.text();
          return { status: res.status, text };
        }, checkURL),
        sleep(Math.min(checkTimeoutMs, 8_000)).then(() => {
          throw new DouyinSessionEngineError(
            "browser_timeout",
            `同会话 check 超时（${Math.min(checkTimeoutMs, 8_000)}ms）。`,
          );
        }),
      ]);
      const json = parseJsonBody(result.text);
      if (json !== undefined) {
        const status = extractQRCodeStatus(json);
        if (status !== undefined) {
          lastCheckStatus = status;
          lastCheckAt = Date.now();
          phaseLog("check_status", checkStartedAt, {
            via: "page.evaluate",
            kind: status.kind,
            ok: true,
          });
          if (status.kind === "need_app_verify") {
            await ensureOfficialSendCode();
          }
          return status;
        }
      }
    } catch (error) {
      if (error instanceof DouyinSessionEngineError && error.code === "browser_timeout") {
        phaseLog("check_status", checkStartedAt, { via: "page.evaluate", ok: false, timeout: true });
      } else {
        phaseLog("check_status", checkStartedAt, { via: "page.evaluate", ok: false });
      }
    }

    // 3) 网络拦截缓存：
    // - scanned/need_app_verify/confirmed/expired：可信任至 15s
    // - waiting：仅信任极短窗口，避免挡住扫码后的真实状态
    if (lastCheckStatus !== undefined) {
      const ageMs = Date.now() - lastCheckAt;
      const maxAgeMs = lastCheckStatus.kind === "waiting" ? 1_200 : 15_000;
      if (ageMs < maxAgeMs) {
        phaseLog("check_status", checkStartedAt, {
          via: "network_cache",
          kind: lastCheckStatus.kind,
          ok: true,
          ageMs,
        });
        if (lastCheckStatus.kind === "need_app_verify") {
          await ensureOfficialSendCode();
        }
        return lastCheckStatus;
      }
    }

    phaseLog("check_status", checkStartedAt, { ok: false, kind: "undefined" });
    return undefined;
  };

  const openRedirectURL = async (url: string): Promise<void> => {
    if (closed) {
      throw new DouyinSessionEngineError("engine_unavailable", "会话运行时已关闭。");
    }
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(1500);
  };

  const getCookies = async (): Promise<readonly SessionCookie[]> => {
    const cookies = await context.cookies();
    return cookies
      .filter((c) => {
        const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
        return domain === "douyin.com" || domain.endsWith(".douyin.com");
      })
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
  };

  const submitSmsCode = async (
    code: string,
  ): Promise<{
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly hostPath?: string;
    readonly message?: string;
  }> => {
    if (closed) {
      return { attempted: false, ok: false, message: "session_closed" };
    }
    const hostPath = `https://www.douyin.com${VALIDATE_CODE_PATH}/`;
    const validateStartedAt = Date.now();
    let validateRequestSeen = false;
    const validateResponsePromise = new Promise<ValidateCodeObservation>((resolve) => {
      let settled = false;
      const finish = (result: ValidateCodeObservation) => {
        if (settled) {
          return;
        }
        settled = true;
        page.off?.("response", handler);
        resolve(result);
      };
      const handler = (response: PlaywrightResponse) => {
        if (!response.url().includes(VALIDATE_CODE_PATH)) {
          return;
        }
        validateRequestSeen = true;
        phaseLog("validate_code_request_seen", validateStartedAt, {
          hostPath,
          method: response.request().method(),
        });
        phaseLog("validate_code_response_seen", validateStartedAt, {
          hostPath,
          status: response.status(),
        });
        void response
          .text()
          .then((body) => {
            const result = summarizeValidateCodeResponse(response, body);
            phaseLog("validate_code_response_parse", validateStartedAt, {
              hostPath,
              ok: result.ok,
              status: result.status ?? response.status(),
              message: result.message,
            });
            finish(result);
          })
          .catch(() => {
            phaseLog("validate_code_response_parse", validateStartedAt, {
              hostPath,
              ok: false,
              status: response.status(),
              message: "validate_code_response_parse_failed",
            });
            finish({
              requestSeen: true,
              responseSeen: true,
              status: response.status(),
              ok: false,
              message: "validate_code_response_parse_failed",
            });
          });
      };
      page.on("response", handler);
      void sleep(validateCodeTimeoutMs).then(() => {
        if (settled) {
          return;
        }
        phaseLog("validate_code_submit_timeout", validateStartedAt, {
          hostPath,
          requestSeen: validateRequestSeen,
        });
        finish({
          requestSeen: validateRequestSeen,
          responseSeen: false,
          ok: false,
          message: "validate_code_submit_timeout",
        });
      });
    });
    type SubmitCodeResult = {
      readonly filled: boolean;
      readonly clicked: boolean;
      readonly candidateCount: number;
      readonly candidates?: readonly Record<string, unknown>[];
      readonly selectedIndex?: number;
      readonly inputIndex?: number;
      readonly inputClickPoint?: { readonly x: number; readonly y: number };
      readonly clickPoint?: { readonly x: number; readonly y: number };
      readonly valueLength?: number;
      readonly contextKind?: string;
      readonly placeholderKind?: string;
      readonly maxLength?: number;
      readonly visible?: boolean;
      readonly disabled?: boolean;
      readonly readOnly?: boolean;
      readonly bbox?: string;
      readonly buttonCandidateCount?: number;
      readonly buttonSelectedIndex?: number;
      readonly buttonContextKind?: string;
      readonly buttonBbox?: string;
      readonly buttonDisabled?: boolean;
      readonly outcome?: string;
      readonly reason?: string;
    };
    const isSubmitCodeResult = (value: unknown): value is SubmitCodeResult => {
      if (!isRecord(value)) {
        return false;
      }
      if (typeof value.filled !== "boolean" || typeof value.clicked !== "boolean" || typeof value.candidateCount !== "number") {
        return false;
      }
      if (value.clickPoint === undefined) {
        return true;
      }
      return isRecord(value.clickPoint) && typeof value.clickPoint.x === "number" && typeof value.clickPoint.y === "number";
    };
    const submitInContext = async (target: Pick<PlaywrightPage, "evaluate" | "locator">): Promise<boolean> => {
      const probeStartedAt = Date.now();
      const logTargetSelection = (result: SubmitCodeResult | undefined, outcome: string, reason: string) => {
        phaseLog("sms_code_input_candidates", probeStartedAt, {
          codeLength: code.length,
          candidateCount: result?.candidateCount ?? 0,
          selectedIndex: result?.selectedIndex ?? -1,
          candidates: JSON.stringify(result?.candidates ?? []),
          outcome,
          reason,
        });
        phaseLog("sms_code_target_selected", probeStartedAt, {
          codeLength: code.length,
          valueLength: result?.valueLength ?? 0,
          candidateCount: result?.candidateCount ?? 0,
          selectedIndex: result?.selectedIndex ?? -1,
          contextKind: result?.contextKind ?? "unknown",
          placeholderKind: result?.placeholderKind ?? "unknown",
          maxLength: result?.maxLength ?? -1,
          visible: result?.visible ?? false,
          disabled: result?.disabled ?? false,
          readOnly: result?.readOnly ?? false,
          bbox: result?.bbox ?? "unknown",
          outcome,
          reason,
        });
      };
      const logButtonProbe = (result: SubmitCodeResult | undefined, outcome: string, reason: string) => {
        phaseLog("sms_code_button_probe", probeStartedAt, {
          candidateCount: result?.buttonCandidateCount ?? 0,
          selectedIndex: result?.buttonSelectedIndex ?? -1,
          contextKind: result?.buttonContextKind ?? "unknown",
          bbox: result?.buttonBbox ?? "unknown",
          buttonDisabled: result?.buttonDisabled ?? false,
          outcome,
          reason,
        });
      };
      const submitWithLocatorFallback = async (reason: string): Promise<boolean> => {
        if (target.locator === undefined) {
          return false;
        }
        const input = target.locator(
          'input:visible[placeholder*="验证码"],input:visible[autocomplete="one-time-code"],input:visible[inputmode="numeric"][maxlength="6"],input:visible[maxlength="6"]',
        ).first();
        if ((await input.count()) === 0 || input.fill === undefined) {
          phaseLog("sms_code_submit_probe", probeStartedAt, {
            method: "locator_fallback",
            inputCount: 0,
            codeLength: code.length,
            outcome: "continue",
            reason,
          });
          return false;
        }
        await input.fill(code, { timeout: 3_000 });
        const valueLength = input.inputValue === undefined ? code.length : (await input.inputValue({ timeout: 1_000 })).length;
        if (valueLength !== code.length) {
          phaseLog("sms_code_submit_probe", probeStartedAt, {
            method: "locator_fallback",
            inputCount: 1,
            valueLength,
            codeLength: code.length,
            outcome: "continue",
            reason: "value_not_stuck",
          });
          return false;
        }
        const verifyButton = target.locator("button,[role=button],a,div,span").filter({ hasText: /^(验证|确定|提交|完成|提交验证码)$/ }).first();
        if ((await verifyButton.count()) === 0) {
          phaseLog("sms_code_submit_probe", probeStartedAt, {
            method: "locator_fallback",
            inputCount: 1,
            valueLength,
            codeLength: code.length,
            outcome: "continue",
            reason: "button_missing",
          });
          return false;
        }
        const buttonDisabled = verifyButton.isDisabled === undefined ? false : await verifyButton.isDisabled({ timeout: 1_000 });
        if (buttonDisabled) {
          phaseLog("sms_code_submit_probe", probeStartedAt, {
            method: "locator_fallback",
            inputCount: 1,
            valueLength,
            codeLength: code.length,
            buttonDisabled,
            outcome: "continue",
            reason: "button_disabled",
          });
          return false;
        }
        await verifyButton.click({ force: true, timeout: 3_000 });
        phaseLog("sms_code_submit_probe", probeStartedAt, {
          method: "locator_fallback",
          inputCount: 1,
          valueLength,
          codeLength: code.length,
          buttonDisabled,
          outcome: "clicked",
          reason,
        });
        return true;
      };
      const runDomProbe = async (
        mode: "fill" | "verify",
        inputIndex: number | undefined,
        clickButton: boolean,
      ): Promise<unknown> => target.evaluate((payload) => {
        const digits = payload.digits;
        const codeLength = digits.length;
        const normalizeText = (value: string | undefined): string => (value ?? "").trim().replace(/\s+/g, " ");
        const bboxOf = (el: HTMLElement): string => {
          const rect = el.getBoundingClientRect();
          return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
        };
        const isVisible = (el: HTMLElement): boolean => {
          const rect = el.getBoundingClientRect?.();
          if (rect === undefined || rect.width <= 0 || rect.height <= 0) {
            return false;
          }
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const propsOf = (input: HTMLInputElement): { readonly onChange?: (event: unknown) => void } | undefined => {
          const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
          const fiberKey = Object.keys(input).find(
            (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"),
          );
          const directProps = propsKey
            ? ((input as unknown as Record<string, unknown>)[propsKey] as
                | { readonly onChange?: (event: unknown) => void }
                | undefined)
            : undefined;
          if (directProps?.onChange !== undefined) {
            return directProps;
          }
          let fiber = fiberKey ? (input as unknown as Record<string, { readonly return?: unknown }>)[fiberKey] : undefined;
          for (let depth = 0; depth < 8 && fiber !== undefined; depth += 1) {
            const maybeProps = (fiber as { readonly memoizedProps?: unknown; readonly pendingProps?: unknown }).memoizedProps ??
              (fiber as { readonly pendingProps?: unknown }).pendingProps;
            if (
              typeof maybeProps === "object" &&
              maybeProps !== null &&
              "onChange" in maybeProps &&
              typeof (maybeProps as { readonly onChange?: unknown }).onChange === "function"
            ) {
              return maybeProps as { readonly onChange?: (event: unknown) => void };
            }
            const next = fiber.return;
            fiber = typeof next === "object" && next !== null ? (next as { readonly return?: unknown }) : undefined;
          }
          return undefined;
        };
        const contextOf = (el: HTMLElement): { readonly contextKind: string; readonly root?: HTMLElement } => {
          let parent = el.parentElement;
          for (let depth = 0; depth < 12 && parent !== null; depth += 1) {
            const text = `${parent.innerText || ""} ${String(parent.className || "")}`;
            if (/短信验证|请输入验证码|身份验证|uc_verification/i.test(text)) {
              return { contextKind: "sms_verification", root: parent };
            }
            parent = parent.parentElement;
          }
          return { contextKind: "unknown" };
        };
        type InputCandidate = {
          readonly input: HTMLInputElement;
          readonly index: number;
          readonly root?: HTMLElement;
          readonly score: number;
          readonly excluded: boolean;
          readonly contextKind: string;
          readonly placeholderKind: string;
          readonly maxLength: number;
          readonly visible: boolean;
          readonly disabled: boolean;
          readonly readOnly: boolean;
          readonly valueLength: number;
          readonly bbox: string;
        };
        const inputMetaOf = (input: HTMLInputElement, index: number): InputCandidate => {
          const rect = input.getBoundingClientRect();
          const meta = `${input.placeholder ?? ""} ${input.name ?? ""} ${input.id ?? ""} ${input.autocomplete ?? ""} ${input.inputMode ?? ""} ${input.type ?? ""} ${String(input.className || "")}`;
          const visible = isVisible(input);
          const disabled = input.disabled;
          const readOnly = input.readOnly;
          const { contextKind, root } = contextOf(input);
          const placeholderKind = /验证码|verify|sms|one-time|captcha|code/i.test(meta) ? "captcha" : "unknown";
          const excluded =
            !visible ||
            disabled ||
            readOnly ||
            /手机号|手机号码|phone|mobile|area-code|web-login-area|搜索|search/i.test(meta) ||
            input.maxLength === 4 ||
            input.maxLength === 5 ||
            (input.maxLength > 0 && input.maxLength < codeLength);
          let score = 0;
          if (visible) {
            score += 10;
          }
          if (contextKind === "sms_verification") {
            score += 100;
          }
          if (input.maxLength === codeLength || input.maxLength === 6) {
            score += 40;
          }
          if (placeholderKind === "captcha") {
            score += 30;
          }
          if (/one-time-code/i.test(input.autocomplete ?? "")) {
            score += 30;
          }
          if (/numeric|decimal/i.test(input.inputMode ?? "")) {
            score += 20;
          }
          return {
            input,
            index,
            root,
            score,
            excluded,
            contextKind,
            placeholderKind,
            maxLength: input.maxLength,
            visible,
            disabled,
            readOnly,
            valueLength: input.value.length,
            bbox: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`,
          };
        };
        const allInputs = Array.from(document.querySelectorAll("input"));
        const inputNodes = allInputs.filter((node): node is HTMLInputElement => node instanceof HTMLInputElement);
        const candidates = inputNodes
          .map((input) => inputMetaOf(input, allInputs.indexOf(input)))
          .filter((candidate) => !candidate.excluded)
          .sort((left, right) => right.score - left.score || left.index - right.index);
        const summaries = candidates.slice(0, 8).map((candidate, index) => ({
          valueLength: candidate.valueLength,
          candidateCount: candidates.length,
          selectedIndex: index,
          contextKind: candidate.contextKind,
          placeholderKind: candidate.placeholderKind,
          maxLength: candidate.maxLength,
          visible: candidate.visible,
          disabled: candidate.disabled,
          readOnly: candidate.readOnly,
          bbox: candidate.bbox,
        }));
        const fillInput = (input: HTMLInputElement): void => {
          input.focus();
          input.click();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const props = propsOf(input);
          if (setter) {
            setter.call(input, "");
            setter.call(input, digits);
          } else {
            input.value = digits;
          }
          props?.onChange?.({ target: input, currentTarget: input });
          input.dispatchEvent(new Event("focus", { bubbles: true }));
          try {
            input.dispatchEvent(new InputEvent("input", { bubbles: true, data: digits, inputType: "insertText" }));
          } catch {
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const selectedByIndex = (index: number | undefined): InputCandidate | undefined => {
          if (typeof index !== "number") {
            return undefined;
          }
          const node = allInputs[index];
          return node instanceof HTMLInputElement ? inputMetaOf(node, index) : undefined;
        };
        const inputStateOf = (selected: InputCandidate, valueLength: number) => ({
          candidateCount: candidates.length,
          candidates: summaries,
          selectedIndex: candidates.findIndex((candidate) => candidate.index === selected.index),
          inputIndex: selected.index,
          inputClickPoint: {
            x: selected.input.getBoundingClientRect().x + selected.input.getBoundingClientRect().width / 2,
            y: selected.input.getBoundingClientRect().y + selected.input.getBoundingClientRect().height / 2,
          },
          valueLength,
          contextKind: selected.contextKind,
          placeholderKind: selected.placeholderKind,
          maxLength: selected.maxLength,
          visible: selected.visible,
          disabled: selected.disabled,
          readOnly: selected.readOnly,
          bbox: selected.bbox,
        });
        let selected = selectedByIndex(payload.inputIndex) ?? candidates[0];
        let valueLength = 0;
        let inputState: ReturnType<typeof inputStateOf> | undefined;
        if (selected === undefined || !(selected.input instanceof HTMLInputElement) || selected.excluded) {
          return { filled: false, clicked: false, candidateCount: candidates.length, candidates: summaries, valueLength: 0, outcome: "continue", reason: "input_missing" };
        }
        const candidatesToTry = payload.mode === "fill" && typeof payload.inputIndex !== "number" ? candidates : [selected];
        for (const candidate of candidatesToTry) {
          if (payload.mode === "fill") {
            fillInput(candidate.input);
          }
          const candidateValueLength = candidate.input.value.length;
          selected = inputMetaOf(candidate.input, candidate.index);
          valueLength = candidateValueLength;
          inputState = inputStateOf(selected, valueLength);
          if (valueLength === codeLength) {
            break;
          }
        }
        if (inputState === undefined || valueLength !== codeLength) {
          inputState ??= inputStateOf(selected, valueLength);
          return { filled: false, clicked: false, ...inputState, outcome: "continue", reason: "value_not_stuck" };
        }

        type Candidate = {
          readonly el: HTMLElement;
          readonly score: number;
          readonly buttonDisabled: boolean;
          readonly contextKind: string;
          readonly bbox: string;
        };
        const buttonCandidates: Candidate[] = [];
        for (const node of Array.from(document.querySelectorAll("button,[role=button],a,div,span"))) {
          if (!(node instanceof HTMLElement) || !isVisible(node)) {
            continue;
          }
          const text = normalizeText(node.innerText);
          if (!/^(验证|确定|提交|完成|提交验证码)$/.test(text)) {
            continue;
          }
          const className = String(node.className || "");
          const buttonDisabled =
            (node instanceof HTMLButtonElement && node.disabled) ||
            node.getAttribute("aria-disabled") === "true" ||
            /disabled|is-disabled/i.test(className);
          const buttonContext = contextOf(node);
          let score = 0;
          if (selected.root !== undefined && selected.root.contains(node)) {
            score += 100;
          }
          if (buttonContext.contextKind === "sms_verification") {
            score += 80;
          }
          if (/提交验证码|验证|确定/.test(text)) {
            score += 30;
          }
          if (/uc_verification_component_btn|primary|btn/i.test(className)) {
            score += 10;
          }
          buttonCandidates.push({ el: node, score, buttonDisabled, contextKind: buttonContext.contextKind, bbox: bboxOf(node) });
        }
        buttonCandidates.sort((left, right) => right.score - left.score);
        const buttonSelected = buttonCandidates[0];
        if (buttonSelected === undefined) {
          return { filled: true, clicked: false, ...inputState, buttonCandidateCount: 0, buttonDisabled: false, outcome: "continue", reason: "button_missing" };
        }
        const buttonSelectedIndex = buttonCandidates.indexOf(buttonSelected);
        if (buttonSelected.buttonDisabled) {
          return {
            filled: true,
            clicked: false,
            ...inputState,
            buttonCandidateCount: buttonCandidates.length,
            buttonSelectedIndex,
            buttonContextKind: buttonSelected.contextKind,
            buttonBbox: buttonSelected.bbox,
            buttonDisabled: true,
            outcome: "continue",
            reason: "button_disabled",
          };
        }
        const rect = buttonSelected.el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        if (payload.clickButton) {
          for (const type of ["pointerover", "pointerenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"] as const) {
            buttonSelected.el.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                view: window,
                buttons: 1,
              }),
            );
          }
          buttonSelected.el.click();
        }
        return {
          filled: true,
          clicked: payload.clickButton,
          ...inputState,
          clickPoint: { x, y },
          buttonCandidateCount: buttonCandidates.length,
          buttonSelectedIndex,
          buttonContextKind: buttonSelected.contextKind,
          buttonBbox: buttonSelected.bbox,
          buttonDisabled: false,
          outcome: payload.clickButton ? "clicked" : "ready",
          reason: payload.clickButton ? "clicked" : "button_ready",
        };
      }, { digits: code, mode, inputIndex, clickButton });
      let result: unknown;
      try {
        result = await runDomProbe("fill", undefined, true);
      } catch {
        phaseLog("sms_code_input_candidates", probeStartedAt, {
          codeLength: code.length,
          candidateCount: 0,
          outcome: "continue",
          reason: "evaluate_failed",
        });
        return await submitWithLocatorFallback("evaluate_failed");
      }
      if (!isSubmitCodeResult(result)) {
        return await submitWithLocatorFallback("invalid_probe_result");
      }
      logTargetSelection(result, result.outcome ?? (result.filled ? "selected" : "continue"), result.reason ?? "dom_probe");
      logButtonProbe(result, result.clicked ? "clicked" : "continue", result.reason ?? "dom_probe");
      phaseLog("sms_code_submit_probe", probeStartedAt, {
        method: "dom_evaluate",
        inputCount: result.candidateCount,
        valueLength: result.valueLength ?? 0,
        codeLength: code.length,
        buttonDisabled: result.buttonDisabled ?? false,
        outcome: result.clicked ? "clicked" : "continue",
        reason: result.reason ?? "dom_probe",
      });
      if (result.clicked && result.valueLength === code.length) {
        return true;
      }
      if (result.valueLength === code.length && result.clickPoint !== undefined && page.mouse !== undefined) {
        await page.mouse.click(result.clickPoint.x, result.clickPoint.y, { delay: 50 });
        phaseLog("sms_code_submit_probe", probeStartedAt, {
          method: "mouse_fallback",
          inputCount: result.candidateCount,
          valueLength: result.valueLength,
          codeLength: code.length,
          buttonDisabled: result.buttonDisabled ?? false,
          outcome: "clicked",
          reason: "mouse_click_fallback",
        });
        return true;
      }
      if (typeof result.inputIndex !== "number" || target.locator === undefined) {
        return await submitWithLocatorFallback("input_index_missing");
      }
      try {
        const inputLocator = target.locator("input");
        const nativeInput = inputLocator.nth === undefined ? inputLocator.first() : inputLocator.nth(result.inputIndex);
        await nativeInput.click({ force: true, timeout: 2_000 });
        if (page.keyboard !== undefined) {
          await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
          await page.keyboard.type(code, { delay: 80 });
        } else {
          await nativeInput.fill?.("", { timeout: 2_000 });
          if (nativeInput.pressSequentially !== undefined) {
            await nativeInput.pressSequentially(code, { delay: 80, timeout: 5_000 });
          } else {
            await nativeInput.type?.(code, { delay: 80, timeout: 5_000 });
          }
        }
        const verified = await runDomProbe("verify", result.inputIndex, true);
        if (!isSubmitCodeResult(verified)) {
          return false;
        }
        logTargetSelection(verified, verified.outcome ?? "continue", verified.reason ?? "fallback_verify");
        logButtonProbe(verified, verified.clicked ? "clicked" : "continue", verified.reason ?? "fallback_verify");
        phaseLog("sms_code_submit_probe", probeStartedAt, {
          method: "keyboard_fallback",
          inputCount: verified.candidateCount,
          valueLength: verified.valueLength ?? 0,
          codeLength: code.length,
          buttonDisabled: verified.buttonDisabled ?? false,
          outcome: verified.clicked ? "clicked" : "continue",
          reason: verified.reason ?? "fallback_verify",
        });
        if (verified.clicked && verified.valueLength === code.length) {
          return true;
        }
        if (verified.valueLength === code.length && page.keyboard !== undefined) {
          await page.keyboard.press("Enter");
          phaseLog("sms_code_submit_probe", probeStartedAt, {
            method: "keyboard_fallback",
            inputCount: verified.candidateCount,
            valueLength: verified.valueLength,
            codeLength: code.length,
            buttonDisabled: verified.buttonDisabled ?? false,
            outcome: "clicked",
            reason: "enter_fallback",
          });
          return true;
        }
      } catch {
        phaseLog("sms_code_submit_probe", probeStartedAt, {
          method: "keyboard_fallback",
          inputCount: result.candidateCount,
          valueLength: result.valueLength ?? 0,
          codeLength: code.length,
          buttonDisabled: result.buttonDisabled ?? false,
          outcome: "continue",
          reason: "fallback_failed",
        });
      }
      if (target.locator !== undefined) {
        const verifyButton = target.locator("button,[role=button],a,div,span").filter({ hasText: /^(验证|确定|提交|完成|提交验证码)$/ }).first();
        if ((await verifyButton.count()) > 0) {
          await verifyButton.click({ force: true, timeout: 3_000 });
          return true;
        }
      }
      if (result.clickPoint !== undefined && page.mouse !== undefined) {
        await page.mouse.click(result.clickPoint.x, result.clickPoint.y, { delay: 50 });
      }
      return true;
    };
    try {
      const targets = [...(page.frames?.() ?? []), page];
      for (const target of targets) {
        if (await submitInContext(target)) {
          break;
        }
      }
      void writeDebugScreenshot("after_sms_submit_click");
      const result = await validateResponsePromise;
      void writeDebugScreenshot(`after_validate_result_${result.ok ? "ok" : "fail"}`);
      return {
        attempted: true,
        ok: result.ok,
        hostPath,
        message: result.message,
      };
    } catch (error) {
      return {
        attempted: true,
        ok: false,
        hostPath,
        message: error instanceof Error ? error.message.slice(0, 80) : "validate_failed",
      };
    }
  };

  return {
    id,
    acquireQR,
    checkStatus,
    openRedirectURL,
    getCookies,
    submitSmsCode,
    markSmsApiSeenFromNetwork: () => smsApiSeen,
    wasSmsApiSeen: () => smsApiSeen,
    close,
  };
}

export const __private__ = {
  resolveChromeExecutable,
  SSO_HTML_URL,
  PASSPORT_GET_QRCODE_URL,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_QR_GLUE_WAIT_MS,
  PASSPORT_GET_QRCODE_PATH,
  PASSPORT_CHECK_PATH,
  SEND_CODE_PATH,
  VALIDATE_CODE_PATH,
  buildSessionCheckURL,
  tryExtractAcquireFromJson,
  loadPlaywrightChromium,
};
