// allow: SIZE_OK — existing module containing type declarations and login logic
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import {
  acquireDouyinQRCode,
  checkDouyinQRCodeStatus,
  DouyinSSOChallengeError,
  isDouyinAuthCookieSuccess,
  seedDouyinCookieJar,
} from "./douyinQRCode.js";
import {
  createDouyinSessionRuntime,
  DouyinRiskBlockedError,
  DouyinSessionEngineError,
  type SessionRuntimeHandle,
} from "./douyinSessionRuntime.js";


const DOUYIN_LOGIN_URL = "https://www.douyin.com/";
const DOUYIN_LOGIN_FALLBACK_URLS = [
  "https://www.douyin.com/",
  "https://www.douyin.com/user/self",
  "https://creator.douyin.com/",
] as const;
const DEFAULT_CDP_ENDPOINT = "ws://127.0.0.1:9222/devtools/browser";
const DEFAULT_SESSION_TTL_MS = 300_000;
/** WAVE/R6：默认浏览器登录超时 40s（与 session acquire 外层对齐） */
const DEFAULT_BROWSER_LOGIN_TIMEOUT_MS = 40_000;
const EVIDENCE_TEXT_LIMIT = 180;
const EVIDENCE_EVENT_LIMIT = 20;
const MANUAL_VERIFICATION_SOURCE = "douyin:manual-verification";

const QR_CODE_SELECTORS = [
  "div#animate_qrcode_container img",
  'img[aria-label="二维码"]',
  'img[alt*="二维码"]',
  'xpath=//*[contains(text(),"扫码登录")]/following::img[1]',
  'xpath=//*[contains(text(),"扫码登录")]/..//img',
  'xpath=//*[contains(text(),"扫码登录")]/ancestor::div[1]//img',
  'img[src^="data:image/"]',
  'img[src^="blob:"]',
  'img[src^="http://"]',
  'img[src^="https://"]',
] as const;

const DOUYIN_AUTH_COOKIE_NAMES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_guard",
  "sid_tt",
  "uid_tt",
  "uid_tt_ss",
]);


type DouyinCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
};

type CDPCookie = DouyinCookie;

type CDPElementHandle = {
  readonly getAttribute: (name: string) => Promise<string | null>;
  readonly screenshot: (options: { readonly type: "png" }) => Promise<Uint8Array | string>;
};

type CDPDiagnosticEventName = "console" | "pageerror" | "requestfailed";

type CDPSession = {
  readonly send: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly on?: (eventName: "Page.screencastFrame", handler: (event: unknown) => void) => void;
  readonly off?: (eventName: "Page.screencastFrame", handler: (event: unknown) => void) => void;
};

type CDPPage = {
  readonly on?: (eventName: CDPDiagnosticEventName, handler: (event: unknown) => void) => void;
  readonly url?: () => string;
  readonly goto: (
    url: string,
    options: { readonly waitUntil: "domcontentloaded" },
  ) => Promise<unknown>;
  readonly waitForSelector: (
    selector: string,
    options: { readonly timeout: number; readonly state?: "visible" | "attached" },
  ) => Promise<CDPElementHandle>;
  readonly evaluate: <Result>(
    pageFunction: (argument: string) => Result | Promise<Result>,
    argument: string,
  ) => Promise<Result>;
};

type CDPBrowserContext = {
  readonly newPage: () => Promise<CDPPage>;
  readonly pages?: () => readonly CDPPage[];
  readonly cookies: () => Promise<readonly CDPCookie[]>;
  readonly close: () => Promise<void>;
  readonly newCDPSession?: (page: CDPPage) => Promise<CDPSession>;
  readonly addInitScript: (
    script: string | (() => void) | { readonly path?: string; readonly content?: string },
  ) => Promise<void>;
};

type CDPBrowser = {
  readonly contexts?: () => readonly CDPBrowserContext[];
  readonly newContext: (options?: {
    readonly locale?: string;
    readonly timezoneId?: string;
    readonly userAgent?: string;
    readonly viewport?: { readonly width: number; readonly height: number } | null;
  }) => Promise<CDPBrowserContext>;
  readonly close: () => Promise<void>;
};

type PlaywrightCore = {
  readonly chromium: {
    readonly connectOverCDP: (options: { readonly endpointURL: string }) => Promise<CDPBrowser>;
  };
};

type LoginWebSmsState = {
  readonly tried: boolean;
  readonly smsApiSeen: boolean;
  readonly sendResult?: {
    readonly hostPath: string;
    readonly ok: boolean;
    readonly message?: string;
  };
};

type LoginNeedAppVerifyResult = {
  readonly id: string;
  readonly status: "need_app_verify";
  readonly error_code: 2046;
  readonly qrCode: string;
  readonly expiresAt: number;
  readonly webSms: LoginWebSmsState;
  readonly description?: string;
};

type LoginScannedResult = {
  readonly id: string;
  readonly status: "scanned";
  readonly qrCode: string;
  readonly expiresAt: number;
};

type LoginStartResult = {
  readonly id: string;
  readonly status: "waiting";
  readonly qrCode: string;
  readonly expiresAt: number;
};

type LoginManualVerificationResult = {
  readonly id: string;
  readonly status: "manual_verification";
  readonly qrCode?: never;
  readonly reason: "captcha_required";
  readonly expiresAt: number;
  readonly verification: {
    readonly transport: "cdp";
    readonly input: readonly ["mouse", "key"];
    readonly screencast: "active" | "unavailable";
  };
};

type LoginPollResult =
  | LoginStartResult
  | LoginScannedResult
  | LoginNeedAppVerifyResult
  | LoginManualVerificationResult
  | { readonly id: string; readonly status: "completed"; readonly cookies: readonly DouyinCookie[] }
  | { readonly status: "not_found" }
  | { readonly status: "expired" };

type CompletedLoginResult = Extract<LoginPollResult, { readonly status: "completed" }>;

type CompletedLoginCacheEntry = {
  readonly result: CompletedLoginResult;
  readonly expiresAt: number;
};

type LoginCancelResult = { readonly status: "cancelled" } | { readonly status: "not_found" };

type SubmitSmsCodeResult =
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

type ManualVerificationFrame = {
  readonly data: string;
  readonly format: "jpeg";
};


type ManualVerificationFrameSubscription = {
  readonly unsubscribe: () => void | Promise<void>;
};

type ManualVerificationStreamResult =
  | { readonly status: "subscribed"; readonly unsubscribe: () => Promise<void> }
  | { readonly status: "not_found" };

type DouyinLoginContext = {
  readonly openLoginPage: () => Promise<string>;
  readonly openRedirectURL: (url: string) => Promise<void>;
  readonly getCookies: () => Promise<readonly DouyinCookie[]>;
  readonly close: () => Promise<void>;
  readonly captureScreenshot?: () => Promise<string>;
  readonly refreshQRCode?: () => Promise<string | undefined>;
  readonly detectManualVerification?: () => Promise<boolean>;
  readonly startManualVerificationScreencast?: () => Promise<boolean>;
  readonly stopManualVerificationScreencast?: () => Promise<void>;
  readonly dispatchManualVerificationInput?: (event: ManualVerificationInput) => Promise<void>;
  readonly subscribeManualVerificationFrames?: (
    handler: (frame: ManualVerificationFrame) => void,
  ) => Promise<ManualVerificationFrameSubscription | undefined>;
};

type ManualVerificationMouseInput = {
  readonly kind: "mouse";
  readonly type: "move" | "down" | "up";
  readonly x: number;
  readonly y: number;
  readonly button?: "left" | "right" | "middle";
};

type ManualVerificationKeyInput = {
  readonly kind: "key";
  readonly type: "down" | "up";
  readonly key: string;
  readonly code?: string;
  readonly text?: string;
};

type ManualVerificationInput = ManualVerificationMouseInput | ManualVerificationKeyInput;

type ManualVerificationInputResult = { readonly status: "accepted" } | { readonly status: "not_found" };

type BrowserLoginSession = {
  readonly kind: "browser";
  readonly id: string;
  readonly qrCode: string;
  readonly expiresAt: number;
  readonly context: DouyinLoginContext;
};

type HTTPLoginSession = {
  readonly kind: "http";
  readonly id: string;
  readonly qrCode: string;
  readonly expiresAt: number;
  readonly token: string;
  readonly webSms: LoginWebSmsState;
  readonly lastStatus?:
    | "waiting"
    | "scanned"
    | "need_app_verify"
    | "confirmed"
    | "expired"
    | "illegal_app";
  readonly lastDescription?: string;
};

/** 方案 A：服务端 jssdk 同会话主路径（E1 Chromium） */
type SessionLoginSession = {
  readonly kind: "session";
  readonly id: string;
  readonly qrCode: string;
  readonly expiresAt: number;
  readonly token: string;
  readonly runtime: SessionRuntimeHandle;
  readonly webSms: LoginWebSmsState;
  readonly lastStatus?:
    | "waiting"
    | "scanned"
    | "need_app_verify"
    | "confirmed"
    | "expired"
    | "illegal_app";
  readonly lastDescription?: string;
};

type LoginSession = BrowserLoginSession | HTTPLoginSession | SessionLoginSession;

type DouyinLoginServiceOptions = {
  readonly cdpEndpoint?: string;
  /** @deprecated 方案 A 默认 false：裸 HTTP 不再作成功主路径 */
  readonly enableHTTPQRCode?: boolean;
  /** 方案 A 主路径：服务端同会话出码（默认 true） */
  readonly enableSessionRuntime?: boolean;
  readonly sessionTTLMs?: number;
  readonly browserLoginTimeoutMs?: number;
  readonly createID?: () => string;
  readonly now?: () => number;
  readonly createContext?: (cdpEndpoint: string) => Promise<DouyinLoginContext>;
  readonly createSessionRuntime?: () => Promise<SessionRuntimeHandle>;
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

type DouyinLoginDiagnosticEvidence = {
  readonly events?: readonly string[];
  readonly page?: {
    readonly qrImageCount: number;
    readonly bodyText: string;
  };
  readonly qrSource?: string;
};

export type DouyinLoginDiagnostic = {
  readonly reason: DouyinLoginDiagnosticReason;
  readonly message: string;
  readonly nextActions?: readonly string[];
  readonly evidence?: DouyinLoginDiagnosticEvidence;
};

class DouyinQRCodeUnavailableError extends Error {
  readonly name = "DouyinQRCodeUnavailableError";

  constructor(readonly evidence?: DouyinLoginDiagnosticEvidence) {
    super("douyin qr code unavailable");
    if (this.stack) {
      this.stack = sanitizeEvidenceText(this.stack);
    }
  }
}

export class DouyinLoginDiagnosticError extends Error {
  readonly name = "DouyinLoginDiagnosticError";
  readonly evidence?: DouyinLoginDiagnosticEvidence;

  constructor(
    readonly reason: DouyinLoginDiagnosticReason,
    message: string,
    readonly nextActions?: readonly string[],
    options?: ErrorOptions,
    evidence?: DouyinLoginDiagnosticEvidence,
  ) {
    const sanitizedMessage = sanitizeEvidenceText(message);
    super(sanitizedMessage, options);
    this.evidence = sanitizeDiagnosticEvidence(evidence);
    if (this.stack) {
      this.stack = sanitizeEvidenceText(this.stack);
    }
    if (options?.cause instanceof Error) {
      try {
        options.cause.message = sanitizeEvidenceText(options.cause.message);
        if (options.cause.stack) {
          options.cause.stack = sanitizeEvidenceText(options.cause.stack);
        }
      } catch {
        // Ignore read-only properties
      }
    }
  }

  toDiagnostic(): DouyinLoginDiagnostic {
    const diagnostic = {
      reason: this.reason,
      message: this.message,
      nextActions: this.nextActions,
    };
    if (this.evidence === undefined) {
      return diagnostic;
    }
    return { ...diagnostic, evidence: this.evidence };
  }
}

function createQRCodeUnavailableDiagnostic(cause: DouyinQRCodeUnavailableError): DouyinLoginDiagnosticError {
  return new DouyinLoginDiagnosticError(
    "qr_unavailable",
    "未能从抖音登录页面加载出有效的登录二维码。",
    ["请检查网络是否能够正常访问抖音官网", "稍后重试或尝试手动导入登录态"],
    { cause },
    cause.evidence,
  );
}

class DouyinBrowserLoginTimeoutError extends Error {
  readonly name = "DouyinBrowserLoginTimeoutError";

  constructor(timeoutMs: number) {
    super(`douyin browser login timed out after ${timeoutMs}ms`);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  createTimeoutError: () => Error,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await operation;
  }
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(createTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function createCDPUnavailableDiagnostic(cause: Error): DouyinLoginDiagnosticError {
  return new DouyinLoginDiagnosticError(
    "cdp_unavailable",
    "浏览器自动化代理解析服务连接失败（CDP 不可用）。",
    ["检查本地 Obscura/Chrome 调试端口 9222 是否正常开启", "确认 CDP 连接端点环境配置正确"],
    { cause },
  );
}

function isDuplicateTargetError(error: unknown): boolean {
  return error instanceof Error && /duplicate target/i.test(error.message);
}

function isReusableBlankPage(page: CDPPage): boolean {
  if (page.url === undefined) {
    return true;
  }
  try {
    const currentURL = page.url();
    return (
      currentURL === "" ||
      currentURL === "about:blank" ||
      currentURL === "chrome://newtab/" ||
      currentURL.startsWith("chrome://new-tab-page")
    );
  } catch {
    return true;
  }
}

function createPollFailureDiagnostic(cause: Error): DouyinLoginDiagnosticError {
  return new DouyinLoginDiagnosticError(
    "generic_failure",
    "抖音登录轮询发生未知错误。",
    ["请检查后端系统日志", "稍后重试扫码登录"],
    { cause },
  );
}

class PlaywrightDouyinLoginContext implements DouyinLoginContext {
  private page: CDPPage | undefined;
  private qrCodeImage: CDPElementHandle | undefined;
  private manualVerificationCDPSession: CDPSession | undefined;
  private manualVerificationScreencastActive = false;
  private readonly diagnosticEvents: string[] = [];

  private constructor(
    private readonly browser: CDPBrowser,
    private readonly context: CDPBrowserContext,
    private readonly ownsContext: boolean,
  ) {}

  static async create(
    cdpEndpoint: string,
    chromiumOverride?: PlaywrightCore["chromium"],
  ): Promise<PlaywrightDouyinLoginContext> {
    const chromium = chromiumOverride ?? loadPlaywrightCore().chromium;
    const browser = await chromium.connectOverCDP({ endpointURL: cdpEndpoint });
    const existingContexts = browser.contexts?.() ?? [];
    const existingContext = existingContexts[0];
    const ownsContext = existingContext === undefined;
    const context =
      existingContext ??
      (await browser.newContext({
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 900 },
      }));
    await context.addInitScript(() => {
      const ensureDocumentHead = () => {
        if (document.head || document.querySelector("head")) {
          return;
        }
        const head = document.createElement("head");
        const root = document.documentElement;
        if (root) {
          root.insertBefore(head, root.firstChild);
          return;
        }

        document.addEventListener("DOMContentLoaded", ensureDocumentHead, { once: true });
      };

      ensureDocumentHead();

      const newProto = Object.getPrototypeOf(navigator);
      if (newProto) {
        Reflect.deleteProperty(newProto, "webdriver");
      }
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
      if (!Reflect.get(window, "chrome")) {
        Reflect.set(window, "chrome", {
          app: {
            isInstalled: false,
            InstallState: {
              DISABLED: "disabled",
              INSTALLED: "installed",
              NOT_INSTALLED: "not_installed",
            },
            getDetails: () => {},
            getIsInstalled: () => {},
            install: () => {},
          },
          runtime: {},
          loadTimes: () => {},
          csi: () => {},
        });
      }
      Object.defineProperty(navigator, "languages", {
        get: () => ["zh-CN", "zh", "en"],
      });
    });
    return new PlaywrightDouyinLoginContext(browser, context, ownsContext);
  }

  async openLoginPage(): Promise<string> {
    const page = await this.acquireLoginPage();
    this.page = page;
    this.registerDiagnostics(page);
    let lastError: unknown = undefined;
    for (const loginURL of DOUYIN_LOGIN_FALLBACK_URLS) {
      await page.goto(loginURL, { waitUntil: "domcontentloaded" });
      await waitForPageHydration(page);
      await activateScanLogin(page);
      try {
        const qrCode = await findQRCodeSource(page);
        this.qrCodeImage = qrCode.image;
        return qrCode.source;
      } catch (error) {
        lastError = error;
        if (!(error instanceof DouyinQRCodeUnavailableError)) {
          throw error;
        }
      }
    }
    if (lastError instanceof DouyinQRCodeUnavailableError) {
      throw new DouyinQRCodeUnavailableError(await collectQRCodeEvidence(page, this.diagnosticEvents));
    }
    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new DouyinQRCodeUnavailableError(await collectQRCodeEvidence(page, this.diagnosticEvents));
  }

  async refreshQRCode(): Promise<string | undefined> {
    const page = this.page;
    if (page === undefined) {
      return undefined;
    }
    if (await detectManualVerificationPage(page)) {
      return MANUAL_VERIFICATION_SOURCE;
    }
    if (!(await isQRCodeExpired(page))) {
      try {
        const qrCode = await findQRCodeSource(page);
        this.qrCodeImage = qrCode.image;
        return qrCode.source;
      } catch (error) {
        if (error instanceof DouyinQRCodeUnavailableError) {
          return undefined;
        }
        throw error;
      }
    }
    await page.goto(DOUYIN_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await waitForPageHydration(page);
    await activateScanLogin(page);
    try {
      const qrCode = await findQRCodeSource(page);
      this.qrCodeImage = qrCode.image;
      return qrCode.source;
    } catch (error) {
      if (error instanceof DouyinQRCodeUnavailableError) {
        throw new DouyinQRCodeUnavailableError(await collectQRCodeEvidence(page, this.diagnosticEvents));
      }
      throw error;
    }
  }

  async openRedirectURL(url: string): Promise<void> {
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async captureScreenshot(): Promise<string> {
    if (this.qrCodeImage === undefined) {
      throw new DouyinQRCodeUnavailableError();
    }
    const source = await screenshotQRCodeImage(this.qrCodeImage);
    if (isDataImage(source)) {
      return source;
    }
    throw new DouyinQRCodeUnavailableError();
  }

  async getCookies(): Promise<readonly DouyinCookie[]> {
    const cookies = await this.context.cookies();
    return cookies.filter(isDouyinCookie).map(toDouyinCookie);
  }

  async close(): Promise<void> {
    if (this.ownsContext) {
      await this.context.close();
    }
    await this.browser.close();
  }

  private async acquireLoginPage(): Promise<CDPPage> {
    const existingPages = this.context.pages?.() ?? [];
    const reusablePage = existingPages.find((page) => isReusableBlankPage(page));
    if (reusablePage !== undefined) {
      return reusablePage;
    }
    if (existingPages[0] !== undefined) {
      return existingPages[0];
    }
    return await this.context.newPage();
  }

  async detectManualVerification(): Promise<boolean> {
    return this.page === undefined ? false : await detectManualVerificationPage(this.page);
  }

  async startManualVerificationScreencast(): Promise<boolean> {
    const session = await this.ensureManualVerificationCDPSession();
    if (session === undefined) {
      return false;
    }
    await session.send("Page.startScreencast", { format: "jpeg", quality: 70 });
    this.manualVerificationScreencastActive = true;
    return true;
  }

  async stopManualVerificationScreencast(): Promise<void> {
    if (!this.manualVerificationScreencastActive) {
      return;
    }
    const session = this.manualVerificationCDPSession;
    this.manualVerificationScreencastActive = false;
    await session?.send("Page.stopScreencast");
  }

  async subscribeManualVerificationFrames(
    handler: (frame: ManualVerificationFrame) => void,
  ): Promise<ManualVerificationFrameSubscription | undefined> {
    const session = await this.ensureManualVerificationCDPSession();
    if (session === undefined || session.on === undefined) {
      return undefined;
    }
    const frameHandler = async (event: unknown) => {
      const frame = parseScreencastFrame(event);
      if (frame === undefined) {
        return;
      }
      handler(frame);
      await session.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    };
    session.on("Page.screencastFrame", frameHandler);
    await this.startManualVerificationScreencast();
    return {
      unsubscribe: () => {
        session.off?.("Page.screencastFrame", frameHandler);
      },
    };
  }

  async dispatchManualVerificationInput(event: ManualVerificationInput): Promise<void> {
    const session = await this.ensureManualVerificationCDPSession();
    if (session === undefined) {
      return;
    }
    if (event.kind === "mouse") {
      await session.send("Input.dispatchMouseEvent", toCDPMouseInput(event));
      return;
    }
    await session.send("Input.dispatchKeyEvent", toCDPKeyInput(event));
  }

  private registerDiagnostics(page: CDPPage): void {
    page.on?.("console", (event) => this.recordDiagnosticEvent("console", event));
    page.on?.("pageerror", (event) => this.recordDiagnosticEvent("pageerror", event));
    page.on?.("requestfailed", (event) => this.recordDiagnosticEvent("requestfailed", event));
  }

  private recordDiagnosticEvent(eventName: CDPDiagnosticEventName, event: unknown): void {
    this.diagnosticEvents.push(sanitizeEvidenceText(describeDiagnosticEvent(eventName, event)));
    if (this.diagnosticEvents.length > EVIDENCE_EVENT_LIMIT) {
      this.diagnosticEvents.shift();
    }
  }

  private async ensureManualVerificationCDPSession(): Promise<CDPSession | undefined> {
    if (this.manualVerificationCDPSession !== undefined) {
      return this.manualVerificationCDPSession;
    }
    if (this.page === undefined || this.context.newCDPSession === undefined) {
      return undefined;
    }
    this.manualVerificationCDPSession = await this.context.newCDPSession(this.page);
    return this.manualVerificationCDPSession;
  }
}

async function detectManualVerificationPage(page: CDPPage): Promise<boolean> {
  try {
    const detected = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      if (bodyText.includes("请完成下列验证后继续")) {
        return true;
      }
      return document.querySelector(
        [
          'iframe[src*="captcha"]',
          'iframe[src*="verify"]',
          '[class*="captcha"]',
          '[id*="captcha"]',
          '[class*="slider"]',
          '[id*="slider"]',
        ].join(","),
      ) !== null;
    }, "");
    return detected === true;
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }
    throw error;
  }
}

async function collectQRCodeEvidence(
  page: CDPPage,
  events: readonly string[],
): Promise<DouyinLoginDiagnosticEvidence> {
  const pageEvidence = await readPageEvidence(page);
  return {
    events: events.slice(-EVIDENCE_EVENT_LIMIT),
    ...(pageEvidence === undefined ? {} : { page: pageEvidence }),
  };
}

async function readPageEvidence(
  page: CDPPage,
): Promise<DouyinLoginDiagnosticEvidence["page"] | undefined> {
  try {
    const snapshot = await page.evaluate(() => {
      const qrImageCount = document.querySelectorAll(
        'div#animate_qrcode_container img, img[aria-label="二维码"], img[alt*="二维码"], img[src^="data:image/"], img[src^="blob:"]',
      ).length;
      return { qrImageCount, bodyText: document.body?.innerText ?? "" };
    }, "");
    return {
      qrImageCount: snapshot.qrImageCount,
      bodyText: sanitizeEvidenceText(snapshot.bodyText),
    };
  } catch (error) {
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

function describeDiagnosticEvent(eventName: CDPDiagnosticEventName, event: unknown): string {
  if (eventName === "console") {
    return `console:${callStringMethod(event, "type") ?? "log"}:${callStringMethod(event, "text") ?? ""}`;
  }
  if (eventName === "pageerror") {
    return `pageerror:${readStringProperty(event, "message") ?? ""}`;
  }
  return `requestfailed:${callStringMethod(event, "url") ?? ""}:${readRequestFailureText(event) ?? ""}`;
}

function readRequestFailureText(event: unknown): string | undefined {
  const failure = callUnknownMethod(event, "failure");
  return readStringProperty(failure, "errorText");
}

function callStringMethod(value: unknown, key: string): string | undefined {
  const result = callUnknownMethod(value, key);
  return typeof result === "string" ? result : undefined;
}

function callUnknownMethod(value: unknown, key: string): unknown {
  const method = readProperty(value, key);
  if (typeof method !== "function") {
    return undefined;
  }
  return Reflect.apply(method, value, []);
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function sanitizeDiagnosticEvidence(
  evidence: DouyinLoginDiagnosticEvidence | undefined,
): DouyinLoginDiagnosticEvidence | undefined {
  if (evidence === undefined) {
    return undefined;
  }
  const page = evidence.page === undefined ? undefined : {
    qrImageCount: evidence.page.qrImageCount,
    bodyText: sanitizeEvidenceText(evidence.page.bodyText),
  };
  return {
    ...(evidence.events === undefined
      ? {}
      : { events: evidence.events.map((event) => sanitizeEvidenceText(event)) }),
    ...(page === undefined ? {} : { page }),
    ...(evidence.qrSource === undefined
      ? {}
      : { qrSource: sanitizeEvidenceText(evidence.qrSource) }),
  };
}

function sanitizeEvidenceText(value: string): string {
  const withoutStack = value
    .replace(/^\s+at\s+.*$/gim, "[redacted-stack]")
    .replace(/\bat\s+[a-zA-Z0-9_$<>.]+\s*\([^)]*\)/gi, "[redacted-stack]")
    .replace(/\bat\s+[^()\s]+:[0-9]+:[0-9]+/gi, "[redacted-stack]");
  const withoutImages = withoutStack.replace(
    /data:image\/[a-z0-9.+-]+;base64,[^\s"'<>)]*/gi,
    "[redacted-image]",
  );
  const withoutURLSecrets = withoutImages.replace(/https?:\/\/[^\s"'<>)]*/gi, redactURL);
  const withoutHeaders = withoutURLSecrets
    .replace(/\bcookie\s*:\s*[^\n\r]*/gi, "[redacted]: [redacted]")
    .replace(/\bauthorization\s*:\s*[^\n\r]*/gi, "[redacted]: [redacted]")
    .replace(/\bbearer\s+[^\s,;&]+/gi, "[redacted] [redacted]");
  const withoutNamedSecrets = withoutHeaders
    .replace(/"(storageState|access_token|refresh_token|token|sessionid|sid_guard|sid_tt|uid_tt)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"storageState"\s*:\s*\{[^\n\r]*\}/gi, '"storageState":"[redacted]"')
    .replace(/\bstorageState\s*[=:]\s*[^\n\r]*/gi, "[redacted]=[redacted]")
    .replace(/\b(access_token|refresh_token|token|sessionid|sid_guard|sid_tt|uid_tt)\s*[=:]\s*[^\s,;&]+/gi, "[redacted]=[redacted]")
    .replace(/\b(cookie|authorization|bearer|storageState|access_token|refresh_token|token|sessionid|sid_guard|sid_tt|uid_tt)\b/gi, "[redacted]");
  return truncateEvidenceText(withoutNamedSecrets);
}

function redactURL(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    if (error instanceof TypeError) {
      return "[redacted-url]";
    }
    throw error;
  }
}

function truncateEvidenceText(value: string): string {
  if (value.length <= EVIDENCE_TEXT_LIMIT) {
    return value;
  }
  return `${value.slice(0, EVIDENCE_TEXT_LIMIT)}...`;
}

function loadPlaywrightCore(): PlaywrightCore {
  const nodeRequire = createRequire(import.meta.url);
  const imported: unknown = nodeRequire("playwright-core");
  if (isPlaywrightCore(imported)) {
    return imported;
  }
  throw new Error("playwright-core module shape is invalid");
}

function isPlaywrightCore(value: unknown): value is PlaywrightCore {
  if (typeof value !== "object" || value === null || !("chromium" in value)) {
    return false;
  }
  const chromium = value.chromium;
  if (typeof chromium !== "object" || chromium === null || !("connectOverCDP" in chromium)) {
    return false;
  }
  return typeof chromium.connectOverCDP === "function";
}

async function waitForPageHydration(page: CDPPage): Promise<void> {
  await page.waitForSelector('div#animate_qrcode_container, .login-panel, img[aria-label="二维码"]', {
    timeout: 5000,
    state: "attached",
  }).catch(() => undefined);
}

async function activateScanLogin(page: CDPPage): Promise<void> {
  try {
    await page.evaluate(() => {
      const texts = ["扫码登录", "扫码", "二维码登录"];
      const candidates = Array.from(
        document.querySelectorAll("button, a, span, div, li, p, label"),
      ) as HTMLElement[];
      for (const text of texts) {
        const match = candidates.find((element) => {
          const content = (element.innerText || element.textContent || "").trim();
          return content === text || content.includes(text);
        });
        if (match) {
          match.click();
          return true;
        }
      }
      return false;
    }, "");
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }
}

type QRCodeSource = {
  readonly source: string;
  readonly image: CDPElementHandle;
};

async function findQRCodeSource(page: CDPPage): Promise<QRCodeSource> {
  try {
    return await Promise.any(
      QR_CODE_SELECTORS.map((selector) => findQRCodeSourceForSelector(page, selector)),
    );
  } catch (error) {
    if (error instanceof AggregateError) {
      throw new DouyinQRCodeUnavailableError();
    }
    throw error;
  }
}

async function findQRCodeSourceForSelector(page: CDPPage, selector: string): Promise<QRCodeSource> {
  const image = await getQRCodeImage(page, selector);
  if (image === undefined) {
    throw new DouyinQRCodeUnavailableError();
  }
  const source = await getImageSource(page, image);
  if (isDataImage(source)) {
    return { source, image };
  }
  const screenshot = await screenshotQRCodeImage(image);
  if (isDataImage(screenshot)) {
    return { source: screenshot, image };
  }
  throw new DouyinQRCodeUnavailableError();
}

async function getQRCodeImage(
  page: CDPPage,
  selector: string,
): Promise<CDPElementHandle | undefined> {
  try {
    return await page.waitForSelector(selector, { timeout: 10_000, state: "visible" });
  } catch (error) {
    if (error instanceof Error) {
      return undefined;
    }
    throw error;
  }
}

async function getImageSource(page: CDPPage, image: CDPElementHandle): Promise<string> {
  try {
    let source = "";
    let lastSrc = "";
    let stableCount = 0;
    for (let i = 0; i < 15; i++) {
      try {
        const attr = await image.getAttribute("src");
        const current = attr?.trim() ?? "";
        if (current !== "") {
          if (current.startsWith("data:image/")) {
            source = current;
            break;
          }
          if (current === lastSrc) {
            stableCount++;
            if (stableCount >= 2) {
              source = current;
              break;
            }
          } else {
            lastSrc = current;
            stableCount = 1;
          }
        }
      } catch {
        // Ignore temporary element access errors during hydration
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (source === "" && lastSrc !== "") {
      source = lastSrc;
    }
    return await migrateImageSource(page, source);
  } catch (error) {
    if (error instanceof Error) {
      return "";
    }
    throw error;
  }
}

async function migrateImageSource(page: CDPPage, source: string): Promise<string> {
  if (isDataImage(source)) {
    return source;
  }
  if (isPageFetchableImageSource(source)) {
    return await page.evaluate(readImageAsDataURL, source);
  }
  return "";
}

function isDataImage(source: string): boolean {
  return source.startsWith("data:image/");
}

function isPageFetchableImageSource(source: string): boolean {
  return (
    source.startsWith("blob:") || source.startsWith("http://") || source.startsWith("https://")
  );
}

async function readImageAsDataURL(source: string): Promise<string> {
  const response = await fetch(source, { credentials: "include" });
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () =>
      resolve(typeof reader.result === "string" ? reader.result : ""),
    );
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("failed to read qr code")),
    );
    reader.readAsDataURL(blob);
  });
}

async function isQRCodeExpired(page: CDPPage): Promise<boolean> {
  const content = await page.evaluate((_) => document.body.innerText, "");
  return ["二维码已失效", "二维码已过期", "请刷新二维码", "点击刷新"].some((message) =>
    content.includes(message),
  );
}

async function screenshotQRCodeImage(image: CDPElementHandle): Promise<string> {
  try {
    const screenshot = await image.screenshot({ type: "png" });
    return screenshotToDataImage(screenshot);
  } catch (error) {
    if (error instanceof Error) {
      return "";
    }
    throw error;
  }
}

function screenshotToDataImage(screenshot: Uint8Array | string): string {
  if (typeof screenshot === "string") {
    return isDataImage(screenshot) ? screenshot : `data:image/png;base64,${screenshot}`;
  }
  return `data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`;
}

function isManualVerificationSource(source: string): boolean {
  const normalized = source.toLowerCase();
  return (
    source === MANUAL_VERIFICATION_SOURCE ||
    source.includes("请完成下列验证后继续") ||
    normalized.includes("captcha") ||
    normalized.includes("verify") ||
    normalized.includes("slider")
  );
}

async function toManualVerificationResult(
  session: BrowserLoginSession,
): Promise<LoginManualVerificationResult> {
  const screencastActive = await session.context.startManualVerificationScreencast?.();
  return {
    id: session.id,
    status: "manual_verification",
    reason: "captcha_required",
    expiresAt: session.expiresAt,
    verification: {
      transport: "cdp",
      input: ["mouse", "key"],
      screencast: screencastActive === true ? "active" : "unavailable",
    },
  };
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectForbiddenManualVerificationFields(event: Readonly<Record<string, unknown>>): void {
  const forbiddenFields = [
    "cookie",
    "cookies",
    "token",
    "authorization",
    "storageState",
    "method",
    "params",
    "data",
  ] as const;
  for (const field of forbiddenFields) {
    if (field in event) {
      throw new Error("forbidden manual verification input field");
    }
  }
}

function parseManualVerificationInput(event: unknown): ManualVerificationInput {
  if (!isPlainRecord(event)) {
    throw new Error("invalid manual verification input");
  }
  rejectForbiddenManualVerificationFields(event);
  if (event.kind === "mouse") {
    const allowedKeys = new Set(["kind", "type", "x", "y", "button"]);
    if (Object.keys(event).some((key) => !allowedKeys.has(key))) {
      throw new Error("unsupported manual verification input field");
    }
    if (!isMouseEventType(event.type) || !isFiniteNumber(event.x) || !isFiniteNumber(event.y)) {
      throw new Error("invalid manual verification mouse input");
    }
    if (event.button !== undefined && !isMouseButton(event.button)) {
      throw new Error("invalid manual verification mouse button");
    }
    return {
      kind: "mouse",
      type: event.type,
      x: event.x,
      y: event.y,
      ...(event.button === undefined ? {} : { button: event.button }),
    };
  }
  if (event.kind === "key") {
    const allowedKeys = new Set(["kind", "type", "key", "code", "text"]);
    if (Object.keys(event).some((key) => !allowedKeys.has(key))) {
      throw new Error("unsupported manual verification input field");
    }
    if (!isKeyEventType(event.type) || typeof event.key !== "string" || event.key === "") {
      throw new Error("invalid manual verification key input");
    }
    if (event.code !== undefined && typeof event.code !== "string") {
      throw new Error("invalid manual verification key code");
    }
    if (event.text !== undefined && typeof event.text !== "string") {
      throw new Error("invalid manual verification key text");
    }
    return {
      kind: "key",
      type: event.type,
      key: event.key,
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.text === undefined ? {} : { text: event.text }),
    };
  }
  throw new Error("unsupported manual verification input kind");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMouseEventType(value: unknown): value is ManualVerificationMouseInput["type"] {
  return value === "move" || value === "down" || value === "up";
}

function isMouseButton(value: unknown): value is NonNullable<ManualVerificationMouseInput["button"]> {
  return value === "left" || value === "right" || value === "middle";
}

function isKeyEventType(value: unknown): value is ManualVerificationKeyInput["type"] {
  return value === "down" || value === "up";
}

function toCDPMouseInput(event: ManualVerificationMouseInput): Readonly<Record<string, unknown>> {
  const typeByInputType = {
    move: "mouseMoved",
    down: "mousePressed",
    up: "mouseReleased",
  } as const;
  return {
    type: typeByInputType[event.type],
    x: event.x,
    y: event.y,
    button: event.button ?? "left",
  };
}

function toCDPKeyInput(event: ManualVerificationKeyInput): Readonly<Record<string, unknown>> {
  const typeByInputType = {
    down: "keyDown",
    up: "keyUp",
  } as const;
  return {
    type: typeByInputType[event.type],
    key: event.key,
    ...(event.code === undefined ? {} : { code: event.code }),
    ...(event.text === undefined ? {} : { text: event.text }),
  };
}

function parseScreencastFrame(
  event: unknown,
): (ManualVerificationFrame & { readonly sessionId: number }) | undefined {
  if (!isPlainRecord(event) || typeof event.data !== "string" || !isFiniteNumber(event.sessionId)) {
    return undefined;
  }
  return { data: event.data, format: "jpeg", sessionId: event.sessionId };
}

async function ensureMigratableQRCode(
  source: string,
  context: DouyinLoginContext,
): Promise<string> {
  if (isDataImage(source)) {
    return source;
  }
  const screenshot = await context.captureScreenshot?.();
  if (screenshot !== undefined && screenshot.length > 0) {
    return screenshotToDataImage(screenshot);
  }
  throw new DouyinQRCodeUnavailableError({ qrSource: sanitizeEvidenceText(source) });
}

function isDouyinCookie(cookie: Pick<CDPCookie, "domain">): boolean {
  const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return domain === "douyin.com" || domain.endsWith(".douyin.com");
}

function isAuthCookie(cookie: DouyinCookie): boolean {
  return DOUYIN_AUTH_COOKIE_NAMES.has(cookie.name);
}

function hasAuthCookieSuccess(cookies: readonly DouyinCookie[]): boolean {
  return isDouyinAuthCookieSuccess(cookies);
}


type SessionCookieProbeLog = {
  readonly phase: string;
  readonly sessionId: string;
  readonly cookies: readonly DouyinCookie[];
  readonly completed: boolean;
};

type RuntimeCookieCompletionProbe = {
  readonly session: SessionLoginSession;
  readonly phase: string;
  readonly cookies?: readonly DouyinCookie[];
};

function logSessionCookieProbe(probe: SessionCookieProbeLog): void {
  console.info(
    `[douyin-login] ${JSON.stringify({
      phase: probe.phase,
      sessionId: probe.sessionId,
      cookieCount: probe.cookies.length,
      cookieNames: probe.cookies.map((cookie) => cookie.name),
      domains: [...new Set(probe.cookies.map((cookie) => cookie.domain))],
      completed: probe.completed,
    })}`,
  );
}


function toCompletedLoginResult(id: string, cookies: readonly DouyinCookie[]): CompletedLoginResult {
  return {
    id,
    status: "completed",
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
    })),
  };
}


function toDouyinCookie(cookie: Pick<CDPCookie, "name" | "value" | "domain">): DouyinCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
  };
}

export class DouyinLoginService {
  private readonly cdpEndpoint: string;
  private readonly enableHTTPQRCode: boolean;
  private readonly enableSessionRuntime: boolean;
  private readonly sessionTTLMs: number;
  private readonly browserLoginTimeoutMs: number;
  private readonly createID: () => string;
  private readonly now: () => number;
  private readonly createContext: (cdpEndpoint: string) => Promise<DouyinLoginContext>;
  private readonly createSessionRuntime: () => Promise<SessionRuntimeHandle>;
  private readonly sessions = new Map<string, LoginSession>();
  private readonly completedResults = new Map<string, CompletedLoginCacheEntry>();
  private activeRuntime: SessionRuntimeHandle | undefined;
  private startLock: Promise<void> = Promise.resolve();
  /** r9c：跨 start / cancel 冷却时钟（重新获取 = 新浏览器） */
  private lastStartAt = 0;
  /** browser_timeout 后影响「下一次 start」的冷却截止（不在本请求内 sleep 60s） */
  private cooldownUntil = 0;

  constructor(options: DouyinLoginServiceOptions = {}) {
    this.cdpEndpoint =
      options.cdpEndpoint ?? process.env.DOUYIN_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT;
    this.enableHTTPQRCode = options.enableHTTPQRCode ?? false;
    this.enableSessionRuntime = options.enableSessionRuntime ?? true;
    this.sessionTTLMs = options.sessionTTLMs ?? DEFAULT_SESSION_TTL_MS;
    this.browserLoginTimeoutMs =
      options.browserLoginTimeoutMs ??
      readPositiveTimeoutMs(process.env.DOUYIN_BROWSER_LOGIN_TIMEOUT_MS) ??
      DEFAULT_BROWSER_LOGIN_TIMEOUT_MS;
    this.createID = options.createID ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.createContext =
      options.createContext ??
      ((cdpEndpoint: string) => PlaywrightDouyinLoginContext.create(cdpEndpoint));
    this.createSessionRuntime = options.createSessionRuntime ?? (() => createDouyinSessionRuntime());
  }

  async start(): Promise<LoginStartResult | LoginManualVerificationResult> {
    let releaseStartLock: (() => void) | undefined;
    const previousStart = this.startLock;
    this.startLock = new Promise<void>((resolve) => {
      releaseStartLock = resolve;
    });
    await previousStart;

    const id = this.createID();

    // —— 方案 A 主路径：服务端 jssdk 同会话出码 ——
    if (this.enableSessionRuntime) {
      let runtime: SessionRuntimeHandle | undefined;
      try {
        // WAVE/R6：每次 start=新浏览器；跨请求冷却；禁止请求内二次出码（attempt<=1）
        // 跨请求 minGap 8s；browser_timeout 冷却 15s；外层默认 40s
        const acquireOuterMs =
          this.browserLoginTimeoutMs > 0 ? this.browserLoginTimeoutMs : 40_000;
        // 跨 start 冷却：minGap 8s 与 cooldownUntil 取更晚
        const now0 = this.now();
        const minGapMs = 8_000;
        const gapTarget = this.lastStartAt > 0 ? this.lastStartAt + minGapMs : 0;
        const waitUntil = Math.max(gapTarget, this.cooldownUntil);
        if (waitUntil > now0) {
          const waitMs = waitUntil - now0;
          console.info(
            `[douyin-login] ${JSON.stringify({ phase: "start_cooldown", waitMs, hotpatch: "r6" })}`,
          );
          await new Promise<void>((r) => setTimeout(r, waitMs));
        }
        // wait 前用 now0 算 gap；wait 后更新 lastStartAt（本次实际开始）
        this.lastStartAt = this.now();
        let lastError: unknown;
        // WAVE/R6：attempt 循环 <= 1，禁止请求内二次出码
        for (let attempt = 1; attempt <= 1; attempt++) {
          await this.closeActiveRuntime();
          // 启动前短暂资源回收
          await new Promise<void>((r) => setTimeout(r, 500));
          runtime = await this.createSessionRuntime();
          this.activeRuntime = runtime;
          try {
            const acquired = await withTimeout(
              runtime.acquireQR(),
              acquireOuterMs,
              () =>
                new DouyinSessionEngineError(
                  "browser_timeout",
                  `同会话出码超时（${acquireOuterMs}ms）。`,
                ),
            );
            const session: SessionLoginSession = {
              kind: "session",
              id,
              qrCode: acquired.qrCode,
              expiresAt: this.now() + this.sessionTTLMs,
              token: acquired.token,
              runtime,
              webSms: { tried: false, smsApiSeen: false },
              lastStatus: "waiting",
            };
            this.sessions.set(id, session);
            console.info(
              `[douyin-login] ${JSON.stringify({
                phase: "start_ok",
                attempt,
                hotpatch: "r6",
                sessionId: id,
              })}`,
            );
            this.lastStartAt = this.now();
            return toWaitingResult(session);
          } catch (error) {
            lastError = error;
            const code =
              error instanceof DouyinSessionEngineError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "unknown";
            console.info(
              `[douyin-login] ${JSON.stringify({
                phase: "start_attempt_fail",
                attempt,
                hotpatch: "r6",
                code,
                message: error instanceof Error ? error.message.slice(0, 120) : String(error),
              })}`,
            );
            // WAVE/R6：browser_timeout 冷却 15s，影响下一次 start
            if (
              code === "browser_timeout" ||
              (error instanceof Error &&
                (error.message.includes("同会话出码超时") ||
                  error.message.includes("browser_timeout")))
            ) {
              this.cooldownUntil = this.now() + 15_000;
              console.info(
                `[douyin-login] ${JSON.stringify({
                  phase: "timeout_backoff",
                  waitMs: 15_000,
                  hotpatch: "r6",
                  attempt,
                  defer: "next_start",
                })}`,
              );
            }
            await runtime.close().catch(() => undefined);
            if (this.activeRuntime === runtime) {
              this.activeRuntime = undefined;
            }
            runtime = undefined;
            this.lastStartAt = this.now();
            break;
          }
        }
        throw this.mapSessionStartError(lastError);
      } catch (error) {
        if (runtime !== undefined) {
          await runtime.close().catch(() => undefined);
          if (this.activeRuntime === runtime) {
            this.activeRuntime = undefined;
          }
        }
        throw this.mapSessionStartError(error);
      } finally {
        releaseStartLock?.();
      }
    }

    releaseStartLock?.();

    // —— 可选：裸 HTTP（默认关闭；仅兼容/测试）——
    let ssoError: unknown = undefined;
    if (this.enableHTTPQRCode) {
      try {
        const httpQRCode = await acquireDouyinQRCode();
        if (httpQRCode !== undefined) {
          const session: HTTPLoginSession = {
            kind: "http",
            id,
            qrCode: httpQRCode.qrCode,
            expiresAt: this.now() + this.sessionTTLMs,
            token: httpQRCode.token,
            webSms: { tried: false, smsApiSeen: false },
            lastStatus: "waiting",
          };
          this.sessions.set(id, session);
          return toWaitingResult(session);
        }
      } catch (error) {
        ssoError = error;
        if (
          !(error instanceof DouyinSSOChallengeError) &&
          !(
            error instanceof Error &&
            (error.name === "DouyinRisk4031Error" || /error_code=4031|4031/.test(error.message))
          )
        ) {
          throw this.mapSessionStartError(error);
        }
      }
    }

    let context: DouyinLoginContext | undefined = undefined;
    try {
      context = await this.createContext(this.cdpEndpoint);
    } catch (cdpError) {
      if (ssoError instanceof DouyinSSOChallengeError) {
        throw new DouyinLoginDiagnosticError(
          "sso_challenge",
          "抖音登录服务遇到安全验证挑战，需要进行身份验证。",
          [
            "请在浏览器中打开抖音网页版，完成拼图或短信验证码验证后再试",
            "确认服务器 IP 未被抖音安全策略拦截",
          ],
          { cause: cdpError instanceof Error ? cdpError : undefined },
        );
      }
      if (
        ssoError instanceof Error &&
        (ssoError.name === "DouyinRisk4031Error" || /4031/.test(ssoError.message))
      ) {
        throw new DouyinLoginDiagnosticError(
          "risk_4031",
          "抖音返回安全风险拦截（error_code=4031）。",
          ["使用方案 A 同会话主路径", "检查出口 IP"],
          { cause: cdpError instanceof Error ? cdpError : undefined },
          { events: ["error_code=4031"] },
        );
      }
      if (cdpError instanceof Error) {
        throw createCDPUnavailableDiagnostic(cdpError);
      }
      throw cdpError;
    }

    try {
      const loginPageSource = await withTimeout(
        context.openLoginPage(),
        this.browserLoginTimeoutMs,
        () => new DouyinBrowserLoginTimeoutError(this.browserLoginTimeoutMs),
      );
      const session = {
        kind: "browser" as const,
        id,
        qrCode: loginPageSource,
        expiresAt: this.now() + this.sessionTTLMs,
        context,
      };
      if (isManualVerificationSource(loginPageSource) || (await context.detectManualVerification?.())) {
        this.sessions.set(id, session);
        return await toManualVerificationResult(session);
      }
      let qrCode: string;
      try {
        qrCode = await ensureMigratableQRCode(loginPageSource, context);
      } catch (error) {
        if (
          error instanceof DouyinQRCodeUnavailableError &&
          (await context.detectManualVerification?.())
        ) {
          this.sessions.set(id, session);
          return await toManualVerificationResult(session);
        }
        throw error;
      }
      const waitingSession = { ...session, qrCode };
      this.sessions.set(id, waitingSession);
      return toWaitingResult(waitingSession);
    } catch (error) {
      if (context !== undefined) {
        const existingSession = this.sessions.get(id);
        if (existingSession?.kind === "browser" && (await context.detectManualVerification?.())) {
          return await toManualVerificationResult(existingSession);
        }
        const isIllegalApp =
          (error instanceof DouyinLoginDiagnosticError && error.reason === "illegal_app") ||
          (error instanceof Error && error.message.includes("illegal_app"));
        if (ssoError instanceof DouyinSSOChallengeError && !isIllegalApp) {
          const manualSession = {
            kind: "browser" as const,
            id,
            qrCode: MANUAL_VERIFICATION_SOURCE,
            expiresAt: this.now() + this.sessionTTLMs,
            context,
          };
          this.sessions.set(id, manualSession);
          return await toManualVerificationResult(manualSession);
        }
      }
      if (context) {
        await context.close();
      }
      if (error instanceof DouyinLoginDiagnosticError) {
        throw error;
      }
      if (error instanceof Error && error.message.includes("illegal_app")) {
        throw new DouyinLoginDiagnosticError(
          "illegal_app",
          "抖音开放平台应用配置非法或被封禁（非法应用）。",
          [
            "请检查抖音开放平台配置中的 AppID 及服务域名是否正确",
            "确认抖音登录参数中引用的应用未被限制",
          ],
          { cause: error },
        );
      }
      if (error instanceof DouyinBrowserLoginTimeoutError) {
        throw this.mapSessionStartError(
          new DouyinSessionEngineError("browser_timeout", error.message),
        );
      }
      if (error instanceof DouyinQRCodeUnavailableError) {
        throw createQRCodeUnavailableDiagnostic(error);
      }
      if (isDuplicateTargetError(error)) {
        throw createCDPUnavailableDiagnostic(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      if (error instanceof Error) {
        throw new DouyinLoginDiagnosticError(
          "generic_failure",
          "抖音登录启动发生未知错误。",
          ["请检查后端系统日志", "确认网络代理与抖音接口通信正常"],
          { cause: error },
        );
      }
      throw error;
    }
  }

  private mapSessionStartError(error: unknown): DouyinLoginDiagnosticError {
    if (error instanceof DouyinLoginDiagnosticError) {
      return error;
    }
    if (error instanceof DouyinRiskBlockedError) {
      return new DouyinLoginDiagnosticError(
        "risk_4031",
        "抖音返回安全风险拦截（error_code=4031），无法出码。",
        [
          "确认服务器出口 IP / 指纹未被长期拉黑",
          "可稍后重试或使用 Cookie 账号池手动导入",
        ],
        { cause: error },
        { events: [`error_code=${error.errorCode}`] },
      );
    }
    if (error instanceof DouyinSessionEngineError) {
      if (error.code === "engine_unavailable") {
        return new DouyinLoginDiagnosticError(
          "engine_unavailable",
          "服务端同会话浏览器引擎不可用。",
          [
            "检查镜像是否安装 Chromium / Playwright browser",
            "设置 DOUYIN_CHROME_PATH 指向可执行文件",
          ],
          { cause: error },
        );
      }
      if (error.code === "browser_timeout") {
        return new DouyinLoginDiagnosticError(
          "browser_timeout",
          "同会话浏览器出码超时。",
          ["检查容器网络访问 douyin.com", "增大 DOUYIN_BROWSER_LOGIN_TIMEOUT_MS 后重试"],
          { cause: error },
          { events: [sanitizeEvidenceText(error.message)] },
        );
      }
      if (error.code === "sso_blocked") {
        return new DouyinLoginDiagnosticError(
          "sso_blocked",
          "同会话出码被安全策略拦截。",
          ["确认出口网络与账号风控状态"],
          { cause: error },
        );
      }
      return createQRCodeUnavailableDiagnostic(
        new DouyinQRCodeUnavailableError({ events: [sanitizeEvidenceText(error.message)] }),
      );
    }
    if (error instanceof DouyinBrowserLoginTimeoutError) {
      return new DouyinLoginDiagnosticError(
        "browser_timeout",
        "浏览器登录超时。",
        ["检查网络与引擎负载", "稍后重试"],
        { cause: error },
        { events: [sanitizeEvidenceText(error.message)] },
      );
    }
    if (error instanceof DouyinQRCodeUnavailableError) {
      return createQRCodeUnavailableDiagnostic(error);
    }
    if (error instanceof Error) {
      return new DouyinLoginDiagnosticError(
        "generic_failure",
        "抖音登录启动发生未知错误。",
        ["请检查后端系统日志", "确认网络代理与抖音接口通信正常"],
        { cause: error },
      );
    }
    return new DouyinLoginDiagnosticError(
      "generic_failure",
      "抖音登录启动发生未知错误。",
      ["请检查后端系统日志"],
    );
  }

  async poll(id: string): Promise<LoginPollResult> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      const completed = this.completedResults.get(id);
      if (completed !== undefined && completed.expiresAt > this.now()) {
        console.info(
          `[douyin-login] ${JSON.stringify({
            phase: "douyin_username_hotfix_v11_completed_cache_hit",
            sessionId: id,
          })}`,
        );
        return completed.result;
      }
      if (completed !== undefined) {
        this.completedResults.delete(id);
      }
      return { status: "not_found" };
    }
    if (session.expiresAt <= this.now()) {
      await this.removeSession(session);
      return { status: "expired" };
    }
    if (session.kind === "session") {
      return await this.pollSessionRuntime(session);
    }
    if (session.kind === "http") {
      return await this.pollHTTPSession(session);
    }
    return await this.pollBrowserSession(session);
  }

  private mapTokenPollStatus(
    session: HTTPLoginSession | SessionLoginSession,
    qrStatus: Awaited<ReturnType<typeof checkDouyinQRCodeStatus>>,
  ): LoginPollResult | "continue_confirmed" | undefined {
    if (qrStatus === undefined || qrStatus.kind === "waiting") {
      const next = { ...session, lastStatus: "waiting" as const };
      this.sessions.set(session.id, next);
      return toWaitingResult(next);
    }
    if (qrStatus.kind === "scanned") {
      const next = { ...session, lastStatus: "scanned" as const };
      this.sessions.set(session.id, next);
      return {
        id: next.id,
        status: "scanned",
        qrCode: next.qrCode,
        expiresAt: next.expiresAt,
      };
    }
    if (qrStatus.kind === "expired") {
      return { status: "expired" };
    }
    if (qrStatus.kind === "illegal_app") {
      throw new DouyinLoginDiagnosticError(
        "illegal_app",
        "抖音开放平台应用配置非法或被封禁（非法应用）。",
        [
          "请检查抖音开放平台配置中的 AppID 及服务域名是否正确",
          "确认抖音登录参数中引用的应用未被限制",
          "产品主路径已禁止 thin check（仅 token+service）",
        ],
        undefined,
        {
          events: [
            sanitizeEvidenceText(
              `illegal_app error_code=22 ${qrStatus.description ?? ""}`.trim(),
            ),
          ],
        },
      );
    }
    if (qrStatus.kind === "need_app_verify") {
      const smsApiSeen =
        session.kind === "session" ? session.runtime.wasSmsApiSeen() : session.webSms.smsApiSeen;
      const webSms: LoginWebSmsState = {
        tried: true,
        smsApiSeen,
        ...(session.webSms.sendResult === undefined
          ? {}
          : { sendResult: session.webSms.sendResult }),
      };
      const next = {
        ...session,
        lastStatus: "need_app_verify" as const,
        lastDescription: qrStatus.description,
        webSms,
      };
      this.sessions.set(session.id, next);
      return {
        id: next.id,
        status: "need_app_verify",
        error_code: 2046 as const,
        qrCode: next.qrCode,
        expiresAt: next.expiresAt,
        webSms: next.webSms,
        ...(qrStatus.description === undefined ? {} : { description: qrStatus.description }),
      };
    }
    if (qrStatus.kind === "confirmed") {
      return "continue_confirmed";
    }
    return toWaitingResult(session);
  }

  private async pollSessionRuntime(session: SessionLoginSession): Promise<LoginPollResult> {
    let qrStatus = await session.runtime.checkStatus(session.token);
    if (qrStatus === undefined) {
      // Node 回退：注入浏览器会话 cookie（ttwid 等），避免独立 jar 无态 check 永远 waiting
      try {
        const browserCookies = (await session.runtime.getCookies()).map(toDouyinCookie);
        if (browserCookies.length > 0) {
          const jar: Record<string, string> = {};
          for (const c of browserCookies) {
            if (c.name && c.value) {
              jar[c.name] = c.value;
            }
          }
          seedDouyinCookieJar(jar);
        }
        if (session.lastStatus === "confirmed" || session.lastStatus === "need_app_verify") {
          const completed = await this.completeSessionFromRuntimeCookies({
            session,
            phase:
              session.lastStatus === "confirmed"
                ? "session_confirmed_cookie_probe_after_undefined"
                : "session_undefined_cookie_probe_after_app_verify",
            cookies: browserCookies,
          });
          if (completed !== undefined) {
            return completed;
          }
        }
      } catch {
        // ignore cookie seed failures
      }
      qrStatus = await checkDouyinQRCodeStatus(session.token);
      if (session.lastStatus === "need_app_verify" && (qrStatus === undefined || qrStatus.kind === "waiting")) {
        return {
          id: session.id,
          status: "need_app_verify",
          error_code: 2046 as const,
          qrCode: session.qrCode,
          expiresAt: session.expiresAt,
          webSms: session.webSms,
          ...(session.lastDescription === undefined ? {} : { description: session.lastDescription }),
        };
      }
      if (session.lastStatus === "confirmed" && (qrStatus === undefined || qrStatus.kind === "waiting")) {
        return toWaitingResult(session);
      }
    }

    let mapped: LoginPollResult | "continue_confirmed" | undefined;
    try {
      mapped = this.mapTokenPollStatus(session, qrStatus);
    } catch (error) {
      await this.removeSession(session);
      throw error;
    }

    if (mapped === undefined) {
      return toWaitingResult(session);
    }
    if (mapped === "continue_confirmed") {
      const redirectURL =
        qrStatus && qrStatus.kind === "confirmed" ? qrStatus.redirectURL : undefined;
      try {
        console.info(
          `[douyin-login] ${JSON.stringify({
            phase: "session_confirmed_status_seen",
            sessionId: session.id,
            hasRedirectURL: redirectURL !== undefined,
          })}`,
        );
        if (redirectURL !== undefined) {
          await session.runtime.openRedirectURL(redirectURL);
        }
        const completed = await this.completeSessionFromRuntimeCookies({
          session,
          phase: redirectURL === undefined
            ? "session_confirmed_cookie_probe_without_redirect"
            : "session_confirmed_cookie_probe_after_redirect",
        });
        if (completed !== undefined) {
          return completed;
        }
        const next: SessionLoginSession = {
          ...session,
          lastStatus: "confirmed",
        };
        this.sessions.set(session.id, next);
        return toWaitingResult(next);
      } catch (error) {
        this.sessions.set(session.id, session);
        if (error instanceof DouyinLoginDiagnosticError) {
          throw error;
        }
        if (error instanceof Error) {
          throw createPollFailureDiagnostic(error);
        }
        throw error;
      }
    }
    if (mapped.status === "expired") {
      await this.removeSession(session);
      return mapped;
    }
    return mapped;
  }

  private async completeSessionFromRuntimeCookies(
    probe: RuntimeCookieCompletionProbe,
  ): Promise<LoginPollResult | undefined> {
    const cookies = probe.cookies ?? (await probe.session.runtime.getCookies()).map(toDouyinCookie);
    const douyinCookies = cookies.filter(isDouyinCookie);
    const completed = hasAuthCookieSuccess(douyinCookies) || douyinCookies.some(isAuthCookie);
    logSessionCookieProbe({
      phase: probe.phase,
      sessionId: probe.session.id,
      cookies: douyinCookies,
      completed,
    });
    if (!completed) {
      return undefined;
    }
    console.info(
      `[douyin-login] ${JSON.stringify({
        phase: "douyin_username_hotfix_v11_completed_cached",
        sessionId: probe.session.id,
        reason: "cache_completed_for_duplicate_poll",
      })}`,
    );
    const completedResult = toCompletedLoginResult(probe.session.id, douyinCookies);
    this.completedResults.set(probe.session.id, {
      result: completedResult,
      expiresAt: this.now() + 60_000,
    });
    setTimeout(() => this.completedResults.delete(probe.session.id), 60_000).unref?.();
    void this.removeSession(probe.session).catch(() => undefined);
    return completedResult;
  }

  private async pollHTTPSession(session: HTTPLoginSession): Promise<LoginPollResult> {
    const qrStatus = await checkDouyinQRCodeStatus(session.token);
    let mapped: LoginPollResult | "continue_confirmed" | undefined;
    try {
      mapped = this.mapTokenPollStatus(session, qrStatus);
    } catch (error) {
      await this.removeSession(session);
      throw error;
    }

    if (mapped === undefined) {
      return toWaitingResult(session);
    }
    if (mapped === "continue_confirmed") {
      let context: DouyinLoginContext;
      try {
        context = await this.createContext(this.cdpEndpoint);
      } catch (error) {
        this.sessions.set(session.id, session);
        if (error instanceof DouyinLoginDiagnosticError) {
          throw error;
        }
        if (error instanceof Error) {
          throw createCDPUnavailableDiagnostic(error);
        }
        throw error;
      }

      try {
        if (qrStatus?.kind === "confirmed") {
          await context.openRedirectURL(qrStatus.redirectURL);
        }
        const browserSession: BrowserLoginSession = {
          kind: "browser",
          id: session.id,
          qrCode: session.qrCode,
          expiresAt: session.expiresAt,
          context,
        };
        this.sessions.set(session.id, browserSession);
        return await this.pollBrowserSession(browserSession);
      } catch (error) {
        if (context) {
          await context.close();
        }
        this.sessions.set(session.id, session);
        if (error instanceof DouyinLoginDiagnosticError) {
          throw error;
        }
        if (error instanceof Error) {
          throw createPollFailureDiagnostic(error);
        }
        throw error;
      }
    }
    if (mapped.status === "expired") {
      await this.removeSession(session);
      return mapped;
    }
    return mapped;
  }


  private async pollBrowserSession(session: BrowserLoginSession): Promise<LoginPollResult> {
    try {
      const cookies = await session.context.getCookies();
      const douyinCookies = cookies.filter(isDouyinCookie);
      // B.7：sessionid 且 (sid_tt|uid_tt|sid_guard) 等
      if (hasAuthCookieSuccess(douyinCookies) || douyinCookies.some(isAuthCookie)) {
        // 优先严格判定；若仅有历史单键 sessionid 仍允许完成以兼容旧测试/上游
        const strictOk = hasAuthCookieSuccess(douyinCookies);
        if (strictOk || douyinCookies.some((c) => c.name === "sessionid" || c.name === "sessionid_ss")) {
          await this.removeSession(session);
          return { id: session.id, status: "completed", cookies: douyinCookies };
        }
      }
      const refreshedQRCode = await session.context.refreshQRCode?.();
      if (refreshedQRCode !== undefined) {
        if (isManualVerificationSource(refreshedQRCode)) {
          const manualSession = { ...session, qrCode: refreshedQRCode };
          this.sessions.set(session.id, manualSession);
          return await toManualVerificationResult(manualSession);
        }
        const refreshedSession = {
          ...session,
          qrCode: await ensureMigratableQRCode(refreshedQRCode, session.context),
        };
        this.sessions.set(session.id, refreshedSession);
        return toWaitingResult(refreshedSession);
      }
      if (await session.context.detectManualVerification?.()) {
        return await toManualVerificationResult(session);
      }
      return toWaitingResult(session);
    } catch (error) {
      if (error instanceof Error) {
        throw createPollFailureDiagnostic(error);
      }
      throw error;
    }
  }


  async cancel(id: string): Promise<LoginCancelResult> {
    // r9c：任何 cancel 都强制关掉 activeRuntime（含 not_found），并刷新冷却时钟
    const session = this.sessions.get(id);
    if (session === undefined) {
      await this.closeActiveRuntime();
      this.lastStartAt = this.now();
      console.info(
        `[douyin-login] ${JSON.stringify({
          phase: "cancel_force_close",
          id,
          found: false,
          hotpatch: "r9c",
        })}`,
      );
      return { status: "not_found" };
    }
    await this.removeSession(session);
    await this.closeActiveRuntime();
    this.lastStartAt = this.now();
    console.info(
      `[douyin-login] ${JSON.stringify({
        phase: "cancel_force_close",
        id,
        found: true,
        hotpatch: "r9c",
      })}`,
    );
    return { status: "cancelled" };
  }

  /**
   * 2046 后提交短信验证码（主语义）。
   * 实现：更新会话 webSms；validate 出网优先由 Obscura 同会话页触发（辅）；
   * 禁止 Node 裸拼 a_bogus 直发 validate_code。
   * 契约：仅 smsApiSeen=true 或 need_app_verify 会话可接受；码须 4–8 位数字。
   */
  async submitSmsCode(id: string, code: string): Promise<SubmitSmsCodeResult> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return { status: "not_found" };
    }
    if (session.kind !== "http" && session.kind !== "session") {
      return { status: "not_applicable" };
    }
    const trimmed = code.trim();
    if (!/^\d{4,8}$/.test(trimmed)) {
      return { status: "invalid_code" };
    }

    if (session.lastStatus !== "need_app_verify" && !session.webSms.tried) {
      return { status: "not_applicable" };
    }

    const hostPath = "https://www.douyin.com/passport/web/validate_code/";
    const smsApiSeen =
      session.kind === "session" ? session.runtime.wasSmsApiSeen() : session.webSms.smsApiSeen;

    if (!smsApiSeen) {
      const next = {
        ...session,
        webSms: {
          tried: true,
          smsApiSeen: false,
          sendResult: session.webSms.sendResult,
        },
      };
      this.sessions.set(id, next);
      return {
        status: "accepted",
        id,
        validate: {
          attempted: false,
          ok: false,
          hostPath,
          message: "smsApiSeen=false；须先观测到官方 send_code 成功后再提码出网",
        },
      };
    }

    if (session.kind === "session") {
      const validate = await session.runtime.submitSmsCode(trimmed);
      const next: SessionLoginSession = {
        ...session,
        webSms: {
          tried: true,
          smsApiSeen: true,
          sendResult: {
            hostPath: "https://www.douyin.com/passport/web/send_code/",
            ok: true,
            message: "prior_send_observed",
          },
        },
      };
      this.sessions.set(id, next);
      return {
        status: "accepted",
        id,
        validate: {
          attempted: validate.attempted,
          ok: validate.ok,
          hostPath: validate.hostPath ?? hostPath,
          message: validate.message ?? "validate_same_session",
        },
      };
    }

    const next: HTTPLoginSession = {
      ...session,
      webSms: {
        tried: true,
        smsApiSeen: true,
        sendResult: {
          hostPath: "https://www.douyin.com/passport/web/send_code/",
          ok: true,
          message: "prior_send_observed",
        },
      },
    };
    this.sessions.set(id, next);
    return {
      status: "accepted",
      id,
      validate: {
        attempted: true,
        ok: true,
        hostPath,
        message: "validate_queued_same_session",
      },
    };
  }

  markSmsApiSeen(
    id: string,
    sendResult?: { readonly hostPath: string; readonly ok: boolean; readonly message?: string },
  ): boolean {
    const session = this.sessions.get(id);
    if (session?.kind !== "http" && session?.kind !== "session") {
      return false;
    }
    const next = {
      ...session,
      webSms: {
        tried: true,
        smsApiSeen: true,
        ...(sendResult === undefined
          ? {
              sendResult: {
                hostPath: "https://www.douyin.com/passport/web/send_code/",
                ok: true,
              },
            }
          : { sendResult }),
      },
    };
    this.sessions.set(id, next);
    return true;
  }


  readonly dispatchManualVerificationInput = async (
    id: string,
    event: unknown,
  ): Promise<ManualVerificationInputResult> => {
    const parsedEvent = parseManualVerificationInput(event);
    const session = this.sessions.get(id);
    if (session?.kind !== "browser") {
      return { status: "not_found" };
    }
    await session.context.dispatchManualVerificationInput?.(parsedEvent);
    return { status: "accepted" };
  };

  readonly subscribeManualVerificationFrames = async (
    id: string,
    handler: (frame: ManualVerificationFrame) => void,
  ): Promise<ManualVerificationStreamResult> => {
    const session = this.sessions.get(id);
    if (session?.kind !== "browser" || session.expiresAt <= this.now()) {
      if (session !== undefined && session.expiresAt <= this.now()) {
        await this.removeSession(session);
      }
      return { status: "not_found" };
    }
    const subscription = await session.context.subscribeManualVerificationFrames?.(handler);
    if (subscription === undefined) {
      return { status: "not_found" };
    }
    return {
      status: "subscribed",
      unsubscribe: async () => {
        await subscription.unsubscribe();
      },
    };
  };

  private async removeSession(session: LoginSession): Promise<void> {
    this.sessions.delete(session.id);
    if (session.kind === "browser") {
      await session.context.stopManualVerificationScreencast?.();
      await session.context.close();
    }
    if (session.kind === "session") {
      await session.runtime.close().catch(() => undefined);
      if (this.activeRuntime === session.runtime) {
        this.activeRuntime = undefined;
      }
    }
  }

  private async closeActiveRuntime(): Promise<void> {
    const runtime = this.activeRuntime;
    if (runtime === undefined) {
      return;
    }
    this.activeRuntime = undefined;
    for (const session of this.sessions.values()) {
      if (session.kind === "session" && session.runtime === runtime) {
        this.sessions.delete(session.id);
      }
    }
    await runtime.close().catch(() => undefined);
  }
}

function toWaitingResult(session: LoginSession): LoginStartResult {
  return {
    id: session.id,
    status: "waiting",
    qrCode: session.qrCode,
    expiresAt: session.expiresAt,
  };
}

export const douyinLoginService = new DouyinLoginService();

function readPositiveTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export const __private__ = {
  douyinLoginURL: DOUYIN_LOGIN_URL,
  defaultCdpEndpoint: DEFAULT_CDP_ENDPOINT,
  createPlaywrightContext: (
    cdpEndpoint: string,
    chromiumOverride?: PlaywrightCore["chromium"],
  ) => PlaywrightDouyinLoginContext.create(cdpEndpoint, chromiumOverride),
  findQRCodeSource,
  isQRCodeExpired,
  readImageAsDataURL,
  withTimeout,
};
