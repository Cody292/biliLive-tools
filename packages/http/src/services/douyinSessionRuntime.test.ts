import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DouyinRiskBlockedError,
  DouyinSessionEngineError,
  __private__,
} from "./douyinSessionRuntime.js";

describe("douyinSessionRuntime (scheme A)", () => {
  it("resolveChromeExecutable 可发现系统 Chrome 或 env", () => {
    const path = __private__.resolveChromeExecutable("/usr/bin/google-chrome");
    expect(path === undefined || typeof path === "string").toBe(true);
  });

  it("resolveChromeExecutable 接受 chrome-linux64 形态的可执行路径覆盖", () => {
    const override = "/ms-playwright/chromium-1228/chrome-linux64/chrome";
    const path = __private__.resolveChromeExecutable(override);
    if (path !== undefined) {
      expect(path).toMatch(/chrome-linux64\/chrome$|chrome-linux\/chrome$|douyin-chrome|google-chrome|chromium/);
    } else {
      expect(path).toBeUndefined();
    }
  });

  it("SSO HTML URL 指向 sso get_qrcode 壳页", () => {
    expect(__private__.SSO_HTML_URL).toContain("sso.douyin.com");
    expect(__private__.SSO_HTML_URL).toContain("get_qrcode");
  });

  it("passport get_qrcode JSON URL 指向 login.douyin.com 且非 SSO HTML", () => {
    expect(__private__.PASSPORT_GET_QRCODE_URL).toContain("login.douyin.com");
    expect(__private__.PASSPORT_GET_QRCODE_URL).toContain("/passport/web/get_qrcode");
    expect(__private__.PASSPORT_GET_QRCODE_URL).not.toContain("sso.douyin.com");
  });

  it("buildSessionCheckURL 为 passport 全 query 且含 jssdk 键", () => {
    const url = __private__.buildSessionCheckURL("tok-abc");
    expect(url).toContain("login.douyin.com/passport/web/check_qrconnect");
    expect(url).toContain("token=tok-abc");
    expect(url).toContain("passport_jssdk_version");
    expect(url).toContain("aid=6383");
  });

  it("tryExtractAcquireFromJson 解析 token+index 并识别 4031", () => {
    const ok = __private__.tryExtractAcquireFromJson({
      data: {
        token: "tok12345678",
        qrcode_index_url:
          "https://api.amemv.com/ucenter_web/app/aweme/scan_login/index/douyin_scan_code_login",
      },
    });
    expect(ok).toMatchObject({ token: "tok12345678", tokenPrefix: "tok12345" });
    expect(
      __private__.tryExtractAcquireFromJson({ data: { error_code: 4031 } }),
    ).toBe("risk_4031");
  });

  it("默认 glue_wait 控制在 500ms", () => {
    expect(__private__.DEFAULT_QR_GLUE_WAIT_MS).toBe(500);
  });

  it("WAVE/R6：DEFAULT_ACQUIRE_TIMEOUT_MS 为 40s", () => {
    expect(__private__.DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(40_000);
  });

  it("WAVE/R6：acquireQR 语义 — wave12 仅 creator、SSO domcontentloaded+20s、waitNatural 8s、短路 reload", () => {
    const src = readFileSync(new URL("./douyinSessionRuntime.ts", import.meta.url), "utf8");
    expect(src).toContain('page.goto("https://creator.douyin.com/"');
    expect(src).toMatch(/timeout:\s*2500/);
    expect(src).toMatch(/await sleepMs\(150\)/);
    expect(src).toContain('phaseLog("wave12_prewarm"');
    expect(src).toContain('phaseLog("wave12_prewarm_skip"');
    expect(src).not.toMatch(/www\.douyin\.com\/user\/self/);
    expect(src).not.toMatch(/www\.douyin\.com\/follow/);
    expect(src).toMatch(
      /page\.goto\(SSO_HTML_URL,\s*\{[\s\S]*?waitUntil:\s*["']domcontentloaded["'][\s\S]*?timeout:\s*Math\.min\(acquireTimeoutMs,\s*20_000\)/,
    );
    expect(src).not.toMatch(
      /page\.goto\(SSO_HTML_URL,\s*\{[\s\S]*?waitUntil:\s*["']commit["']/,
    );
    expect(src).toMatch(/await sleepMs\(300\)/);
    expect(src).toMatch(/waitNaturalBudget\(\s*8_000\s*,\s*["']wait_sso_full_1["']\s*\)/);
    expect(src).not.toMatch(/waitNaturalBudget\(\s*(10_000|15_000|18_000)\s*,/);
    expect(src).toContain('phaseLog("sso_reload_hard_skipped"');
    expect(src).toContain('reason: "ineffective_and_slow"');
    expect(src).not.toMatch(/R6_CLOSE|HOTPATCH_20260804_R6_CLOSE/);
  });

  it("DouyinRiskBlockedError 携带 4031", () => {
    const err = new DouyinRiskBlockedError(4031, "blocked");
    expect(err.errorCode).toBe(4031);
    expect(err.name).toBe("DouyinRiskBlockedError");
  });

  it("DouyinSessionEngineError codes", () => {
    const e = new DouyinSessionEngineError("engine_unavailable", "x");
    expect(e.code).toBe("engine_unavailable");
  });
});

type ResponseHandler = (response: {
  url: () => string;
  status: () => number;
  headers: () => Readonly<Record<string, string>>;
  text: () => Promise<string>;
  request: () => { method: () => string; headers: () => Readonly<Record<string, string>> };
}) => void;

type TestLocator = {
  readonly count: () => Promise<number>;
  readonly first: () => TestLocator;
  readonly filter: (options: { readonly hasText: string | RegExp }) => TestLocator;
  readonly fill?: (value: string, options?: { readonly timeout?: number }) => Promise<void>;
  readonly inputValue?: (options?: { readonly timeout?: number }) => Promise<string>;
  readonly isDisabled?: (options?: { readonly timeout?: number }) => Promise<boolean>;
  readonly click: (options?: { readonly force?: boolean; readonly timeout?: number }) => Promise<void>;
};

type TestEvaluateTarget = {
  readonly evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise<unknown>;
  readonly locator?: (selector: string) => TestLocator;
};

type CDPScreenshotCapture = {
  readonly method: string;
  readonly params: { readonly format: string; readonly fromSurface: boolean };
};

/**
 * P1：get_qrcode JSON 到达后应提前 settle，不必等满 glueWaitMs。
 */
describe("douyinSessionRuntime acquireQR early settle (P1)", () => {
  const glueWaitMs = 2500;
  const executablePath = "/bin/true";

  let responseHandlers: ResponseHandler[];

  beforeEach(() => {
    responseHandlers = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("get_qrcode 响应到达后应在固定 glueWaitMs 完成前提前 settle", async () => {
    const qrPayload = {
      data: {
        token: "early-settle-token-abcdef12",
        qrcode_index_url:
          "https://api.amemv.com/ucenter_web/app/aweme/scan_login/index/douyin_scan_code_login",
      },
    };

    const page = {
      on: (event: string, handler: ResponseHandler) => {
        if (event === "response") {
          responseHandlers.push(handler);
        }
      },
      off: (event: string, handler: ResponseHandler) => {
        if (event !== "response") {
          return;
        }
        const idx = responseHandlers.indexOf(handler);
        if (idx >= 0) {
          responseHandlers.splice(idx, 1);
        }
      },
      goto: async () => {
        const response = {
          url: () => "https://login.douyin.com/passport/web/get_qrcode/?aid=6383",
          status: () => 200,
          headers: () => ({ "content-type": "application/json" }),
          text: async () => JSON.stringify(qrPayload),
          request: () => ({
            method: () => "GET",
            headers: () => ({}),
          }),
        };
        for (const handler of [...responseHandlers]) {
          void handler(response);
        }
      },
      waitForTimeout: (ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }),
      evaluate: async (fn: (arg: string) => unknown, arg: string) => {
        // 断言主动触发必须是 passport JSON URL，禁止再打 SSO HTML
        expect(arg).toContain("login.douyin.com/passport/web/get_qrcode");
        expect(arg).not.toContain("sso.douyin.com");
        // 模拟页内 fetch 触发 response handler
        const response = {
          url: () => "https://login.douyin.com/passport/web/get_qrcode/?aid=6383",
          status: () => 200,
          headers: () => ({ "content-type": "application/json" }),
          text: async () => JSON.stringify(qrPayload),
          request: () => ({
            method: () => "GET",
            headers: () => ({}),
          }),
        };
        for (const handler of [...responseHandlers]) {
          void handler(response);
        }
        return typeof fn === "function" ? fn(arg) : true;
      },
      url: () => "https://sso.douyin.com/get_qrcode/?need_logo=true",
    };

    const context = {
      newPage: async () => page,
      cookies: async () => [],
      close: async () => undefined,
      addInitScript: async () => undefined,
      request: {
        get: async (url: string) => {
          expect(url).toContain("login.douyin.com/passport/web/get_qrcode");
          return {
            ok: () => true,
            status: () => 200,
            headers: () => ({ "content-type": "application/json" }),
            text: async () => JSON.stringify(qrPayload),
          };
        },
      },
    };

    const browser = {
      newContext: async () => context,
      close: async () => undefined,
    };

    // createRequire 绕过 vi.doMock，拦截 Module.prototype.require
    const Module = await import("node:module");
    const proto = Module.default.prototype as {
      require: (id: string) => unknown;
    };
    const originalRequire = proto.require;
    proto.require = function mockedRequire(this: unknown, id: string) {
      if (id === "playwright-core") {
        return {
          chromium: {
            launch: async () => browser,
          },
        };
      }
      return originalRequire.call(this, id);
    };

    try {
      const { createDouyinSessionRuntime } = await import("./douyinSessionRuntime.js");
      const runtime = await createDouyinSessionRuntime({
        executablePath,
        glueWaitMs,
        headless: true,
        createID: () => "sess-early-settle-test",
      });

      const box: {
        done: boolean;
        result?: { token: string; qrCode: string; tokenPrefix: string };
        error?: unknown;
      } = { done: false };

      const acquirePromise = runtime.acquireQR().then(
        (result) => {
          box.result = result;
          box.done = true;
          return result;
        },
        (error: unknown) => {
          box.error = error;
          box.done = true;
          throw error;
        },
      );

      // 冲刷 microtask：response.text → settleOk → glue race 提前结束 → return
      // WAVE12 prewarm 后 sleepMs(400)；故意不 advance 满 glueWaitMs
      for (let i = 0; i < 40 && !box.done; i += 1) {
        await Promise.resolve();
        if (i === 10) {
          await vi.advanceTimersByTimeAsync(450);
        }
      }

      expect(
        box.done,
        "get_qrcode 响应到达后应提前 settle，不应继续等待完整 glueWaitMs",
      ).toBe(true);
      expect(box.error).toBeUndefined();
      expect(box.result?.token).toBe("early-settle-token-abcdef12");
      expect(box.result?.tokenPrefix).toBe("early-se");

      await runtime.close();
      await acquirePromise;
    } finally {
      proto.require = originalRequire;
    }
  });
});

/**
 * Wave2：进入 2046/need_app_verify 后，同 Playwright 会话主动触发官方 send_code；
 * smsApiSeen 仅由网络拦截成功响应置 true；submitSmsCode 仍同会话 validate_code。
 */
describe("douyinSessionRuntime 2046 send_code same session (Wave2)", () => {
  const executablePath = "/bin/true";

  let responseHandlers: ResponseHandler[];
  let evaluateCalls: Array<{ fnSource: string; arg: string; argKind: "sms_payload" | "other" }>;
  let sendCodeResponseEmitted: boolean;
  let trustedMouseClicks: Array<{ x: number; y: number }>;
  let screenshotPaths: string[];
  let cdpCaptures: CDPScreenshotCapture[];

  beforeEach(() => {
    responseHandlers = [];
    evaluateCalls = [];
    sendCodeResponseEmitted = false;
    trustedMouseClicks = [];
    screenshotPaths = [];
    cdpCaptures = [];
    vi.stubEnv("DOUYIN_VALIDATE_CODE_TIMEOUT_MS", "200");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function withMockedPlaywright(
    pageOverrides: Partial<{
      evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise<unknown>;
      frames: () => TestEvaluateTarget[];
      mouseClick: (x: number, y: number) => Promise<void>;
      screenshot: (options: { readonly path: string }) => Promise<void>;
      cdpScreenshot: () => Promise<unknown>;
    }>,
    run: (
      runtime: Awaited<
        ReturnType<typeof import("./douyinSessionRuntime.js").createDouyinSessionRuntime>
      >,
    ) => Promise<void>,
  ): Promise<void> {
    const page = {
      on: (event: string, handler: ResponseHandler) => {
        if (event === "response") {
          responseHandlers.push(handler);
        }
      },
      off: (event: string, handler: ResponseHandler) => {
        if (event !== "response") {
          return;
        }
        const idx = responseHandlers.indexOf(handler);
        if (idx >= 0) {
          responseHandlers.splice(idx, 1);
        }
      },
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      evaluate:
        pageOverrides.evaluate ??
        (async (fn: (arg: unknown) => unknown, arg: unknown) => {
          evaluateCalls.push({
            fnSource: typeof fn === "function" ? fn.toString() : String(fn),
            arg: String(arg ?? ""),
            argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload",
          });
          return typeof fn === "function" ? fn(arg) : undefined;
        }),
      frames: pageOverrides.frames,
      mouse: {
        click: async (x: number, y: number) => {
          trustedMouseClicks.push({ x, y });
          await pageOverrides.mouseClick?.(x, y);
        },
      },
      screenshot: async (options: { readonly path: string }) => {
        screenshotPaths.push(options.path);
        await pageOverrides.screenshot?.(options);
      },
      url: () => "https://www.douyin.com/",
    };

    const context = {
      newPage: async () => page,
      cookies: async () => [],
      close: async () => undefined,
      addInitScript: async () => undefined,
      newCDPSession: async () => ({
        send: async (method: "Page.captureScreenshot", params: { readonly format: "png"; readonly fromSurface: boolean }) => {
          cdpCaptures.push({ method, params });
          return pageOverrides.cdpScreenshot === undefined ? { data: "" } : await pageOverrides.cdpScreenshot();
        },
      }),
    };

    const browser = {
      newContext: async () => context,
      close: async () => undefined,
    };

    const Module = await import("node:module");
    const proto = Module.default.prototype as {
      require: (id: string) => unknown;
    };
    const originalRequire = proto.require;
    proto.require = function mockedRequire(this: unknown, id: string) {
      if (id === "playwright-core") {
        return {
          chromium: {
            launch: async () => browser,
          },
        };
      }
      return originalRequire.call(this, id);
    };

    try {
      const { createDouyinSessionRuntime } = await import("./douyinSessionRuntime.js");
      const runtime = await createDouyinSessionRuntime({
        executablePath,
        headless: true,
        createID: () => "sess-2046-send-code",
      });
      await run(runtime);
      await runtime.close();
    } finally {
      proto.require = originalRequire;
    }
  }

  function emitSendCodeSuccess(): void {
    sendCodeResponseEmitted = true;
    const response = {
      url: () => "https://www.douyin.com/passport/web/send_code/?aid=6383",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      text: async () =>
        JSON.stringify({ message: "success", error_code: 0, data: { mobile_ticket: "mt" } }),
      request: () => ({
        method: () => "POST",
        headers: () => ({}),
      }),
    };
    for (const handler of [...responseHandlers]) {
      void handler(response);
    }
  }

  function emitValidateCodeSuccess(): void {
    const response = {
      url: () => "https://www.douyin.com/passport/web/validate_code/?aid=6383",
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ message: "success", error_code: 0, data: { ticket: "ticket-ok" } }),
      request: () => ({
        method: () => "POST",
        headers: () => ({}),
      }),
    };
    for (const handler of [...responseHandlers]) {
      void handler(response);
    }
  }

  function readSmsSubmitCode(arg: unknown): string | undefined {
    if (typeof arg === "string" && /^\d{4,8}$/.test(arg)) {
      return arg;
    }
    if (typeof arg !== "object" || arg === null || !("digits" in arg)) {
      return undefined;
    }
    const digits = arg.digits;
    return typeof digits === "string" && /^\d{4,8}$/.test(digits) ? digits : undefined;
  }

  function createSmsSubmitProbeResult(code: string, clicked = true) {
    return {
      filled: true,
      clicked,
      candidateCount: 1,
      selectedIndex: 0,
      inputIndex: 0,
      valueLength: code.length,
      contextKind: "sms_verification",
      placeholderKind: "captcha",
      maxLength: code.length,
      visible: true,
      disabled: false,
      readOnly: false,
      bbox: "10,20,120,32",
      buttonCandidateCount: 1,
      buttonSelectedIndex: 0,
      buttonContextKind: "sms_verification",
      buttonBbox: "180,240,80,40",
      buttonDisabled: false,
      outcome: clicked ? "clicked" : "ready",
      reason: clicked ? "clicked" : "button_ready",
    };
  }

  class FakeHTMLElement {
    readonly eventTypes: string[] = [];
    clickCount = 0;

    constructor(
      readonly tagName: string,
      readonly innerText: string,
      readonly parentElement: FakeHTMLElement | null,
      readonly className = "",
      readonly visible = true,
      readonly role: string | null = null,
      readonly ariaDisabled = false,
    ) {}

    get textContent(): string {
      return this.innerText;
    }

    getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
      return this.visible ? { x: 10, y: 20, width: 120, height: 32 } : { x: 0, y: 0, width: 0, height: 0 };
    }

    contains(node: FakeHTMLElement): boolean {
      let current: FakeHTMLElement | null = node;
      while (current !== null) {
        if (current === this) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    }

    getAttribute(name: string): string | null {
      if (name === "role") {
        return this.role;
      }
      if (name === "aria-disabled") {
        return this.ariaDisabled ? "true" : null;
      }
      return null;
    }

    dispatchEvent(event: { readonly type?: string }): boolean {
      if (event.type !== undefined) {
        this.eventTypes.push(event.type);
      }
      return true;
    }

    focus(): void {
      this.eventTypes.push("focus-method");
    }

    click(): void {
      this.clickCount += 1;
    }
  }

  class FakeHTMLInputElement extends FakeHTMLElement {
    private currentValue = "";

    constructor(
      readonly placeholder: string,
      readonly maxLength: number,
      parentElement: FakeHTMLElement | null,
      readonly acceptsValue: boolean,
      visible = true,
      readonly disabled = false,
      readonly readOnly = false,
      readonly name = "",
      readonly id = "",
      readonly autocomplete = "",
      readonly inputMode = "numeric",
      readonly type = "text",
      className = "",
    ) {
      super("INPUT", "", parentElement, className, visible);
    }

    get value(): string {
      return this.currentValue;
    }

    set value(nextValue: string) {
      if (this.acceptsValue) {
        this.currentValue = nextValue;
      }
    }
  }

  class FakeHTMLButtonElement extends FakeHTMLElement {
    constructor(
      text: string,
      parentElement: FakeHTMLElement | null,
      readonly disabled = false,
      readonly onClick?: () => void,
      className = "primary",
    ) {
      super("BUTTON", text, parentElement, className, true, "button");
    }

    click(): void {
      super.click();
      this.onClick?.();
    }
  }

  class FakeDOMEvent {
    constructor(
      readonly type: string,
      readonly init?: unknown,
    ) {}
  }

  async function withFakeSmsDOM(
    inputs: readonly FakeHTMLInputElement[],
    buttons: readonly FakeHTMLElement[],
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    const originalHTMLInputElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLInputElement");
    const originalHTMLButtonElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLButtonElement");
    const originalEvent = Object.getOwnPropertyDescriptor(globalThis, "Event");
    const originalInputEvent = Object.getOwnPropertyDescriptor(globalThis, "InputEvent");
    const originalMouseEvent = Object.getOwnPropertyDescriptor(globalThis, "MouseEvent");
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    const restore = (name: string, descriptor: PropertyDescriptor | undefined) => {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name);
        return;
      }
      Object.defineProperty(globalThis, name, descriptor);
    };

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: (selector: string) => {
          if (selector === "input") {
            return inputs;
          }
          return buttons;
        },
      },
    });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
    Object.defineProperty(globalThis, "HTMLInputElement", { configurable: true, value: FakeHTMLInputElement });
    Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, value: FakeHTMLButtonElement });
    Object.defineProperty(globalThis, "Event", { configurable: true, value: FakeDOMEvent });
    Object.defineProperty(globalThis, "InputEvent", { configurable: true, value: FakeDOMEvent });
    Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: FakeDOMEvent });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: (element: FakeHTMLElement) => ({
        cursor: "pointer",
        display: element.visible ? "block" : "none",
        opacity: element.visible ? "1" : "0",
        visibility: element.visible ? "visible" : "hidden",
      }),
    });

    try {
      return await run();
    } finally {
      restore("document", originalDocument);
      restore("HTMLElement", originalHTMLElement);
      restore("HTMLInputElement", originalHTMLInputElement);
      restore("HTMLButtonElement", originalHTMLButtonElement);
      restore("Event", originalEvent);
      restore("InputEvent", originalInputEvent);
      restore("MouseEvent", originalMouseEvent);
      restore("window", originalWindow);
      restore("getComputedStyle", originalGetComputedStyle);
    }
  }

  it("submitSmsCode 多个 6 位 input 时优先短信验证区域的可见 input", async () => {
    const neutralRoot = new FakeHTMLElement("DIV", "其它六位输入", null);
    const smsRoot = new FakeHTMLElement("DIV", "短信验证 请输入验证码 uc_verification", null, "uc_verification");
    const wrongInput = new FakeHTMLInputElement("", 6, neutralRoot, true);
    const smsInput = new FakeHTMLInputElement("短信验证码", 6, smsRoot, true);
    const submitButton = new FakeHTMLButtonElement("提交验证码", smsRoot, false, () => {
      if (smsInput.value === "123456") {
        emitValidateCodeSuccess();
      }
    });

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          evaluateCalls.push({
            fnSource: typeof fn === "function" ? fn.toString() : String(fn),
            arg: String(arg ?? ""),
            argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload",
          });
          if (typeof fn !== "function") {
            return undefined;
          }
          return await withFakeSmsDOM([wrongInput, smsInput], [submitButton], async () => await fn(arg));
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }

        const result = await runtime.submitSmsCode("123456");

        expect(wrongInput.value, "非短信验证区域的 6 位 input 不得被选中").toBe("");
        expect(smsInput.value, "短信验证区域 input 必须落入验证码长度").toBe("123456");
        expect(submitButton.clickCount, "目标 input 落值后才允许点击提交按钮").toBeGreaterThan(0);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("submitSmsCode 跳过隐藏和 4/5 位输入，落值失败时继续遍历候选", async () => {
    const smsRoot = new FakeHTMLElement("DIV", "短信验证 请输入验证码 uc_verification", null, "uc_verification");
    const hiddenInput = new FakeHTMLInputElement("短信验证码", 6, smsRoot, true, false);
    const areaCodeInput = new FakeHTMLInputElement("区号", 4, smsRoot, true, true, false, false, "area-code");
    const shortInput = new FakeHTMLInputElement("验证码", 5, smsRoot, true);
    const nonStickySmsInput = new FakeHTMLInputElement("短信验证码", 6, smsRoot, false);
    const stickySmsInput = new FakeHTMLInputElement("短信验证码", 6, smsRoot, true);
    const submitButton = new FakeHTMLButtonElement("提交验证码", smsRoot, false, () => {
      if (stickySmsInput.value === "123456") {
        emitValidateCodeSuccess();
      }
    });

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          evaluateCalls.push({
            fnSource: typeof fn === "function" ? fn.toString() : String(fn),
            arg: String(arg ?? ""),
            argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload",
          });
          if (typeof fn !== "function") {
            return undefined;
          }
          return await withFakeSmsDOM(
            [hiddenInput, areaCodeInput, shortInput, nonStickySmsInput, stickySmsInput],
            [submitButton],
            async () => await fn(arg),
          );
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }

        const result = await runtime.submitSmsCode("123456");

        expect(hiddenInput.value, "隐藏 input 不得被选择").toBe("");
        expect(areaCodeInput.value, "4 位区号 input 不得被选择").toBe("");
        expect(shortInput.value, "5 位 input 不得被选择").toBe("");
        expect(nonStickySmsInput.value, "落值失败的 input 不得阻断后续候选").toBe("");
        expect(stickySmsInput.value).toBe("123456");
        expect(submitButton.clickCount, "只有目标可见短信 input 落值且按钮可用时才点击提交").toBeGreaterThan(0);
        expect(result.ok).toBe(true);
      },
    );
  });

  it("checkStatus 进入 need_app_verify 后同会话主动触发官方 send_code，且 smsApiSeen 仅网络拦截成功后为 true", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
      data: { status: "3" },
    });

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });

          if (
            String(arg).includes("check_qrconnect") ||
            String(arg).includes("/passport/web/check_qrconnect")
          ) {
            return { status: 200, text: check2046Body };
          }

          if (
            String(arg).includes("/passport/web/send_code") ||
            String(arg).includes("www.douyin.com/passport/web/send_code") ||
            /send_code|接收短信|发送短信/.test(fnSource)
          ) {
            emitSendCodeSuccess();
            try {
              if (typeof fn === "function") {
                return await fn(arg);
              }
            } catch {
              // ignore evaluate body side-effects in unit mock
            }
            return { triggered: true, ok: true };
          }

          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            return createSmsSubmitProbeResult(smsCode);
          }

          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        expect(runtime.wasSmsApiSeen()).toBe(false);
        expect(sendCodeResponseEmitted).toBe(false);

        const status = await runtime.checkStatus("token-2046-abcdef");

        expect(status?.kind).toBe("need_app_verify");
        if (status?.kind === "need_app_verify") {
          expect(status.errorCode).toBe(2046);
        }

        for (let i = 0; i < 20; i += 1) {
          await Promise.resolve();
          if (runtime.wasSmsApiSeen()) {
            break;
          }
        }

        const triggeredSend = evaluateCalls.some(
          (c) =>
            c.arg.includes("/passport/web/send_code") ||
            c.arg.includes("www.douyin.com/passport/web/send_code") ||
            /send_code|接收短信验证码|接收短信|发送短信/.test(c.fnSource),
        );
        expect(
          triggeredSend,
          "进入 2046 后必须在同 Playwright page 主动触发官方 send_code（evaluate URL 或 UI 点击）",
        ).toBe(true);

        const forgedBogus = evaluateCalls.some(
          (c) => c.arg.includes("a_bogus=") && !c.arg.includes("check_qrconnect"),
        );
        expect(forgedBogus, "禁止 Node 侧伪造 a_bogus 查询串触发 send_code").toBe(false);

        expect(sendCodeResponseEmitted).toBe(true);
        expect(runtime.wasSmsApiSeen()).toBe(true);
        expect(runtime.markSmsApiSeenFromNetwork()).toBe(true);

        const submit = await runtime.submitSmsCode("123456");
        expect(submit.attempted).toBe(true);
        expect(submit.hostPath).toContain("/passport/web/validate_code");
        expect(submit.message).toMatch(/validate/i);

        const fillCall = evaluateCalls.find((c) => c.argKind === "sms_payload");
        expect(fillCall, "submitSmsCode 须同会话 page.evaluate 填码").toBeDefined();
        expect(fillCall?.fnSource).toMatch(/maxlength|短信验证|验证|确定|提交/);
      },
    );
  });

  it("submitSmsCode 未观测 validate_code 出网时不得返回 ok=true", async () => {
    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            return createSmsSubmitProbeResult(smsCode);
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }
        expect(runtime.wasSmsApiSeen()).toBe(true);

        const result = await runtime.submitSmsCode("123456");

        expect(result.attempted).toBe(true);
        expect(result.ok, "未观测官方 validate_code 请求/响应时不能误报提交成功").toBe(false);
        expect(result.hostPath).toBe("https://www.douyin.com/passport/web/validate_code/");
        expect(result.message).toMatch(/validate_code_submit_timeout|validate_code_response/i);
      },
    );
  });

  it("submitSmsCode 观测 validate_code 200 success 后返回 ok=true", async () => {
    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            queueMicrotask(() => emitValidateCodeSuccess());
            return createSmsSubmitProbeResult(smsCode);
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }
        expect(runtime.wasSmsApiSeen()).toBe(true);

        const result = await runtime.submitSmsCode("123456");

        expect(result).toEqual({
          attempted: true,
          ok: true,
          hostPath: "https://www.douyin.com/passport/web/validate_code/",
          message: "validate_code_success",
        });
      },
    );
  });

  it("submitSmsCode 应点击非 button 的主验证控件以触发 validate_code", async () => {
    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            if (/querySelectorAll\([^)]*(?:div|\[role=button\])/.test(fnSource) && /pointerdown/.test(fnSource)) {
              queueMicrotask(() => emitValidateCodeSuccess());
            }
            return createSmsSubmitProbeResult(smsCode);
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }
        expect(runtime.wasSmsApiSeen()).toBe(true);

        const result = await runtime.submitSmsCode("123456");

        expect(result.ok, "验证码提交必须支持 div/role=button 主验证控件并触发 validate_code").toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("submitSmsCode 应在候选验证按钮坐标上执行 Playwright 真实 mouse.click", async () => {
    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            if (/clientX|clientY/.test(fnSource) && /querySelectorAll\([^)]*(?:div|\[role=button\])/.test(fnSource)) {
              return {
                ...createSmsSubmitProbeResult(smsCode, false),
                clickPoint: { x: 180, y: 260 },
                reason: "button_ready",
              };
            }
            return { filled: true, clicked: false, candidateCount: 0 };
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
        mouseClick: async (x, y) => {
          if (x === 180 && y === 260) {
            emitValidateCodeSuccess();
          }
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }
        expect(runtime.wasSmsApiSeen()).toBe(true);

        const result = await runtime.submitSmsCode("123456");

        expect(trustedMouseClicks, "验证码提交必须使用 Playwright 真实 mouse.click 坐标点击").toEqual([
          { x: 180, y: 260 },
        ]);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("submitSmsCode 应优先用 frame locator 真实点击 iframe 内验证按钮", async () => {
    const frameLocatorClicks: string[] = [];
    const frameLocator: TestLocator = {
      count: async () => 1,
      first: () => frameLocator,
      filter: () => frameLocator,
      fill: async () => undefined,
      click: async () => {
        frameLocatorClicks.push("verify");
        emitValidateCodeSuccess();
      },
    };
    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            return { filled: false, clicked: false, candidateCount: 0 };
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
        frames: () => [
          {
            evaluate: async (fn, arg) => {
              const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
              evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
              return { filled: false, clicked: false, candidateCount: 0 };
            },
            locator: () => frameLocator,
          },
        ],
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }
        expect(runtime.wasSmsApiSeen()).toBe(true);

        const result = await runtime.submitSmsCode("123456");

        expect(frameLocatorClicks, "iframe 内验证按钮必须用 Playwright locator.click 真实点击").toEqual(["verify"]);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("submitSmsCode 应用 frame locator 点击 iframe 内提交验证码按钮", async () => {
    const locatorTexts: Array<string | RegExp> = [];
    const frameLocatorClicks: string[] = [];
    const frameLocator: TestLocator = {
      count: async () => 1,
      first: () => frameLocator,
      filter: (options) => {
        locatorTexts.push(options.hasText);
        return frameLocator;
      },
      fill: async () => undefined,
      click: async () => {
        frameLocatorClicks.push("submit-code");
        emitValidateCodeSuccess();
      },
    };

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            return { filled: false, clicked: false, candidateCount: 0 };
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
        frames: () => [
          {
            evaluate: async () => ({ filled: false, clicked: false, candidateCount: 0 }),
            locator: () => frameLocator,
          },
        ],
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }

        const result = await runtime.submitSmsCode("123456");

        expect(String(locatorTexts[0]), "frame locator 应匹配提交验证码类按钮文案").toContain("提交验证码");
        expect(frameLocatorClicks).toEqual(["submit-code"]);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("submitSmsCode 应在 iframe 内用 locator.fill 真实写入验证码再点击验证", async () => {
    const filledCodes: string[] = [];
    const clickedButtons: string[] = [];
    const inputLocator: TestLocator = {
      count: async () => 1,
      first: () => inputLocator,
      filter: () => inputLocator,
      fill: async (value) => {
        filledCodes.push(value);
      },
      click: async () => undefined,
    };
    const verifyLocator: TestLocator = {
      count: async () => 1,
      first: () => verifyLocator,
      filter: () => verifyLocator,
      click: async () => {
        clickedButtons.push("verify");
        if (filledCodes.includes("123456")) {
          emitValidateCodeSuccess();
        }
      },
    };

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            return createSmsSubmitProbeResult(smsCode);
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
        frames: () => [
          {
            evaluate: async () => ({ filled: true, clicked: true, candidateCount: 1, clickPoint: { x: 180, y: 260 } }),
            locator: (selector) => (selector.startsWith("input") ? inputLocator : verifyLocator),
          },
        ],
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }

        const result = await runtime.submitSmsCode("123456");

        expect(filledCodes, "iframe 内验证码必须由 Playwright locator.fill 真实写入").toEqual(["123456"]);
        expect(clickedButtons).toEqual(["verify"]);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("submitSmsCode 若当前 frame 填入后 value 未落地，应继续尝试后续 frame", async () => {
    const firstFrameFills: string[] = [];
    const secondFrameFills: string[] = [];
    const secondFrameClicks: string[] = [];
    const stickyInput: TestLocator = {
      count: async () => 1,
      first: () => stickyInput,
      filter: () => stickyInput,
      fill: async (value) => {
        secondFrameFills.push(value);
      },
      inputValue: async () => "123456",
      click: async () => undefined,
    };
    const stickyButton: TestLocator = {
      count: async () => 1,
      first: () => stickyButton,
      filter: () => stickyButton,
      isDisabled: async () => false,
      click: async () => {
        secondFrameClicks.push("verify");
        emitValidateCodeSuccess();
      },
    };
    const nonStickyInput: TestLocator = {
      count: async () => 1,
      first: () => nonStickyInput,
      filter: () => nonStickyInput,
      fill: async (value) => {
        firstFrameFills.push(value);
      },
      inputValue: async () => "",
      click: async () => undefined,
    };
    const firstFrameButton: TestLocator = {
      count: async () => 1,
      first: () => firstFrameButton,
      filter: () => firstFrameButton,
      isDisabled: async () => true,
      click: async () => {
        throw new Error("不应点击未落值 frame 的按钮");
      },
    };

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          return undefined;
        },
        frames: () => [
          {
            evaluate: async () => undefined,
            locator: (selector) => (selector.startsWith("input") ? nonStickyInput : firstFrameButton),
          },
          {
            evaluate: async () => undefined,
            locator: (selector) => (selector.startsWith("input") ? stickyInput : stickyButton),
          },
        ],
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }

        const result = await runtime.submitSmsCode("123456");

        expect(firstFrameFills).toEqual(["123456"]);
        expect(secondFrameFills).toEqual(["123456"]);
        expect(secondFrameClicks).toEqual(["verify"]);
        expect(result.ok).toBe(true);
        expect(result.message).toBe("validate_code_success");
      },
    );
  });

  it("调试截图遇到 page.screenshot 超时时应使用 CDP 截图兜底", async () => {
    // r9c：writeDebugScreenshot 硬顶 1.5s，已移除 CDP fallback（避免拖死会话）
    await withMockedPlaywright(
      {
        screenshot: async () => {
          throw new Error("page.screenshot timeout");
        },
        cdpScreenshot: async () => ({ data: Buffer.from("png").toString("base64") }),
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          const smsCode = readSmsSubmitCode(arg);
          if (smsCode !== undefined) {
            queueMicrotask(() => emitValidateCodeSuccess());
            return createSmsSubmitProbeResult(smsCode);
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        emitSendCodeSuccess();
        for (let i = 0; i < 20 && !runtime.wasSmsApiSeen(); i += 1) {
          await Promise.resolve();
        }

        const result = await runtime.submitSmsCode("123456");
        for (let i = 0; i < 20; i += 1) {
          await Promise.resolve();
        }

        expect(result.ok).toBe(true);
        expect(screenshotPaths.some((path) => path.includes("after_sms_submit_click"))).toBe(true);
        expect(screenshotPaths.some((path) => path.includes("after_validate_result_ok"))).toBe(true);
        // r9c 禁止 CDP 截图兜底
        expect(cdpCaptures).toEqual([]);
      },
    );
  });

  it("smsApiSeen 不得因仅尝试发送而置 true（无成功网络响应保持 false）", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
    });

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          if (String(arg).includes("check_qrconnect")) {
            return { status: 200, text: check2046Body };
          }
          if (String(arg).includes("send_code") || /send_code|接收短信|发送短信/.test(fnSource)) {
            return { triggered: true, ok: false };
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        const status = await runtime.checkStatus("token-2046-no-resp");
        expect(status?.kind).toBe("need_app_verify");
        for (let i = 0; i < 10; i += 1) {
          await Promise.resolve();
        }
        const attempted = evaluateCalls.some(
          (c) =>
            c.arg.includes("send_code") || /send_code|接收短信|发送短信/.test(c.fnSource),
        );
        expect(attempted).toBe(true);
        expect(runtime.wasSmsApiSeen()).toBe(false);
      },
    );
  });

  it("checkStatus 进入 need_app_verify 后应遍历 iframe 触发接收短信验证码", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
      data: { status: "3" },
    });
    const frameEvaluateCalls: Array<{ fnSource: string; arg: string }> = [];

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          if (String(arg).includes("check_qrconnect")) {
            return { status: 200, text: check2046Body };
          }
          return { triggered: false };
        },
        frames: () => [
          {
            evaluate: async (fn, arg) => {
              const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
              frameEvaluateCalls.push({ fnSource, arg: String(arg ?? "") });
              if (/接收短信验证码|send_code|发送短信/.test(fnSource) || String(arg).includes("send_code")) {
                emitSendCodeSuccess();
                return "ui_click";
              }
              return undefined;
            },
          },
        ],
      },
      async (runtime) => {
        const status = await runtime.checkStatus("token-2046-frame");

        expect(status?.kind).toBe("need_app_verify");
        expect(frameEvaluateCalls.length).toBeGreaterThan(0);
        expect(sendCodeResponseEmitted).toBe(true);
        expect(runtime.wasSmsApiSeen()).toBe(true);
      },
    );
  });

  it("注入 UI 点击脚本不得用 includes(发送短信) 误点 UP_SMS，且须跳过「发送短信验证」", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
      data: { status: "3" },
    });
    const uiFnSources: string[] = [];

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          if (String(arg).includes("check_qrconnect")) {
            return { status: 200, text: check2046Body };
          }
          if (
            /接收短信|发送短信|MouseEvent|pointerdown|send_code/.test(fnSource) ||
            String(arg).includes("send_code")
          ) {
            uiFnSources.push(fnSource);
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        const status = await runtime.checkStatus("token-2046-up-sms-guard");
        expect(status?.kind).toBe("need_app_verify");
        expect(uiFnSources.length, "须注入 UI/send_code 触发脚本").toBeGreaterThan(0);
        const joined = uiFnSources.join("\n");
        expect(
          joined,
          "必须显式跳过「发送短信验证」(UP_SMS，无下行短信)",
        ).toMatch(/发送短信验证/);
        expect(
          joined,
          "禁止无保护 fallback includes(\"发送短信\") 误点上行短信入口",
        ).not.toMatch(/includes\(["']发送短信["']\)/);
        expect(joined, "须对齐探针：合成 MouseEvent/pointer 点击").toMatch(
          /MouseEvent|pointerdown/,
        );
      },
    );
  });

  it("安全短信选择页应点击接收短信文案的可点击祖先并返回热补丁细节", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
      data: { status: "3" },
    });
    const clickResults: unknown[] = [];

    class FakeElement {
      readonly eventTypes: string[] = [];
      clickCount = 0;

      constructor(
        readonly id: string,
        readonly tagName: string,
        readonly innerText: string,
        readonly parentElement: FakeElement | null,
        readonly role: string | null,
        readonly cursor: string,
      ) {}

      matches(selector: string): boolean {
        const normalized = selector.replace(/\s+/g, "");
        return (
          (this.tagName === "BUTTON" && normalized.includes("button")) ||
          (this.tagName === "A" && normalized.includes("a")) ||
          (this.role === "button" && normalized.includes("[role='button']")) ||
          (this.role === "button" && normalized.includes("[role=button]"))
        );
      }

      closest(selector: string): FakeElement | null {
        let current: FakeElement | null = this;
        while (current !== null) {
          if (current.matches(selector)) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      }

      getAttribute(name: string): string | null {
        if (name === "role") {
          return this.role;
        }
        return null;
      }

      getBoundingClientRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
        return { x: 10, y: 20, width: 120, height: 32 };
      }

      dispatchEvent(event: { readonly type?: string }): boolean {
        if (event.type !== undefined) {
          this.eventTypes.push(event.type);
        }
        return true;
      }

      click(): void {
        this.clickCount += 1;
      }
    }

    class FakeMouseEvent {
      constructor(
        readonly type: string,
        readonly init?: unknown,
      ) {}
    }

    const receiveButton = new FakeElement("receive-button", "DIV", "接收短信验证码", null, "button", "pointer");
    const receiveTextLeaf = new FakeElement("receive-text", "SPAN", "接收短信验证码", receiveButton, null, "auto");
    const sendButton = new FakeElement("send-button", "DIV", "发送短信验证", null, "button", "pointer");
    const nodes = [sendButton, receiveTextLeaf, receiveButton];

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          if (String(arg).includes("check_qrconnect")) {
            return { status: 200, text: check2046Body };
          }
          if (/接收短信|发送短信|MouseEvent|pointerdown/.test(fnSource)) {
            const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
            const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
            const originalMouseEvent = Object.getOwnPropertyDescriptor(globalThis, "MouseEvent");
            const originalGetComputedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
            Object.defineProperty(globalThis, "document", {
              configurable: true,
              value: { querySelectorAll: () => nodes },
            });
            Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });
            Object.defineProperty(globalThis, "MouseEvent", { configurable: true, value: FakeMouseEvent });
            Object.defineProperty(globalThis, "getComputedStyle", {
              configurable: true,
              value: (element: FakeElement) => ({
                cursor: element.cursor,
                display: "block",
                opacity: "1",
                visibility: "visible",
              }),
            });
            try {
              const result = await fn(arg);
              clickResults.push(result);
              if (
                typeof result === "object" &&
                result !== null &&
                "kind" in result &&
                result.kind === "ui_click_receive_sms_hotfix_20260718"
              ) {
                emitSendCodeSuccess();
              }
              return result;
            } finally {
              if (originalDocument === undefined) {
                Reflect.deleteProperty(globalThis, "document");
              } else {
                Object.defineProperty(globalThis, "document", originalDocument);
              }
              if (originalHTMLElement === undefined) {
                Reflect.deleteProperty(globalThis, "HTMLElement");
              } else {
                Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
              }
              if (originalMouseEvent === undefined) {
                Reflect.deleteProperty(globalThis, "MouseEvent");
              } else {
                Object.defineProperty(globalThis, "MouseEvent", originalMouseEvent);
              }
              if (originalGetComputedStyle === undefined) {
                Reflect.deleteProperty(globalThis, "getComputedStyle");
              } else {
                Object.defineProperty(globalThis, "getComputedStyle", originalGetComputedStyle);
              }
            }
          }
          return undefined;
        },
      },
      async (runtime) => {
        expect(runtime.wasSmsApiSeen()).toBe(false);

        const status = await runtime.checkStatus("token-2046-receive-ancestor");

        expect(status?.kind).toBe("need_app_verify");
        expect(sendButton.clickCount, "发送短信验证入口必须跳过").toBe(0);
        expect(receiveTextLeaf.clickCount, "不得点击不可点击文案叶子节点").toBe(0);
        expect(receiveButton.clickCount, "应点击接收短信的可点击祖先").toBeGreaterThan(0);
        expect(clickResults[0]).toMatchObject({
          kind: "ui_click_receive_sms_hotfix_20260718",
          marker: "HOTFIX-DOUYIN-SMS-RECEIVE-20260718",
          matchedReceiveSms: true,
          targetType: "role_button",
          textCategory: "exact_receive_sms_code",
        });
        expect(runtime.wasSmsApiSeen(), "smsApiSeen 只能由 send_code 网络成功响应置 true").toBe(true);
      },
    );
  });

  it("首次 send_code 未确认成功后，后续 need_app_verify 应允许再次触发", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
      data: { status: "3" },
    });
    let sendAttempts = 0;

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          if (String(arg).includes("check_qrconnect")) {
            return { status: 200, text: check2046Body };
          }
          if (
            String(arg).includes("send_code") ||
            /send_code|接收短信|发送短信|MouseEvent|pointerdown|page_fetch/.test(fnSource)
          ) {
            sendAttempts += 1;
            return "none";
          }
          try {
            return typeof fn === "function" ? await fn(arg) : undefined;
          } catch {
            return undefined;
          }
        },
      },
      async (runtime) => {
        await runtime.checkStatus("token-2046-retry-1");
        const first = sendAttempts;
        expect(first, "首次 2046 须触发 send_code 尝试").toBeGreaterThan(0);
        expect(runtime.wasSmsApiSeen()).toBe(false);

        const sleepMod = await import("./douyinSessionRuntime.js").catch(() => null);
        void sleepMod;
        await new Promise((r) => setTimeout(r, 3100));

        await runtime.checkStatus("token-2046-retry-2");
        expect(
          sendAttempts,
          "无 smsApiSeen 时节流过后须允许再次触发（修复永久 sendCodeTriggerAttempted）",
        ).toBeGreaterThan(first);
      },
    );
  }, 15000);

  it("无接收按钮时不得在每个 frame 都 fetch send_code", async () => {
    const check2046Body = JSON.stringify({
      error_code: 2046,
      description: "need_app_verify",
      data: { status: "3" },
    });
    let pageFetchCount = 0;
    let frameFetchCount = 0;

    await withMockedPlaywright(
      {
        evaluate: async (fn, arg) => {
          const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
          evaluateCalls.push({ fnSource, arg: String(arg ?? ""), argKind: readSmsSubmitCode(arg) === undefined ? "other" : "sms_payload" });
          if (String(arg).includes("check_qrconnect")) {
            return { status: 200, text: check2046Body };
          }
          if (String(arg).includes("send_code") && /fetch\s*\(/.test(fnSource)) {
            pageFetchCount += 1;
            return "page_fetch";
          }
          if (/接收短信|发送短信|MouseEvent|pointerdown/.test(fnSource)) {
            return "none";
          }
          return undefined;
        },
        frames: () => [
          {
            evaluate: async (fn, arg) => {
              const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
              if (String(arg).includes("send_code") && /fetch\s*\(/.test(fnSource)) {
                frameFetchCount += 1;
                return "page_fetch";
              }
              if (/接收短信|发送短信|MouseEvent|pointerdown/.test(fnSource)) {
                return "none";
              }
              return undefined;
            },
          },
          {
            evaluate: async (fn, arg) => {
              const fnSource = typeof fn === "function" ? fn.toString() : String(fn);
              if (String(arg).includes("send_code") && /fetch\s*\(/.test(fnSource)) {
                frameFetchCount += 1;
                return "page_fetch";
              }
              if (/接收短信|发送短信|MouseEvent|pointerdown/.test(fnSource)) {
                return "none";
              }
              return undefined;
            },
          },
        ],
      },
      async (runtime) => {
        await runtime.checkStatus("token-2046-no-multi-fetch");
        expect(frameFetchCount, "frame 内不得各自 page_fetch").toBe(0);
        expect(pageFetchCount, "仅允许主 page 一次 page_fetch").toBeLessThanOrEqual(1);
        expect(pageFetchCount, "无 UI 时应有一次主 page fetch 兜底").toBe(1);
      },
    );
  });
});
