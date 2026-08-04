import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DouyinLoginService, DouyinLoginDiagnosticError, __private__ } from "./douyinLogin.js";
import { resetDouyinCookieJar, seedDouyinCookieJar } from "./douyinQRCode.js";


const QR_SRC = "data:image/png;base64,qr-code";
const SSO_QR_URL = "https://sso.douyin.com/qr/connect/?token=from-http";
const SSO_TOKEN = "from-http";
const SSO_REDIRECT_URL = "https://www.douyin.com/passport/sso/login/callback/?ticket=done";

type CookieFixture = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
};

type TestElementHandle = {
  readonly getAttribute: ReturnType<typeof vi.fn>;
  readonly screenshot: ReturnType<typeof vi.fn>;
};

type TestFetchResponse = {
  readonly ok: boolean;
  readonly headers: {
    readonly get: (name: string) => string | null;
  };
  readonly json: () => Promise<unknown>;
};

type TestPageEvaluate = <Result>(
  pageFunction: (argument: string) => Result | Promise<Result>,
  argument: string,
) => Promise<Result>;

function createEvaluateFunction(evaluateResult: string): TestPageEvaluate {
  return async <Result>() => evaluateResult as Result;
}

function createQRCodePage(
  source: string | null,
  evaluateResult = "data:image/png;base64,evaluated",
) {
  const image: TestElementHandle = {
    getAttribute: vi.fn(async () => source),
    screenshot: vi.fn(async () => "fallback-screenshot"),
  };
  const page = {
    goto: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => image),
    evaluate: createEvaluateFunction(evaluateResult),
  };
  vi.spyOn(page, "evaluate");

  return { image, page };
}

function createJSONResponse(body: unknown): TestFetchResponse {
  return {
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: vi.fn(async () => body),
  };
}

function createService(cookies: readonly CookieFixture[] = []) {
  const close = vi.fn(async () => undefined);
  const context = {
    openLoginPage: vi.fn(async () => QR_SRC),
    openRedirectURL: vi.fn(async () => undefined),
    getCookies: vi.fn(async () => cookies),
    close,
    captureScreenshot: vi.fn(async () => "data:image/png;base64,screenshot"),
  };
  const createContext = vi.fn(async () => context);
  const service = new DouyinLoginService({
    cdpEndpoint: "http://127.0.0.1:9222",
    enableHTTPQRCode: true,
    enableSessionRuntime: false,
    createContext,
    now: () => 1000,
    createID: () => "douyin-login-1",
  });

  return { context, createContext, service };
}

function expectWaitingResult(
  result: { readonly status: string },
): asserts result is {
  readonly id: string;
  readonly status: "waiting";
  readonly qrCode: string;
  readonly expiresAt: number;
} {
  expect(result.status).toBe("waiting");
}

type ObscuraProcessFixture = {
  readonly cdpEndpoint: string;
  readonly close: ReturnType<typeof vi.fn>;
};

type OnDemandObscuraOptions = ConstructorParameters<typeof DouyinLoginService>[0] & {
  readonly startObscura: () => Promise<ObscuraProcessFixture>;
};

function createObscuraLifecycleHarness() {
  const process = {
    cdpEndpoint: "http://127.0.0.1:9333",
    close: vi.fn(async () => undefined),
  };
  const startObscura = vi.fn(async () => process);

  return { process, startObscura };
}

function createServiceWithOnDemandObscura(
  options: Record<string, unknown> & {
    readonly createContext?: unknown;
    readonly startObscura?: unknown;
  },
) {
  const { startObscura: _ignored, ...rest } = options;
  return new DouyinLoginService({
    enableSessionRuntime: false,
    enableHTTPQRCode: false,
    ...rest,
  } as ConstructorParameters<typeof DouyinLoginService>[0]);
}

function stubFetchQRCode(response: TestFetchResponse) {
  return stubFetchResponses(response);
}

function stubFetchResponses(...responses: readonly TestFetchResponse[]) {
  let nextResponseIndex = 0;
  const fetchQRCode = vi.fn(async () => {
    const response = responses[nextResponseIndex];
    nextResponseIndex += 1;
    if (response !== undefined) {
      return response;
    }
    const fallback = responses.at(-1);
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error("missing fetch response");
  });
  vi.stubGlobal("fetch", fetchQRCode);
  return fetchQRCode;
}

beforeEach(() => {
  resetDouyinCookieJar();
  // 避免 ensureTtwid 额外 fetch 吃掉 stub 队列（产品路径仍会在无 ttwid 时注册）
  seedDouyinCookieJar({ ttwid: "test-ttwid" });
  stubFetchQRCode(createJSONResponse({ data: {} }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetDouyinCookieJar();
});


describe("DouyinLoginService", () => {
  it("docker/start.sh 仅启动 backend + Caddy，不含 Obscura", () => {
    const startScript = readFileSync(new URL("../../../../docker/start.sh", import.meta.url), "utf8");
    expect(startScript).toContain("node index.cjs server");
    expect(startScript).toContain("caddy run");
    expect(startScript).not.toMatch(/obscura/i);
    expect(startScript).not.toContain("OBSCURA_");
  });

  it("HTTP 路径拿到 SSO qrcode_index_url 时优先返回二维码字符串", async () => {
    // Given: 抖音 SSO HTTP 接口返回可由前端 n-qr-code 渲染的二维码 URL。
    const fetchQRCode = stubFetchQRCode(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
    );
    const { context, createContext, service } = createService();

    // When: HTTP 层要求创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 服务优先使用 HTTP QR 字符串，不启动 Obscura DOM 提取。
    expect(result).toEqual({
      id: "douyin-login-1",
      qrCode: SSO_QR_URL,
      status: "waiting",
      expiresAt: 301000,
    });
    expect(fetchQRCode).toHaveBeenCalledTimes(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(context.openLoginPage).not.toHaveBeenCalled();
  });

  it("默认生产路径优先请求 SSO 二维码并在成功时跳过 Obscura DOM 提取", async () => {
    // Given: 抖音 SSO 接口返回安全可用的二维码 URL。
    const fetchQRCode = stubFetchQRCode(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
    );
    const close = vi.fn(async () => undefined);
    const context = {
      openLoginPage: vi.fn(async () => QR_SRC),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close,
      captureScreenshot: vi.fn(async () => "data:image/png;base64,screenshot"),
    };
    const createContext = vi.fn(async () => context);
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
      enableHTTPQRCode: true,
      enableSessionRuntime: false,
      createContext,
      now: () => 1000,
      createID: () => "douyin-login-sso-first-default",
    });

    // When: 兼容裸 HTTP 路径创建会话。
    const result = await service.start();

    // Then: 兼容路径使用 SSO QR，不启动 Obscura DOM 提取。
    expect(result).toEqual({
      id: "douyin-login-sso-first-default",
      qrCode: SSO_QR_URL,
      status: "waiting",
      expiresAt: 301000,
    });
    expect(fetchQRCode).toHaveBeenCalledTimes(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(context.openLoginPage).not.toHaveBeenCalled();
  });

  it("方案 A：同会话 runtime 出码成功时 kind=session 且不走裸 HTTP/Obscura", async () => {
    const close = vi.fn(async () => undefined);
    const runtime = {
      id: "rt-1",
      acquireQR: vi.fn(async () => ({
        token: "session-token-abcdef",
        qrCode: "data:image/png;base64,session-qr",
        tokenPrefix: "session-",
      })),
      checkStatus: vi.fn(async () => ({ kind: "waiting" as const })),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      submitSmsCode: vi.fn(async () => ({ attempted: false, ok: false })),
      markSmsApiSeenFromNetwork: () => false,
      wasSmsApiSeen: () => false,
      close,
    };
    const createSessionRuntime = vi.fn(async () => runtime);
    const createContext = vi.fn(async () => {
      throw new Error("should not create CDP context");
    });
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime,
      createContext,
      now: () => 1000,
      createID: () => "session-login-1",
    });

    const result = await service.start();
    expect(result).toEqual({
      id: "session-login-1",
      qrCode: "data:image/png;base64,session-qr",
      status: "waiting",
      expiresAt: 301000,
    });
    expect(createSessionRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.acquireQR).toHaveBeenCalledTimes(1);
    expect(createContext).not.toHaveBeenCalled();
  });

  it("方案 A：confirmed 后页面白屏且后续 check undefined 时，应凭同会话 auth cookie 完成登录", async () => {
    const close = vi.fn(async () => undefined);
    const runtimeCookies = [
      [] as readonly CookieFixture[],
      [
        { name: "sessionid", value: "douyin-session", domain: ".douyin.com" },
        { name: "sid_guard", value: "douyin-guard", domain: ".douyin.com" },
      ] as readonly CookieFixture[],
    ];
    const runtime = {
      id: "rt-confirmed-white-screen",
      acquireQR: vi.fn(async () => ({
        token: "session-token-confirmed",
        qrCode: "data:image/png;base64,session-qr-confirmed",
        tokenPrefix: "session-",
      })),
      checkStatus: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "confirmed" as const,
          redirectURL: SSO_REDIRECT_URL,
        })
        .mockResolvedValueOnce(undefined),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => runtimeCookies.shift() ?? []),
      submitSmsCode: vi.fn(async () => ({ attempted: true, ok: true })),
      markSmsApiSeenFromNetwork: () => true,
      wasSmsApiSeen: () => true,
      close,
    };
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime: async () => runtime,
      now: () => 1000,
      createID: () => "session-confirmed-white-screen",
    });

    const started = await service.start();
    const firstPoll = await service.poll(started.id);
    const secondPoll = await service.poll(started.id);
    const duplicatePoll = await service.poll(started.id);

    const completedResult = {
      id: started.id,
      status: "completed" as const,
      cookies: [
        { name: "sessionid", value: "douyin-session", domain: ".douyin.com" },
        { name: "sid_guard", value: "douyin-guard", domain: ".douyin.com" },
      ],
    };
    expect(firstPoll).toMatchObject({ id: started.id, status: "waiting" });
    expect(secondPoll).toEqual(completedResult);
    expect(runtime.openRedirectURL).toHaveBeenCalledWith(SSO_REDIRECT_URL);
    expect(runtime.close).toHaveBeenCalledTimes(1);
    expect(duplicatePoll).toEqual(completedResult);
  });

  it("方案 A：短信验证后 check undefined 时，应凭同会话 auth cookie 完成登录", async () => {
    const close = vi.fn(async () => undefined);
    let qrStatus:
      | { readonly kind: "need_app_verify"; readonly errorCode: 2046; readonly description: string }
      | undefined = {
      kind: "need_app_verify",
      errorCode: 2046,
      description: "sms verification required",
    };
    const runtime = {
      id: "rt-app-verify-cookie",
      acquireQR: vi.fn(async () => ({
        token: "session-token-app-verify",
        qrCode: "data:image/png;base64,session-qr-app-verify",
        tokenPrefix: "session-",
      })),
      checkStatus: vi.fn(async () => qrStatus),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => [
        { name: "sessionid", value: "douyin-session", domain: ".douyin.com" },
        { name: "sid_guard", value: "douyin-guard", domain: ".douyin.com" },
      ]),
      submitSmsCode: vi.fn(async () => ({ attempted: true, ok: true })),
      markSmsApiSeenFromNetwork: () => true,
      wasSmsApiSeen: () => true,
      close,
    };
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime: async () => runtime,
      now: () => 1000,
      createID: () => "session-app-verify-cookie",
    });

    const started = await service.start();
    expectWaitingResult(started);
    const needVerify = await service.poll(started.id);
    expect(needVerify.status).toBe("need_app_verify");
    qrStatus = undefined;

    const result = await service.poll(started.id);

    expect(result).toEqual({
      id: "session-app-verify-cookie",
      status: "completed",
      cookies: [
        { name: "sessionid", value: "douyin-session", domain: ".douyin.com" },
        { name: "sid_guard", value: "douyin-guard", domain: ".douyin.com" },
      ],
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("方案 A：重复 start 会关闭上一轮仍存活的 runtime", async () => {
    vi.useFakeTimers();
    try {
      const firstClose = vi.fn(async () => undefined);
      const secondClose = vi.fn(async () => undefined);
      const runtimes = [
        {
          id: "rt-first",
          acquireQR: vi.fn(async () => ({
            token: "session-token-first",
            qrCode: "data:image/png;base64,session-qr-first",
            tokenPrefix: "session-",
          })),
          checkStatus: vi.fn(async () => ({ kind: "waiting" as const })),
          openRedirectURL: vi.fn(async () => undefined),
          getCookies: vi.fn(async () => []),
          submitSmsCode: vi.fn(async () => ({ attempted: false, ok: false })),
          markSmsApiSeenFromNetwork: () => false,
          wasSmsApiSeen: () => false,
          close: firstClose,
        },
        {
          id: "rt-second",
          acquireQR: vi.fn(async () => ({
            token: "session-token-second",
            qrCode: "data:image/png;base64,session-qr-second",
            tokenPrefix: "session-",
          })),
          checkStatus: vi.fn(async () => ({ kind: "waiting" as const })),
          openRedirectURL: vi.fn(async () => undefined),
          getCookies: vi.fn(async () => []),
          submitSmsCode: vi.fn(async () => ({ attempted: false, ok: false })),
          markSmsApiSeenFromNetwork: () => false,
          wasSmsApiSeen: () => false,
          close: secondClose,
        },
      ];
      // HOTPATCH_WAVE10：跨 start 冷却 13s，用推进时钟避免假冷却误伤
      let nowMs = 1_000;
      const service = new DouyinLoginService({
        enableSessionRuntime: true,
        enableHTTPQRCode: false,
        createSessionRuntime: async () => {
          const runtime = runtimes.shift();
          if (runtime === undefined) {
            throw new Error("missing runtime");
          }
          return runtime;
        },
        now: () => nowMs,
        createID: vi.fn().mockReturnValueOnce("session-first").mockReturnValueOnce("session-second"),
      });

      const firstPromise = service.start();
      await vi.advanceTimersByTimeAsync(500);
      const first = await firstPromise;
      expectWaitingResult(first);

      nowMs += 20_000;
      const secondPromise = service.start();
      await vi.advanceTimersByTimeAsync(500);
      const second = await secondPromise;

      expectWaitingResult(second);
      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(await service.poll(first.id)).toEqual({ status: "not_found" });
      expect(secondClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("方案 A：同会话 4031 映射 risk_4031 而非笼统 qr_unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { DouyinRiskBlockedError } = await import("./douyinSessionRuntime.js");
      const runtime = {
        id: "rt-4031",
        acquireQR: vi.fn(async () => {
          throw new DouyinRiskBlockedError(4031, "blocked");
        }),
        checkStatus: vi.fn(),
        openRedirectURL: vi.fn(),
        getCookies: vi.fn(),
        submitSmsCode: vi.fn(),
        markSmsApiSeenFromNetwork: () => false,
        wasSmsApiSeen: () => false,
        close: vi.fn(async () => undefined),
      };
      const service = new DouyinLoginService({
        enableSessionRuntime: true,
        createSessionRuntime: async () => runtime,
        createID: () => "id-4031",
        now: () => 1000,
      });

      const startPromise = service.start();
      // WAVE/R6：attempt<=1，仅 500ms 资源回收
      const expectPromise = expect(startPromise).rejects.toMatchObject({
        name: "DouyinLoginDiagnosticError",
        reason: "risk_4031",
      });
      await vi.advanceTimersByTimeAsync(500 + 100);
      await expectPromise;
      expect(runtime.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("方案 A：引擎不可用映射 engine_unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { DouyinSessionEngineError } = await import("./douyinSessionRuntime.js");
      const service = new DouyinLoginService({
        enableSessionRuntime: true,
        createSessionRuntime: async () => {
          throw new DouyinSessionEngineError("engine_unavailable", "no chrome");
        },
        createID: () => "id-engine",
        now: () => 1000,
      });

      const startPromise = service.start();
      const expectPromise = expect(startPromise).rejects.toMatchObject({
        reason: "engine_unavailable",
      });
      await vi.advanceTimersByTimeAsync(500);
      await expectPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("方案 A：browser_timeout 不吞成 qr_unavailable", async () => {
    vi.useFakeTimers();
    try {
      const { DouyinSessionEngineError } = await import("./douyinSessionRuntime.js");
      const runtime = {
        id: "rt-to",
        acquireQR: vi.fn(async () => {
          throw new DouyinSessionEngineError("browser_timeout", "timeout 40000ms");
        }),
        checkStatus: vi.fn(),
        openRedirectURL: vi.fn(),
        getCookies: vi.fn(),
        submitSmsCode: vi.fn(),
        markSmsApiSeenFromNetwork: () => false,
        wasSmsApiSeen: () => false,
        close: vi.fn(async () => undefined),
      };
      const service = new DouyinLoginService({
        enableSessionRuntime: true,
        createSessionRuntime: async () => runtime,
        createID: () => "id-to",
        now: () => 1000,
      });

      const startPromise = service.start();
      // WAVE/R6：attempt<=1，timeout_backoff 仅写 cooldownUntil 15s，禁止请求内二次出码
      const expectPromise = expect(startPromise).rejects.toMatchObject({
        reason: "browser_timeout",
      });
      await vi.advanceTimersByTimeAsync(500 + 100);
      await expectPromise;
      expect(runtime.acquireQR).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WAVE/R6：login 出码外层语义 — 40s / minGap 8s / attempt<=1 / cooldown 15s", () => {
    const src = readFileSync(new URL("./douyinLogin.ts", import.meta.url), "utf8");
    expect(src).toMatch(/DEFAULT_BROWSER_LOGIN_TIMEOUT_MS\s*=\s*40_000/);
    expect(src).toMatch(/const acquireOuterMs\s*=\s*[\s\S]*?40_000/);
    expect(src).toMatch(/const minGapMs\s*=\s*8_000/);
    expect(src).toMatch(/for\s*\(\s*let\s+attempt\s*=\s*1;\s*attempt\s*<=\s*1;/);
    expect(src).toMatch(/cooldownUntil\s*=\s*this\.now\(\)\s*\+\s*15_000/);
  });

  it("方案 A：browser_timeout 后下一次 start 受 cooldownUntil 15s 约束", async () => {
    vi.useFakeTimers();
    try {
      const { DouyinSessionEngineError } = await import("./douyinSessionRuntime.js");
      let nowMs = 1_000;
      const failRuntime = {
        id: "rt-to-fail",
        acquireQR: vi.fn(async () => {
          throw new DouyinSessionEngineError("browser_timeout", "timeout 40000ms");
        }),
        checkStatus: vi.fn(),
        openRedirectURL: vi.fn(),
        getCookies: vi.fn(),
        submitSmsCode: vi.fn(),
        markSmsApiSeenFromNetwork: () => false,
        wasSmsApiSeen: () => false,
        close: vi.fn(async () => undefined),
      };
      const okRuntime = {
        id: "rt-ok",
        acquireQR: vi.fn(async () => ({
          token: "session-token-ok",
          qrCode: "data:image/png;base64,session-qr-ok",
          tokenPrefix: "session-",
        })),
        checkStatus: vi.fn(async () => ({ kind: "waiting" as const })),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        submitSmsCode: vi.fn(async () => ({ attempted: false, ok: false })),
        markSmsApiSeenFromNetwork: () => false,
        wasSmsApiSeen: () => false,
        close: vi.fn(async () => undefined),
      };
      let createCount = 0;
      const service = new DouyinLoginService({
        enableSessionRuntime: true,
        createSessionRuntime: async () => {
          createCount += 1;
          // WAVE/R6：第一次 start 仅 1 次 attempt fail；第二次 start：ok
          if (createCount <= 1) {
            return failRuntime;
          }
          return okRuntime;
        },
        createID: vi
          .fn()
          .mockReturnValueOnce("id-to-1")
          .mockReturnValueOnce("id-to-2"),
        now: () => nowMs,
      });

      const firstPromise = service.start();
      const firstExpect = expect(firstPromise).rejects.toMatchObject({
        reason: "browser_timeout",
      });
      await vi.advanceTimersByTimeAsync(500 + 100);
      await firstExpect;

      // 紧接第二次 start：应等 cooldownUntil(15s) 与 minGap(8s) 的更晚者
      const secondPromise = service.start();
      // 未推进足够时间时不应完成
      await vi.advanceTimersByTimeAsync(5_000);
      nowMs += 5_000;
      let settled = false;
      void secondPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      // 再推进到满 15s 冷却 + attempt 500ms
      await vi.advanceTimersByTimeAsync(10_000 + 500 + 100);
      nowMs += 10_000 + 500 + 100;
      const second = await secondPromise;
      expectWaitingResult(second);
      expect(okRuntime.acquireQR).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("正常二维码等待页包含普通 iframe 时仍返回 waiting", async () => {
    const close = vi.fn(async () => undefined);
    const context = {
      openLoginPage: vi.fn(async () => '<div id="animate_qrcode_container"><iframe src="/login/qrcode-frame"></iframe></div>'),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close,
      captureScreenshot: vi.fn(async () => QR_SRC),
    };
    const createContext = vi.fn(async () => context);
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
      enableHTTPQRCode: false,
      enableSessionRuntime: false,
      createContext,
      now: () => 1000,
      createID: () => "douyin-login-iframe-qr",
    });

    const result = await service.start();

    expect(result).toEqual({
      id: "douyin-login-iframe-qr",
      qrCode: QR_SRC,
      status: "waiting",
      expiresAt: 301000,
    });
    expect(context.captureScreenshot).toHaveBeenCalledTimes(1);
    expect(context.close).not.toHaveBeenCalled();
  });

  it("HTTP 路径扫码确认后打开 redirect_url 并返回 Obscura 落地的抖音 Cookie", async () => {
    // Given: SSO HTTP 二维码会话返回 token，轮询确认后给出 redirect_url。
    const fetchQRCode = stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "3", redirect_url: SSO_REDIRECT_URL } }),
    );
    const { context, createContext, service } = createService([
      { name: "sessionid", value: "douyin-secret", domain: ".douyin.com" },
      { name: "foreign", value: "ignored", domain: ".example.com" },
    ]);

    // When: HTTP 层启动会话并轮询到扫码确认状态。
    const session = await service.start();
    const result = await service.poll(session.id);

    // Then: 服务在 Obscura 中打开回调地址，提取并返回抖音 Cookie。
    expect(result).toEqual({
      id: session.id,
      status: "completed",
      cookies: [{ name: "sessionid", value: "douyin-secret", domain: ".douyin.com" }],
    });
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(context.openLoginPage).not.toHaveBeenCalled();
    expect(context.openRedirectURL).toHaveBeenCalledWith(SSO_REDIRECT_URL);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://127.0.0.1:9222/json",
    "http://169.254.169.254/",
    "https://evil.example/callback",
  ])("HTTP 路径拒绝不可信 redirect_url %s 且不打开 Obscura", async (redirectURL) => {
    // Given: SSO HTTP 二维码会话返回 token，但确认阶段给出非抖音官方回调地址。
    const fetchQRCode = stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "3", redirect_url: redirectURL } }),
    );
    const { context, createContext, service } = createService();

    // When: HTTP 层启动会话并轮询到扫码确认状态。
    const session = await service.start();
    const result = await service.poll(session.id);

    // Then: 不可信回调不会进入浏览器自动化代理，客户端继续看到等待状态。
    expect(result).toEqual(session);
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).not.toHaveBeenCalled();
    expect(context.openRedirectURL).not.toHaveBeenCalled();
  });

  it("HTTP 路径扫码确认后 createContext 失败时抛出 cdp_unavailable 诊断", async () => {
    // Given: SSO HTTP 二维码会话已确认，但 Obscura/CDP 无法创建浏览器上下文。
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "3", redirect_url: SSO_REDIRECT_URL } }),
    );
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
      enableHTTPQRCode: true,
      createContext: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9222");
      }),
      enableSessionRuntime: false,
      now: () => 1000,
      createID: () => "douyin-login-http-cdp-failed",
    });

    // When: HTTP 层启动会话并轮询到扫码确认状态。
    const session = await service.start();
    const pollPromise = service.poll(session.id);

    // Then: 轮询阶段错误被转换为安全诊断，而不是无限等待。
    await expect(pollPromise).rejects.toThrow("浏览器自动化代理解析服务连接失败");
    try {
      await pollPromise;
    } catch (err: unknown) {
      if (err instanceof DouyinLoginDiagnosticError) {
        expect(err.reason).toBe("cdp_unavailable");
      } else {
        throw err;
      }
    }
  });

  it("HTTP 路径扫码确认后 openRedirectURL 失败时抛出安全诊断", async () => {
    // Given: SSO HTTP 二维码会话已确认，但 Obscura 打开官方回调地址失败。
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "3", redirect_url: SSO_REDIRECT_URL } }),
    );
    const { context, service } = createService();
    context.openRedirectURL.mockRejectedValueOnce(
      new Error("navigation failed with internal endpoint details"),
    );

    // When: HTTP 层启动会话并轮询到扫码确认状态。
    const session = await service.start();
    const pollPromise = service.poll(session.id);

    // Then: 跳转失败不会被吞成 waiting，而是返回可序列化的安全诊断。
    await expect(pollPromise).rejects.toThrow("抖音登录轮询发生未知错误。");
    try {
      await pollPromise;
    } catch (err: unknown) {
      if (err instanceof DouyinLoginDiagnosticError) {
        expect(err.toDiagnostic()).toEqual({
          reason: "generic_failure",
          message: "抖音登录轮询发生未知错误。",
          nextActions: ["请检查后端系统日志", "稍后重试扫码登录"],
        });
      } else {
        throw err;
      }
    }
  });

  it("HTTP 路径扫码等待时继续保持等待状态且不启动 Obscura", async () => {
    // Given: SSO HTTP 二维码会话已创建，但轮询仍处于未确认状态。
    const fetchQRCode = stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "1" } }),
    );
    const { context, createContext, service } = createService();

    // When: HTTP 层轮询该会话。
    const session = await service.start();
    const result = await service.poll(session.id);

    // Then: 服务保持等待，不提前启动 Obscura。
    expect(result).toEqual(session);
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).not.toHaveBeenCalled();
    expect(context.openRedirectURL).not.toHaveBeenCalled();
  });

  it("HTTP 路径 SSO status=5 时返回 expired 并清理会话且不启动 Obscura", async () => {
    // Given: SSO HTTP 二维码会话已创建，轮询 check_qrconnect 返回 status 5（过期）。
    const fetchQRCode = stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "5" } }),
    );
    const { context, createContext, service } = createService();

    // When: HTTP 层启动会话并轮询到 SSO 过期状态。
    const session = await service.start();
    const result = await service.poll(session.id);

    // Then: 返回 expired，清理 HTTP 会话，且不启动 Obscura。
    expect(result).toEqual({ status: "expired" });
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).not.toHaveBeenCalled();
    expect(context.openRedirectURL).not.toHaveBeenCalled();
    await expect(service.poll(session.id)).resolves.toEqual({ status: "not_found" });
  });

  it("HTTP 路径 error_code=2046 返回 need_app_verify 且 webSms.smsApiSeen 默认为 false", async () => {
    const fetchQRCode = stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({
        error_code: 2046,
        description: "请前往抖音APP完成验证",
        data: { status: "scanned" },
      }),
    );
    const { context, createContext, service } = createService();

    const session = await service.start();
    const result = await service.poll(session.id);

    expect(result).toMatchObject({
      id: session.id,
      status: "need_app_verify",
      error_code: 2046,
      qrCode: SSO_QR_URL,
      webSms: { tried: true, smsApiSeen: false },
      description: "请前往抖音APP完成验证",
    });
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).not.toHaveBeenCalled();
    expect(context.openRedirectURL).not.toHaveBeenCalled();
  });

  it("HTTP 路径 error_code=22 抛出 illegal_app 且不当 waiting", async () => {
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ error_code: 22, description: "非法应用", data: {} }),
    );
    const { createContext, service } = createService();
    const session = await service.start();
    await expect(service.poll(session.id)).rejects.toThrow("非法应用");
    try {
      await service.poll(session.id);
    } catch (err: unknown) {
      if (err instanceof DouyinLoginDiagnosticError) {
        expect(err.reason).toBe("illegal_app");
      } else if (!(err instanceof DouyinLoginDiagnosticError)) {
        // poll 后会话已清理 → not_found
        expect(await service.poll(session.id)).toEqual({ status: "not_found" });
      }
    }
    expect(createContext).not.toHaveBeenCalled();
  });

  it("submitSmsCode：need_app_verify 后 smsApiSeen=false 时 accepted 但不伪造成功 validate", async () => {
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ error_code: 2046, data: { status: "scanned" } }),
    );
    const { service } = createService();
    const session = await service.start();
    await service.poll(session.id);

    const result = await service.submitSmsCode(session.id, "123456");
    expect(result).toMatchObject({
      status: "accepted",
      id: session.id,
      validate: {
        attempted: false,
        ok: false,
        hostPath: "https://www.douyin.com/passport/web/validate_code/",
      },
    });
  });

  it("submitSmsCode：markSmsApiSeen 后门闩打开后 validate 语义通", async () => {
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ error_code: 2046, data: { status: "scanned" } }),
    );
    const { service } = createService();
    const session = await service.start();
    await service.poll(session.id);
    expect(service.markSmsApiSeen(session.id)).toBe(true);

    const result = await service.submitSmsCode(session.id, "654321");
    expect(result).toMatchObject({
      status: "accepted",
      id: session.id,
      validate: {
        attempted: true,
        ok: true,
        hostPath: "https://www.douyin.com/passport/web/validate_code/",
      },
    });
    // 不回显完整码
    expect(JSON.stringify(result)).not.toContain("654321");
  });

  it("submitSmsCode：非法码返回 invalid_code", async () => {
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ error_code: 2046, data: { status: "scanned" } }),
    );
    const { service } = createService();
    const session = await service.start();
    await service.poll(session.id);
    await expect(service.submitSmsCode(session.id, "12ab")).resolves.toEqual({
      status: "invalid_code",
    });
  });

  it("submitSmsCode：非 need_app_verify 会话返回 not_applicable", async () => {
    stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "1" } }),
    );
    const { service } = createService();
    const session = await service.start();
    await service.poll(session.id);
    await expect(service.submitSmsCode(session.id, "123456")).resolves.toEqual({
      status: "not_applicable",
    });
  });

  it("方案 A：poll 2046 时 webSms.smsApiSeen 必须反映 runtime.wasSmsApiSeen()（true）", async () => {
    let smsSeen = false;
    const runtime = {
      id: "rt-2046-seen",
      acquireQR: vi.fn(async () => ({
        token: "session-token-2046seen",
        qrCode: "data:image/png;base64,session-qr-2046",
        tokenPrefix: "session-",
      })),
      checkStatus: vi.fn(async () => {
        smsSeen = true;
        return {
          kind: "need_app_verify" as const,
          errorCode: 2046 as const,
          description: "请前往抖音APP完成验证",
        };
      }),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      submitSmsCode: vi.fn(async () => ({ attempted: false, ok: false })),
      markSmsApiSeenFromNetwork: () => {
        smsSeen = true;
        return true;
      },
      wasSmsApiSeen: () => smsSeen,
      close: vi.fn(async () => undefined),
    };
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime: async () => runtime,
      now: () => 1000,
      createID: () => "session-2046-seen",
    });

    const started = await service.start();
    expect(service.markSmsApiSeen(started.id)).toBe(true);
    const result = await service.poll(started.id);

    expect(result).toMatchObject({
      id: started.id,
      status: "need_app_verify",
      error_code: 2046,
      webSms: { tried: true, smsApiSeen: true },
    });
    expect(runtime.wasSmsApiSeen()).toBe(true);
  });

  it("方案 A：poll 2046 时 runtime 未观测 send_code 则 smsApiSeen=false（不得写死 true）", async () => {
    const runtime = {
      id: "rt-2046-unseen",
      acquireQR: vi.fn(async () => ({
        token: "session-token-2046unseen",
        qrCode: "data:image/png;base64,session-qr-2046u",
        tokenPrefix: "session-",
      })),
      checkStatus: vi.fn(async () => ({
        kind: "need_app_verify" as const,
        errorCode: 2046 as const,
        description: "请前往抖音APP完成验证",
      })),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      submitSmsCode: vi.fn(async () => ({ attempted: false, ok: false })),
      markSmsApiSeenFromNetwork: () => false,
      wasSmsApiSeen: () => false,
      close: vi.fn(async () => undefined),
    };
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime: async () => runtime,
      now: () => 1000,
      createID: () => "session-2046-unseen",
    });

    const started = await service.start();
    expect(service.markSmsApiSeen(started.id)).toBe(true);
    const result = await service.poll(started.id);

    expect(result).toMatchObject({
      id: started.id,
      status: "need_app_verify",
      error_code: 2046,
      webSms: { tried: true, smsApiSeen: false },
    });
  });

  it("方案 A：submitSmsCode 必须同会话 runtime 提交且透传 validate，不伪造成功", async () => {
    const submitSmsCode = vi.fn(async () => ({
      attempted: true,
      ok: false,
      hostPath: "https://www.douyin.com/passport/web/validate_code/",
      message: "validate_code_rejected",
    }));
    const runtime = {
      id: "rt-submit",
      acquireQR: vi.fn(async () => ({
        token: "session-token-submit",
        qrCode: "data:image/png;base64,session-qr-submit",
        tokenPrefix: "session-",
      })),
      checkStatus: vi.fn(async () => ({
        kind: "need_app_verify" as const,
        errorCode: 2046 as const,
      })),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      submitSmsCode,
      markSmsApiSeenFromNetwork: () => true,
      wasSmsApiSeen: () => true,
      close: vi.fn(async () => undefined),
    };
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime: async () => runtime,
      now: () => 1000,
      createID: () => "session-submit-sms",
    });

    const started = await service.start();
    await service.poll(started.id);
    const result = await service.submitSmsCode(started.id, "123456");

    expect(submitSmsCode).toHaveBeenCalledTimes(1);
    expect(submitSmsCode).toHaveBeenCalledWith("123456");
    expect(result).toMatchObject({
      status: "accepted",
      id: started.id,
      validate: {
        attempted: true,
        ok: false,
        hostPath: "https://www.douyin.com/passport/web/validate_code/",
        message: "validate_code_rejected",
      },
    });
    expect(result).not.toMatchObject({ status: "expired" });
    expect(result).not.toMatchObject({ status: "not_found" });
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("方案 A：submitSmsCode 保持 4-8 位数字校验（session 路径）", async () => {
    const submitSmsCode = vi.fn(async () => ({ attempted: true, ok: true }));
    const runtime = {
      id: "rt-invalid",
      acquireQR: vi.fn(async () => ({
        token: "session-token-invalid",
        qrCode: "data:image/png;base64,session-qr-invalid",
        tokenPrefix: "session-",
      })),
      checkStatus: vi.fn(async () => ({
        kind: "need_app_verify" as const,
        errorCode: 2046 as const,
      })),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      submitSmsCode,
      markSmsApiSeenFromNetwork: () => true,
      wasSmsApiSeen: () => true,
      close: vi.fn(async () => undefined),
    };
    const service = new DouyinLoginService({
      enableSessionRuntime: true,
      enableHTTPQRCode: false,
      createSessionRuntime: async () => runtime,
      now: () => 1000,
      createID: () => "session-invalid-code",
    });

    const started = await service.start();
    await service.poll(started.id);

    await expect(service.submitSmsCode(started.id, "12")).resolves.toEqual({
      status: "invalid_code",
    });
    await expect(service.submitSmsCode(started.id, "12ab56")).resolves.toEqual({
      status: "invalid_code",
    });
    await expect(service.submitSmsCode(started.id, "123456789")).resolves.toEqual({
      status: "invalid_code",
    });
    expect(submitSmsCode).not.toHaveBeenCalled();
  });

  it("HTTP 路径字符串 status=scanned 返回 scanned 且不启动 Obscura", async () => {
    const fetchQRCode = stubFetchResponses(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL, token: SSO_TOKEN } }),
      createJSONResponse({ data: { status: "scanned" }, error_code: 0 }),
    );
    const { createContext, service } = createService();
    const session = await service.start();
    const result = await service.poll(session.id);
    expect(result).toEqual({
      id: session.id,
      status: "scanned",
      qrCode: SSO_QR_URL,
      expiresAt: 301000,
    });
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).not.toHaveBeenCalled();
  });

  it.each(["http://sso.douyin.com/qr", "https://127.0.0.1/qr", "https://evil.example/qr"])(
    "HTTP 路径拒绝不可信 qrcode_index_url %s 并回退到 Obscura",
    async (qrcodeIndexURL) => {
      // Given: 抖音 SSO HTTP 接口返回不可信的二维码 URL。
      const fetchQRCode = stubFetchQRCode(
        createJSONResponse({ data: { qrcode_index_url: qrcodeIndexURL, token: SSO_TOKEN } }),
      );
      const { context, createContext, service } = createService();

      // When: HTTP 层要求创建抖音扫码登录会话。
      const result = await service.start();

      // Then: 服务拒绝透传该 URL，并保持既有 Obscura DOM 兜底路径。
      expectWaitingResult(result);
      expect(result.qrCode).toBe(QR_SRC);
      expect(fetchQRCode).toHaveBeenCalledTimes(1);
      expect(createContext).toHaveBeenCalledWith("http://127.0.0.1:9222");
      expect(context.openLoginPage).toHaveBeenCalledTimes(1);
    },
  );

  it("HTTP 路径没有可用 qrcode_index_url 时回退到 Obscura DOM 二维码", async () => {
    // Given: 抖音 SSO HTTP 接口返回 JSON，但没有安全可用的二维码 URL。
    const fetchQRCode = stubFetchQRCode(
      createJSONResponse({ data: { qrcode_index_url: SSO_QR_URL } }),
    );
    const { context, createContext, service } = createService();

    // When: HTTP 层要求创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 服务保持既有 DOM/截图兜底路径。
    expectWaitingResult(result);
    expect(result.qrCode).toBe(QR_SRC);
    expect(fetchQRCode).toHaveBeenCalledTimes(1);
    expect(createContext).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(context.openLoginPage).toHaveBeenCalledTimes(1);
  });

  it("默认生产路径遇到 SSO HTML challenge 时回退到官方页面二维码", async () => {
    // Given: 抖音 SSO 返回 HTML 挑战页，默认入口仍应保留 Obscura DOM 兜底。
    const fetchQRCode = stubFetchQRCode({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
      },
      json: vi.fn(async () => ({ sdk: "bdms" })),
    });
    const context = {
      openLoginPage: vi.fn(async () => QR_SRC),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      captureScreenshot: vi.fn(async () => "data:image/png;base64,screenshot"),
    };
    const createContext = vi.fn(async () => context);
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
      enableHTTPQRCode: true,
      enableSessionRuntime: false,
      createContext,
      now: () => 1000,
      createID: () => "douyin-login-1",
    });

    // When: 默认配置启动扫码登录。
    const result = await service.start();

    // Then: 先尝试 SSO，失败后回退 Obscura 官方页面二维码。
    expect(result).toMatchObject({ id: "douyin-login-1", status: "waiting", qrCode: QR_SRC });
    // passport 主路径 + sso HTML 回退各 1 次
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(createContext).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(context.openLoginPage).toHaveBeenCalledTimes(1);

  });

  it("默认生产路径 SSO 无效时回退 Obscura，且不可信 URL 不会透传", async () => {
    // Given: SSO 返回不可信二维码地址。
    const fetchQRCode = stubFetchQRCode(
      createJSONResponse({
        data: { qrcode_index_url: "https://evil.example/qr", token: SSO_TOKEN },
      }),
    );
    const context = {
      openLoginPage: vi.fn(async () => QR_SRC),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      captureScreenshot: vi.fn(async () => "data:image/png;base64,screenshot"),
    };
    const createContext = vi.fn(async () => context);
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
      enableHTTPQRCode: true,
      enableSessionRuntime: false,
      createContext,
      now: () => 1000,
      createID: () => "douyin-login-sso-invalid-fallback",
    });

    // When: 默认配置启动扫码登录。
    const result = await service.start();

    // Then: 拒绝不可信 URL，回退 DOM 路径二维码。
    expectWaitingResult(result);
    expect(result.qrCode).toBe(QR_SRC);
    expect(fetchQRCode).toHaveBeenCalledTimes(1);
    expect(createContext).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(context.openLoginPage).toHaveBeenCalledTimes(1);
  });

  it("浏览器兜底登录入口优先使用 www.douyin.com 并激活扫码登录", async () => {
    // Given: Obscura CDP 已连接，页面需先进入更安全的登录面并点开扫码入口。
    const { page } = createQRCodePage(QR_SRC);
    const context = {
      newPage: vi.fn(async () => page),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      addInitScript: vi.fn(async () => undefined),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => browser),
    };

    // When: 打开登录页提取二维码。
    const loginContext = await __private__.createPlaywrightContext(
      "http://127.0.0.1:9222",
      chromium,
    );
    const qrCode = await loginContext.openLoginPage();

    // Then: 默认入口优先 www.douyin.com，并在找二维码前激活扫码登录。
    expect(__private__.douyinLoginURL).toMatch(/^https:\/\/www\.douyin\.com\/?/);
    expect(page.goto).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/www\.douyin\.com\/?/),
      { waitUntil: "domcontentloaded" },
    );
    expect(page.evaluate).toHaveBeenCalled();
    expect(qrCode).toBe(QR_SRC);
  });

  it("CDP 复用 browser.contexts()[0] 且不调用 newContext", async () => {
    const { page } = createQRCodePage(QR_SRC);
    const existingContext = {
      newPage: vi.fn(async () => page),
      pages: vi.fn(() => []),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      addInitScript: vi.fn(async () => undefined),
    };
    const browser = {
      contexts: vi.fn(() => [existingContext]),
      newContext: vi.fn(async () => {
        throw new Error("should not create new context");
      }),
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => browser),
    };

    const loginContext = await __private__.createPlaywrightContext(
      "ws://127.0.0.1:9222/devtools/browser",
      chromium,
    );
    const qrCode = await loginContext.openLoginPage();

    expect(browser.contexts).toHaveBeenCalled();
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(existingContext.addInitScript).toHaveBeenCalledTimes(1);
    expect(qrCode).toBe(QR_SRC);
  });

  it("CDP 无现有 context 时才调用 newContext", async () => {
    const { page } = createQRCodePage(QR_SRC);
    const context = {
      newPage: vi.fn(async () => page),
      pages: vi.fn(() => []),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      addInitScript: vi.fn(async () => undefined),
    };
    const browser = {
      contexts: vi.fn(() => []),
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => browser),
    };

    const loginContext = await __private__.createPlaywrightContext(
      "ws://127.0.0.1:9222/devtools/browser",
      chromium,
    );
    await loginContext.openLoginPage();

    expect(browser.newContext).toHaveBeenCalledWith({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
  });

  it("openLoginPage 优先复用 context.pages()[0] 再决定是否 newPage", async () => {
    const { page } = createQRCodePage(QR_SRC);
    const context = {
      newPage: vi.fn(async () => {
        throw new Error("should not create new page");
      }),
      pages: vi.fn(() => [page]),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      addInitScript: vi.fn(async () => undefined),
    };
    const browser = {
      contexts: vi.fn(() => [context]),
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => browser),
    };

    const loginContext = await __private__.createPlaywrightContext(
      "ws://127.0.0.1:9222/devtools/browser",
      chromium,
    );
    const qrCode = await loginContext.openLoginPage();

    expect(context.pages).toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalled();
    expect(qrCode).toBe(QR_SRC);
  });

  it("Duplicate target 错误映射为 cdp_unavailable 而不是 generic_failure", async () => {
    const service = new DouyinLoginService({
      enableHTTPQRCode: false,
      createContext: vi.fn(async () => {
        throw new Error("Duplicate target page-1");
      }),
      enableSessionRuntime: false,
      createID: () => "douyin-login-duplicate-target",
    });

    const startPromise = service.start();
    await expect(startPromise).rejects.toThrow("浏览器自动化代理解析服务连接失败");
    try {
      await startPromise;
    } catch (err: unknown) {
      if (err instanceof DouyinLoginDiagnosticError) {
        expect(err.reason).toBe("cdp_unavailable");
      } else {
        throw err;
      }
    }
  });

  it("CDP 默认上下文使用真实浏览器画像打开官方登录页", async () => {
    // Given: Obscura CDP 已连接，页面可从官方登录页提取 data:image 二维码。
    const { page } = createQRCodePage(QR_SRC);
    const context = {
      newPage: vi.fn(async () => page),
      pages: vi.fn(() => []),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      addInitScript: vi.fn(async () => undefined),
    };
    const browser = {
      contexts: vi.fn(() => []),
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => browser),
    };

    // When: 创建 Playwright 登录上下文并打开官方页面。
    const loginContext = await __private__.createPlaywrightContext(
      "http://127.0.0.1:9222",
      chromium,
    );
    const qrCode = await loginContext.openLoginPage();

    // Then: CDP 上下文具备真实用户画像，二维码可直接展示。
    expect(browser.newContext).toHaveBeenCalledWith({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
    expect(page.goto).toHaveBeenCalledWith(__private__.douyinLoginURL, {
      waitUntil: "domcontentloaded",
    });
    expect(qrCode).toBe(QR_SRC);
  });

  it("openLoginPage 在跳转前注册安全 CDP 诊断监听", async () => {
    // Given: Obscura CDP 已连接，页面对象支持 Playwright 事件监听。
    const { page } = createQRCodePage(QR_SRC);
    const diagnosticPage = {
      ...page,
      on: vi.fn(() => undefined),
    };
    const context = {
      newPage: vi.fn(async () => diagnosticPage),
      cookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      addInitScript: vi.fn(async () => undefined),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => undefined),
    };
    const chromium = {
      connectOverCDP: vi.fn(async () => browser),
    };

    // When: 打开官方登录页。
    const loginContext = await __private__.createPlaywrightContext(
      "http://127.0.0.1:9222",
      chromium,
    );
    await loginContext.openLoginPage();

    // Then: console/pageerror/requestfailed 诊断监听必须先于 goto 注册。
    expect(diagnosticPage.on).toHaveBeenNthCalledWith(1, "console", expect.any(Function));
    expect(diagnosticPage.on).toHaveBeenNthCalledWith(2, "pageerror", expect.any(Function));
    expect(diagnosticPage.on).toHaveBeenNthCalledWith(3, "requestfailed", expect.any(Function));
    const gotoCallOrder = diagnosticPage.goto.mock.invocationCallOrder[0];
    expect(diagnosticPage.on.mock.invocationCallOrder.every((callOrder) => callOrder < gotoCallOrder))
      .toBe(true);
  });

  it("HTTP 路径遇到 HTML 非 JSON 响应时不崩溃并回退到 Obscura DOM 二维码", async () => {
    // Given: 上游返回 HTML 或内容类型不可信，不能当作 SSO JSON 使用。
    const fetchQRCode = stubFetchQRCode({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
      },
      json: vi.fn(async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      }),
    });
    const { context, service } = createService();

    // When: HTTP 层要求创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 服务不解析 HTML，且仍返回 DOM 路径二维码。
    expectWaitingResult(result);
    expect(result.qrCode).toBe(QR_SRC);
    // passport 主路径 HTML + sso 回退 HTML
    expect(fetchQRCode).toHaveBeenCalledTimes(2);
    expect(context.openLoginPage).toHaveBeenCalledTimes(1);

  });

  it("HTTP 与 Obscura 路径都不可用时清晰失败并释放 context", async () => {
    // Given: 上游 JSON 结构不安全，DOM 二维码也无法获取。
    const close = vi.fn(async () => undefined);
    const context = {
      openLoginPage: vi.fn(async () => ""),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close,
      captureScreenshot: vi.fn(async () => ""),
    };
    stubFetchQRCode(createJSONResponse({ data: { qrcode_index_url: 123 } }));
    const service = new DouyinLoginService({
      enableHTTPQRCode: true,
      createContext: vi.fn(async () => context),
      createID: () => "douyin-login-unsafe-json",
    enableSessionRuntime: false,
    });

    // When: HTTP 层创建抖音扫码登录会话。
    await expect(service.start()).rejects.toThrow("未能从抖音登录页面加载出有效的登录二维码。");

    // Then: 失败路径不登记会话并释放已创建 of Obscura context。
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.poll("douyin-login-unsafe-json")).resolves.toEqual({
      status: "not_found",
    });
  });

  it("启动会话时在同一 Obscura 上下文打开抖音登录页并返回二维码 src", async () => {
    // Given: Obscura CDP 连接返回带二维码 img 的浏览器上下文。
    const { context, createContext, service } = createService();

    // When: HTTP 层要求创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 服务返回会话 ID 和可展示二维码，且没有走截图路径。
    expect(result).toEqual({
      id: "douyin-login-1",
      qrCode: QR_SRC,
      status: "waiting",
      expiresAt: 301000,
    });
    expect(createContext).toHaveBeenCalledWith("http://127.0.0.1:9222");
    expect(context.openLoginPage).toHaveBeenCalledTimes(1);
    expect(context.captureScreenshot).not.toHaveBeenCalled();
  });

  it("未登录时轮询同一 Obscura 上下文并保持等待状态", async () => {
    // Given: 已启动的扫码会话没有 douyin.com Cookie。
    const { service } = createService([]);
    const session = await service.start();

    // When: HTTP 层轮询该会话。
    const result = await service.poll(session.id);

    // Then: 会话仍处于等待状态且不会返回 Cookie。
    expect(result).toEqual({
      id: session.id,
      status: "waiting",
      qrCode: QR_SRC,
      expiresAt: 301000,
    });
  });

  it("Obscura 轮询读取 Cookie 失败时抛出安全诊断", async () => {
    // Given: 已启动的扫码会话在读取 Cookie 时发生底层错误。
    const { context, service } = createService([]);
    const session = await service.start();
    context.getCookies.mockRejectedValueOnce(new Error("Cookie=sessionid=secret; internal stack"));

    // When: HTTP 层轮询该会话。
    const pollPromise = service.poll(session.id);

    // Then: Cookie 读取失败不会被吞成 waiting，而是返回安全诊断。
    await expect(pollPromise).rejects.toThrow("抖音登录轮询发生未知错误。");
    try {
      await pollPromise;
    } catch (err: unknown) {
      if (err instanceof DouyinLoginDiagnosticError) {
        expect(err.toDiagnostic()).toEqual({
          reason: "generic_failure",
          message: "抖音登录轮询发生未知错误。",
          nextActions: ["请检查后端系统日志", "稍后重试扫码登录"],
        });
      } else {
        throw err;
      }
    }
  });

  it("登录成功后只返回 douyin.com Cookie", async () => {
    // Given: Obscura 上下文中同时存在抖音与非抖音 Cookie。
    const { service } = createService([
      { name: "sessionid", value: "douyin-secret", domain: ".douyin.com" },
      { name: "csrf", value: "douyin-csrf", domain: "www.douyin.com" },
      { name: "other", value: "foreign-secret", domain: ".example.com" },
    ]);
    const session = await service.start();

    // When: HTTP 层轮询登录态。
    const result = await service.poll(session.id);

    // Then: 仅暴露 douyin.com 域 Cookie，排除其他站点登录态。
    expect(result).toEqual({
      id: session.id,
      status: "completed",
      cookies: [
        { name: "sessionid", value: "douyin-secret", domain: ".douyin.com" },
        { name: "csrf", value: "douyin-csrf", domain: "www.douyin.com" },
      ],
    });
  });

  it("DYQR-EDGE-001 将 blob 二维码转换为前端可展示的 data:image", async () => {
    // Given: 抖音登录页返回不可直接迁移到前端的 blob 二维码地址。
    const blobQRCode = "blob:https://www.douyin.com/qr-code";
    const { context, service } = createService();
    context.openLoginPage.mockResolvedValueOnce(blobQRCode);

    // When: HTTP 层创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 二维码应转换为 data:image，而不是把 blob 地址透传给前端。
    expectWaitingResult(result);
    expect(result.qrCode).not.toBe(blobQRCode);
    expect(result.qrCode).toMatch(/^data:image\//);
  });

  it("DYQR-EDGE-002 在二维码 src 无法迁移时使用元素截图兜底返回 data:image/png", async () => {
    // Given: 二维码元素可见，但 src 提取结果为空，只有元素截图能迁移给前端。
    const { context, service } = createService();
    context.openLoginPage.mockResolvedValueOnce("");

    // When: HTTP 层创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 服务应返回二维码元素截图，确保前端仍能展示二维码。
    expectWaitingResult(result);
    expect(result.qrCode).toBe("data:image/png;base64,screenshot");
    expect(context.captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("DYQR-EDGE-002 截图兜底返回裸 base64 时封装为 data:image/png", async () => {
    // Given: 二维码 src 不可迁移，截图 seam 只返回原始 PNG base64。
    const { context, service } = createService();
    context.openLoginPage.mockResolvedValueOnce("");
    context.captureScreenshot.mockResolvedValueOnce("raw-png-base64");

    // When: HTTP 层创建抖音扫码登录会话。
    const result = await service.start();

    // Then: 服务应把裸截图封装成前端可直接展示的 data:image。
    expectWaitingResult(result);
    expect(result.qrCode).toBe("data:image/png;base64,raw-png-base64");
    expect(context.captureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("DYQR-EDGE-001 blob 路径真实通过 page.evaluate 转换为 data:image", async () => {
    // Given: 二维码元素 src 是 blob URL，只有页面上下文能读取其内容。
    const blobQRCode = "blob:https://www.douyin.com/qr-code";
    const { image, page } = createQRCodePage(blobQRCode, "data:image/png;base64,from-blob");

    // When: Playwright helper 解析二维码元素来源。
    const result = await __private__.findQRCodeSource(page);

    // Then: helper 真实调用 page.evaluate 迁移 blob，并返回 evaluate 产生的 data:image。
    expect(result.source).toBe("data:image/png;base64,from-blob");
    expect(page.evaluate).toHaveBeenCalledWith(__private__.readImageAsDataURL, blobQRCode);
    expect(image.screenshot).not.toHaveBeenCalled();
  });

  it("二维码选择器并发等待，前置选择器卡住时仍能返回后续 data:image 命中", async () => {
    // Given: 前置选择器等待不会返回，但 data:image 选择器能立即拿到二维码元素。
    const image: TestElementHandle = {
      getAttribute: vi.fn(async () => QR_SRC),
      screenshot: vi.fn(async () => "unused-screenshot"),
    };
    const page = {
      goto: vi.fn(async () => undefined),
      waitForSelector: vi.fn((selector: string) => {
        if (selector === 'img[src^="data:image/"]') {
          return Promise.resolve(image);
        }
        return new Promise<TestElementHandle>(() => undefined);
      }),
      evaluate: createEvaluateFunction("data:image/png;base64,unused"),
    };
    vi.spyOn(page, "evaluate");

    // When: helper 解析二维码元素来源。
    const result = await __private__.findQRCodeSource(page);

    // Then: helper 不会被前置 selector 阻塞，并返回后续命中的 data:image。
    expect(result.source).toBe(QR_SRC);
    expect(page.waitForSelector).toHaveBeenCalledWith('img[src^="data:image/"]', {
      timeout: 10_000,
      state: "visible",
    });
    expect(image.screenshot).not.toHaveBeenCalled();
  });

  it("DYQR-EDGE-001 http 路径真实通过 page.evaluate 转换为 data:image", async () => {
    // Given: 二维码元素 src 是 http URL，前端不能直接可靠复用远端资源。
    const httpQRCode = "https://www.douyin.com/qr-code.png";
    const { image, page } = createQRCodePage(httpQRCode, "data:image/png;base64,from-http");

    // When: Playwright helper 解析二维码元素来源。
    const result = await __private__.findQRCodeSource(page);

    // Then: helper 真实调用 page.evaluate 迁移 http(s)，并返回 evaluate 产生的 data:image。
    expect(result.source).toBe("data:image/png;base64,from-http");
    expect(page.evaluate).toHaveBeenCalledWith(__private__.readImageAsDataURL, httpQRCode);
    expect(image.screenshot).not.toHaveBeenCalled();
  });

  it("DYQR-EDGE-002 src 为空时真实使用二维码元素截图兜底", async () => {
    // Given: 二维码元素存在但 src 为空，截图返回原始 PNG base64。
    const { image, page } = createQRCodePage(null);
    image.screenshot.mockResolvedValueOnce("raw-png-base64");

    // When: Playwright helper 解析二维码元素来源。
    const result = await __private__.findQRCodeSource(page);

    // Then: helper 真实调用元素截图，并封装为 data:image/png;base64。
    expect(result.source).toBe("data:image/png;base64,raw-png-base64");
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(image.screenshot).toHaveBeenCalledWith({ type: "png" });
  });

  it("createContext 成功后打开登录页失败会关闭 context 且不登记会话", async () => {
    // Given: Obscura context 已创建，但打开抖音登录页失败。
    const close = vi.fn(async () => undefined);
    const context = {
      openLoginPage: vi.fn(async () => {
        throw new Error("open failed");
      }),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close,
    };
    const service = new DouyinLoginService({
      createContext: vi.fn(async () => context),
      createID: () => "douyin-login-failed",
    enableSessionRuntime: false,
    });

    // When: HTTP 层创建抖音扫码登录会话。
    await expect(service.start()).rejects.toThrow("抖音登录启动发生未知错误。");

    // Then: 已创建 context 必须释放，且失败会话不可被轮询到。
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.poll("douyin-login-failed")).resolves.toEqual({ status: "not_found" });
  });

  it("createContext 成功后二维码迁移失败会关闭 context 且不登记会话", async () => {
    // Given: Obscura context 已创建，但二维码既不可迁移也不可截图兜底。
    const close = vi.fn(async () => undefined);
    const context = {
      openLoginPage: vi.fn(async () => "blob:https://www.douyin.com/qr-code"),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close,
      captureScreenshot: vi.fn(async () => ""),
    };
    const service = new DouyinLoginService({
      createContext: vi.fn(async () => context),
      createID: () => "douyin-login-migration-failed",
    enableSessionRuntime: false,
    });

    // When: HTTP 层创建抖音扫码登录会话。
    await expect(service.start()).rejects.toThrow("未能从抖音登录页面加载出有效的登录二维码。");

    // Then: 已创建 context 必须释放，且失败会话不可被轮询到。
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.poll("douyin-login-migration-failed")).resolves.toEqual({
      status: "not_found",
    });
  });

  it("取消会话时关闭 Obscura 上下文并清理会话", async () => {
    // Given: 已启动的扫码会话。
    const { context, service } = createService();
    const session = await service.start();

    // When: HTTP 层取消该会话。
    const result = await service.cancel(session.id);

    // Then: 会话资源被关闭，再次轮询返回未找到。
    expect(result).toEqual({ status: "cancelled" });
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(service.poll(session.id)).resolves.toEqual({ status: "not_found" });
  });

  describe("诊断与失败分类逻辑", () => {
    it("二维码不可用诊断证据会清洗事件、正文和二维码来源中的敏感键值与栈", async () => {
      // Given: Obscura 页面失败事件、正文摘要和二维码来源都携带假敏感值。
      type DiagnosticEventName = "console" | "pageerror" | "requestfailed";
      type DiagnosticHandler = (event: unknown) => void;
      const diagnosticHandlers = new Map<DiagnosticEventName, DiagnosticHandler>();
      const sensitiveFragments = [
        "sessionid=secret",
        "guard_secret",
        "sid_secret",
        "uid_secret",
        "bearer_secret",
        "access_secret",
        "refresh_secret",
        "storage_secret",
        "url_secret",
        "hash_secret",
        "secret_image",
        "secretStack",
        "json_access_secret",
        "json_refresh_secret",
        "colon_refresh_secret",
        "colon_session_secret",
        "colon_storage_secret",
        "json_storage_secret",
      ] as const;
      const bodyText = [
        "Cookie: sessionid=secret; sid_guard=guard_secret; sid_tt=sid_secret; uid_tt=uid_secret",
        "Authorization: Bearer bearer_secret",
        "access_token=access_secret&refresh_token=refresh_secret",
        'storageState={"cookies":[{"value":"storage_secret"}]}',
        '{"access_token":"json_access_secret"}',
        '{"refresh_token":"json_refresh_secret"}',
        "refresh_token: colon_refresh_secret",
        "sessionid: colon_session_secret",
        'storageState: {"cookies":[{"value":"colon_storage_secret"}]}',
        '"storageState":{"cookies":[{"value":"json_storage_secret"}]}',
        "https://sso.douyin.com/qr/connect/?token=url_secret#hash_secret",
        "data:image/png;base64,secret_image",
        "Error: boom\n    at secretStack (internal://frame.js:1:1)",
      ].join("\n");
      const pageEvidence = { qrImageCount: 0, bodyText };
      const page = {
        on: vi.fn((eventName: DiagnosticEventName, handler: DiagnosticHandler) => {
          diagnosticHandlers.set(eventName, handler);
        }),
        goto: vi.fn(async () => {
          diagnosticHandlers.get("console")?.({
            type: () => "error",
            text: () => bodyText,
          });
          diagnosticHandlers.get("pageerror")?.({ message: bodyText });
          diagnosticHandlers.get("requestfailed")?.({
            url: () => "https://sso.douyin.com/qr/connect/?token=url_secret#hash_secret",
            failure: () => ({ errorText: bodyText }),
          });
        }),
        waitForSelector: vi.fn(async () => {
          throw new Error("qr missing");
        }),
        evaluate: async <Result>() => pageEvidence as Result,
      };
      vi.spyOn(page, "evaluate");
      const context = {
        newPage: vi.fn(async () => page),
        cookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
        addInitScript: vi.fn(async () => undefined),
      };
      const browser = {
        newContext: vi.fn(async () => context),
        close: vi.fn(async () => undefined),
      };
      const chromium = {
        connectOverCDP: vi.fn(async () => browser),
      };
      const loginContext = await __private__.createPlaywrightContext(
        "http://127.0.0.1:9222",
        chromium,
      );
      const service = new DouyinLoginService({
        createContext: vi.fn(async () => loginContext),
        createID: () => "douyin-login-evidence-redaction-test",
      enableSessionRuntime: false,
      });

      // When: 启动登录但二维码最终不可用。
      const startPromise = service.start();

      // Then: 诊断 evidence 的事件、页面正文和二维码来源都不能泄露敏感值或栈细节。
      await expect(startPromise).rejects.toThrow("未能从抖音登录页面加载出有效的登录二维码。");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          const diagnostic = err.toDiagnostic();
          expect(diagnostic.evidence?.events).toEqual(expect.any(Array));
          expect(diagnostic.evidence?.page?.bodyText).toEqual(expect.any(String));
          const diagnosticText = JSON.stringify({
            events: diagnostic.evidence?.events,
            bodyText: diagnostic.evidence?.page?.bodyText,
            qrSource: diagnostic.evidence?.qrSource,
          });
          for (const sensitiveFragment of sensitiveFragments) {
            expect(diagnosticText).not.toContain(sensitiveFragment);
          }
        } else {
          throw err;
        }
      }
    });

    it("二维码不可用诊断证据会脱敏浏览器状态和二维码内容", async () => {
      // Given: Obscura 提取到不可迁移的完整二维码链接，截图兜底也不可用。
      const sensitiveFragments = [
        "Cookie",
        "token=",
        "storageState",
        "data:image/png;base64,secret",
        "https://sso.douyin.com/qr/connect/?token=secret",
      ] as const;
      const context = {
        openLoginPage: vi.fn(async () => "https://sso.douyin.com/qr/connect/?token=secret"),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
        captureScreenshot: vi.fn(async () => ""),
      };
      const service = new DouyinLoginService({
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-qr-redaction-test",
      enableSessionRuntime: false,
      });

      // When: 启动登录但二维码最终不可用。
      const startPromise = service.start();

      // Then: 诊断必须携带可排查证据，但不能泄露 Cookie、Token、storageState 或完整二维码数据。
      await expect(startPromise).rejects.toThrow("未能从抖音登录页面加载出有效的登录二维码。");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          const diagnostic = err.toDiagnostic();
          expect(diagnostic).toMatchObject({
            reason: "qr_unavailable",
            evidence: expect.anything(),
          });
          const diagnosticText = JSON.stringify(diagnostic);
          for (const sensitiveFragment of sensitiveFragments) {
            expect(diagnosticText).not.toContain(sensitiveFragment);
          }
        } else {
          throw err;
        }
      }
    });

    it("SSO get_qrcode 返回非 JSON HTML 且 Obscura 失败时抛出 sso_challenge 诊断错误", async () => {
      // Given: 抖音 SSO 接口返回 text/html Challenge。
      stubFetchQRCode({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        },
        json: vi.fn(async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
      });

      // 并且 Obscura 兜底也发生了连接失败。
      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => {
          throw new Error("Failed to connect to CDP");
        }),
        enableSessionRuntime: false,
        createID: () => "douyin-login-sso-challenge-test",
      });

      // When: 启动抖音扫码登录。
      const startPromise = service.start();

      // Then: 抛出包含 sso_challenge 类型的 DouyinLoginDiagnosticError。
      await expect(startPromise).rejects.toThrow("抖音登录服务遇到安全验证挑战");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          expect(err.reason).toBe("sso_challenge");
          expect(err.nextActions).toContain(
            "请在浏览器中打开抖音网页版，完成拼图或短信验证码验证后再试",
          );
        } else {
          throw err;
        }
      }
    });

    it("当同时遇到 SSO HTML 挑战和浏览器 fallback 抛出 illegal_app 时，illegal_app 诊断应该胜出", async () => {
      // Given: 抖音 SSO 接口返回 text/html Challenge。
      stubFetchQRCode({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        },
        json: vi.fn(async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
      });

      // 并且 Obscura/Playwright 能够成功启动，但打开页面检测到 illegal_app。
      const context = {
        openLoginPage: vi.fn(async () => {
          throw new DouyinLoginDiagnosticError(
            "illegal_app",
            "抖音开放平台应用配置非法或被封禁（非法应用）。",
            ["请检查"],
          );
        }),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
      };

      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-sso-challenge-vs-illegal-app",
      enableSessionRuntime: false,
      });

      // When: 启动登录。
      const startPromise = service.start();

      // Then: 抛出包含 illegal_app 类型的诊断错误。
      await expect(startPromise).rejects.toThrow("抖音开放平台应用配置非法或被封禁");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          expect(err.reason).toBe("illegal_app");
        } else {
          throw err;
        }
      }
    });

    it("SSO HTML 挑战且浏览器二维码提取失败时返回 manual_verification 并保留会话", async () => {
      // Given: SSO 返回 HTML challenge，Obscura 能连上但页面无法提取二维码。
      stubFetchQRCode({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        },
        json: vi.fn(async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
      });
      const close = vi.fn(async () => undefined);
      const startManualVerificationScreencast = vi.fn(async () => true);
      const unsubscribe = vi.fn(async () => undefined);
      const subscribeManualVerificationFrames = vi.fn(async () => ({ unsubscribe }));
      const context = {
        openLoginPage: vi.fn(async () => ""),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close,
        captureScreenshot: vi.fn(async () => ""),
        startManualVerificationScreencast,
        subscribeManualVerificationFrames,
      };
      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-sso-challenge-vs-qr-unavailable",
        now: () => 1000,
      enableSessionRuntime: false,
      });

      // When: 启动登录。
      const result = await service.start();

      // Then: 保留 Obscura 会话，前端可进入人工远程验证流。
      expect(result).toMatchObject({
        id: "douyin-login-sso-challenge-vs-qr-unavailable",
        status: "manual_verification",
        reason: "captcha_required",
        expiresAt: 301000,
        verification: {
          transport: "cdp",
          input: ["mouse", "key"],
          screencast: "active",
        },
      });
      expect(close).not.toHaveBeenCalled();
      const stream = await service.subscribeManualVerificationFrames(
        "douyin-login-sso-challenge-vs-qr-unavailable",
        () => undefined,
      );
      expect(stream).toEqual({ status: "subscribed", unsubscribe: expect.any(Function) });
      expect(subscribeManualVerificationFrames).toHaveBeenCalledTimes(1);
    });

    it("SSO challenge 且 openLoginPage 卡住时超时仍返回 manual_verification 并保留会话", async () => {
      stubFetchQRCode({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        },
        json: vi.fn(async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
      });
      const close = vi.fn(async () => undefined);
      const startManualVerificationScreencast = vi.fn(async () => true);
      const context = {
        openLoginPage: vi.fn(() => new Promise<string>(() => undefined)),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close,
        captureScreenshot: vi.fn(async () => ""),
        startManualVerificationScreencast,
      };
      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => context),
        browserLoginTimeoutMs: 40,
        createID: () => "douyin-login-sso-challenge-openlogin-hang",
        now: () => 1000,
      enableSessionRuntime: false,
      });

      const startedAt = Date.now();
      const result = await service.start();
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(result).toMatchObject({
        id: "douyin-login-sso-challenge-openlogin-hang",
        status: "manual_verification",
        reason: "captcha_required",
      });
      expect(close).not.toHaveBeenCalled();
    });

    it("SSO challenge 且 openLoginPage 抛出通用浏览器错误时返回 manual_verification 并保留会话", async () => {
      stubFetchQRCode({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        },
        json: vi.fn(async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
      });
      const close = vi.fn(async () => undefined);
      const startManualVerificationScreencast = vi.fn(async () => false);
      const subscribeManualVerificationFrames = vi.fn(async () => ({
        unsubscribe: vi.fn(async () => undefined),
      }));
      const context = {
        openLoginPage: vi.fn(async () => {
          throw new Error("Navigation failed: net::ERR_ABORTED");
        }),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close,
        captureScreenshot: vi.fn(async () => ""),
        startManualVerificationScreencast,
        subscribeManualVerificationFrames,
      };
      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-sso-challenge-generic-browser-error",
        now: () => 1000,
      enableSessionRuntime: false,
      });

      const result = await service.start();

      expect(result).toMatchObject({
        id: "douyin-login-sso-challenge-generic-browser-error",
        status: "manual_verification",
        reason: "captcha_required",
        expiresAt: 301000,
        verification: {
          transport: "cdp",
          input: ["mouse", "key"],
          screencast: "unavailable",
        },
      });
      expect(close).not.toHaveBeenCalled();
      const stream = await service.subscribeManualVerificationFrames(
        "douyin-login-sso-challenge-generic-browser-error",
        () => undefined,
      );
      expect(stream).toEqual({ status: "subscribed", unsubscribe: expect.any(Function) });
      expect(subscribeManualVerificationFrames).toHaveBeenCalledTimes(1);
    });

    it("openLoginPage 卡住且无 SSO challenge 时超时返回 qr_unavailable 并清理资源", async () => {
      stubFetchQRCode(createJSONResponse({ data: {} }));
      const close = vi.fn(async () => undefined);
      const context = {
        openLoginPage: vi.fn(() => new Promise<string>(() => undefined)),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close,
        captureScreenshot: vi.fn(async () => ""),
      };
      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => context),
        browserLoginTimeoutMs: 40,
        createID: () => "douyin-login-openlogin-hang-qr-unavailable",
      enableSessionRuntime: false,
      });

      const startedAt = Date.now();
      const startPromise = service.start();
      await expect(startPromise).rejects.toThrow(/超时|timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          expect(err.reason).toBe("browser_timeout");
        } else {
          throw err;
        }
      }
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("当同时遇到 SSO HTML 挑战和 CDP 不可用时，sso_challenge 诊断应该胜出", async () => {
      // Given: 抖音 SSO 接口返回 text/html Challenge。
      stubFetchQRCode({
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null),
        },
        json: vi.fn(async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
      });

      // 并且 Obscura/Playwright 启动失败。
      const service = new DouyinLoginService({
        enableHTTPQRCode: true,
        createContext: vi.fn(async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:9222");
        }),
        enableSessionRuntime: false,
        createID: () => "douyin-login-sso-challenge-vs-cdp-unavailable",
      });

      // When: 启动登录。
      const startPromise = service.start();

      // Then: 抛出包含 sso_challenge 类型的诊断错误。
      await expect(startPromise).rejects.toThrow("抖音登录服务遇到安全验证挑战");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          expect(err.reason).toBe("sso_challenge");
        } else {
          throw err;
        }
      }
    });

    it("Obscura 登录页 HTML 包含非法应用时抛出 illegal_app 诊断错误", async () => {
      // Given: HTTP 接口返回空导致 fallback 开启，Obscura 页面内有非法应用字样。
      stubFetchQRCode(createJSONResponse({ data: {} }));
      const context = {
        openLoginPage: vi.fn(async () => {
          // 这里抛出检测到的非法应用错误（模拟 openLoginPage 遇到非法应用抛出）
          throw new Error("illegal_app");
        }),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
      };

      const service = new DouyinLoginService({
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-illegal-app-test",
      enableSessionRuntime: false,
      });

      // When: 启动登录。
      const startPromise = service.start();

      // Then: 抛出包含 illegal_app 类型的诊断错误。
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          expect(err.reason).toBe("illegal_app");
        } else {
          throw err;
        }
      }
    });

    it("CDP 不可用时抛出 cdp_unavailable 诊断错误", async () => {
      // Given: HTTP 接口返回空，Obscura 的 CDP 服务未开启。
      stubFetchQRCode(createJSONResponse({ data: {} }));
      const service = new DouyinLoginService({
        createContext: vi.fn(async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:9222");
        }),
        enableSessionRuntime: false,
        createID: () => "douyin-login-cdp-unavailable-test",
      });

      // When: 启动登录。
      const startPromise = service.start();

      // Then: 抛出包含 cdp_unavailable 类型的诊断错误。
      await expect(startPromise).rejects.toThrow("浏览器自动化代理解析服务连接失败");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          expect(err.reason).toBe("cdp_unavailable");
        } else {
          throw err;
        }
      }
    });

    it("慢加载二维码 DOM：在 waitForSelector 返回元素后，轮询等待真实二维码图片 src 稳定后返回", async () => {
      // Given: 二维码元素的 getAttribute("src") 慢加载，前 2 次返回空，第三次及以后返回真实图片 src。
      let callCount = 0;
      const image: TestElementHandle = {
        getAttribute: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) {
            return "";
          }
          return QR_SRC;
        }),
        screenshot: vi.fn(async () => "raw-screenshot"),
      };
      const page = {
        goto: vi.fn(async () => undefined),
        waitForSelector: vi.fn(async () => image),
        evaluate: createEvaluateFunction("data:image/png;base64,unused"),
      };

      // When: Playwright helper 解析二维码元素来源。
      const result = await __private__.findQRCodeSource(page);

      // Then: 应该最终返回稳定的图片 src，不提前走截图，且 getAttribute 调用了多次。
      expect(result.source).toBe(QR_SRC);
      expect(image.getAttribute.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(image.screenshot).not.toHaveBeenCalled();
    });

    it("图片 src 始终为 blob: 且 evaluate 迁移失败时，回退到二维码元素截图并返回 data:image/png", async () => {
      // Given: 二维码元素 src 为 blob，但 page.evaluate 迁移失败（如返回空字符串）。
      const blobQRCode = "blob:https://www.douyin.com/qr-code";
      const image: TestElementHandle = {
        getAttribute: vi.fn(async () => blobQRCode),
        screenshot: vi.fn(async () => "fallback-blob-screenshot"),
      };
      const page = {
        goto: vi.fn(async () => undefined),
        waitForSelector: vi.fn(async () => image),
        evaluate: vi.fn(createEvaluateFunction("")) as unknown as TestPageEvaluate,
      };

      // When: Playwright helper 解析二维码元素来源。
      const result = await __private__.findQRCodeSource(page);

      // Then: 应该回退到二维码截图。
      expect(result.source).toBe("data:image/png;base64,fallback-blob-screenshot");
      expect(page.evaluate).toHaveBeenCalledWith(__private__.readImageAsDataURL, blobQRCode);
      expect(image.screenshot).toHaveBeenCalledWith({ type: "png" });
    });

    it("页面水合失败或二维码 DOM 始终为 0 时，返回脱敏诊断，不泄露完整 URL/base64/Cookie/Token/storageState/stack", async () => {
      // Given: 二维码 DOM 始终未加载成功，且 context/page 中包含各种敏感凭证信息。
      const sensitiveToken = "token_secret_123456";
      const sensitiveCookie = "sessionid=secret_cookie_val";
      const sensitiveBase64 = "data:image/png;base64,secret_base64_long_string_here";
      const sensitiveURL = "https://sso.douyin.com/qr/connect/?token=url_token_secret";

      const evaluateFn = vi.fn(async () => {
        throw new Error(`eval failed: ${sensitiveCookie} token:${sensitiveToken}`);
      }) as unknown as TestPageEvaluate;

      const page = {
        on: vi.fn(() => undefined),
        goto: vi.fn(async () => undefined),
        waitForSelector: vi.fn(async () => {
          throw new Error(`waterfall hydration failed with stack trace\n  at checkImage (${sensitiveURL}:42)`);
        }),
        evaluate: evaluateFn,
      };

      const context = {
        newPage: vi.fn(async () => page),
        cookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
        addInitScript: vi.fn(async () => undefined),
        captureScreenshot: vi.fn(async () => sensitiveBase64),
      };

      const browser = {
        newContext: vi.fn(async () => context),
        close: vi.fn(async () => undefined),
      };
      const chromium = {
        connectOverCDP: vi.fn(async () => browser),
      };

      const loginContext = await __private__.createPlaywrightContext(
        "http://127.0.0.1:9222",
        chromium,
      );

      const service = new DouyinLoginService({
        createContext: vi.fn(async () => loginContext),
        createID: () => "douyin-login-hydration-failure-test",
      enableSessionRuntime: false,
      });

      // When: 启动登录，触发二维码不可用。
      const startPromise = service.start();

      // Then: 抛出的错误必须经过脱敏，不泄露敏感的 Token, Cookie, URL, base64 或 stack
      await expect(startPromise).rejects.toThrow("未能从抖音登录页面加载出有效的登录二维码。");
      try {
        await startPromise;
      } catch (err: unknown) {
        if (err instanceof DouyinLoginDiagnosticError) {
          const diagnostic = err.toDiagnostic();
          expect(diagnostic.reason).toBe("qr_unavailable");
          
          const diagnosticStr = JSON.stringify(diagnostic);
          expect(diagnosticStr).not.toContain(sensitiveToken);
          expect(diagnosticStr).not.toContain(sensitiveCookie);
          expect(diagnosticStr).not.toContain(sensitiveBase64);
          expect(diagnosticStr).not.toContain(sensitiveURL);
          expect(diagnosticStr).not.toContain("checkImage");
        } else {
          throw err;
        }
      }
    });
  });

  describe("Wave 1 人工验证契约 RED", () => {
    type ManualVerificationInput =
      | {
          readonly kind: "mouse";
          readonly type: "move" | "down" | "up";
          readonly x: number;
          readonly y: number;
          readonly button?: "left" | "right" | "middle";
        }
      | {
          readonly kind: "key";
          readonly type: "down" | "up";
          readonly key: string;
          readonly code?: string;
          readonly text?: string;
        };

    type ManualVerificationInputService = {
      readonly dispatchManualVerificationInput: (
        id: string,
        event: ManualVerificationInput,
      ) => Promise<{ readonly status: "accepted" }>;
    };

    it("A. 页面要求人工验证时返回 manual_verification，而不是 qr_unavailable", async () => {
      // Given: 抖音登录页明确要求先完成人工验证，当前页面没有可迁移二维码。
      const { process, startObscura } = createObscuraLifecycleHarness();
      const context = {
        openLoginPage: vi.fn(async () => "请完成下列验证后继续"),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
      };
      const service = createServiceWithOnDemandObscura({
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-manual-verification-a",
        now: () => 1000,
      });

      // When/Then: 后端应把验证码挑战暴露为可继续的人工验证状态，而非二维码不可用诊断。
      await expect(service.start()).resolves.toMatchObject({
        id: "douyin-login-manual-verification-a",
        status: "manual_verification",
      });
      expect(process.close).not.toHaveBeenCalled();
    });

    it("B. manual_verification 状态下不提前关闭 Obscura 进程和 Playwright context", async () => {
      // Given: 页面通过验证码 iframe 进入人工验证，需要保持同一浏览器上下文等待用户操作。
      const { process, startObscura } = createObscuraLifecycleHarness();
      const context = {
        openLoginPage: vi.fn(async () => '<iframe src="https://verify.douyin.com/captcha"></iframe>'),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
      };
      const service = createServiceWithOnDemandObscura({
        createContext: vi.fn(async () => context),
        createID: () => "douyin-login-manual-verification-b",
        now: () => 1000,
      });

      // When: 启动流程遇到人工验证。
      await service.start().catch(() => undefined);

      // Then: 即使当前实现还不能返回 manual_verification，也不能把用户需要继续操作的页面提前销毁。
      expect(context.close).not.toHaveBeenCalled();
      expect(process.close).not.toHaveBeenCalled();
    });

    it("C. cancel(id) 后停止 screencast、关闭 context 并清理 Obscura", async () => {
      // Given: 已存在人工验证中的浏览器会话和 Obscura 进程。
      const id = "douyin-login-manual-verification-cancel";
      const stopManualVerificationScreencast = vi.fn(async () => undefined);
      const context = {
        openLoginPage: vi.fn(async () => QR_SRC),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
        stopManualVerificationScreencast,
      };
      const service = createServiceWithOnDemandObscura({
        createContext: vi.fn(async () => context),
        createID: () => id,
        now: () => 1000,
      });
      const serviceInternals = service as unknown as {
        readonly sessions: Map<string, unknown>;
      };
      serviceInternals.sessions.set(id, {
        kind: "browser",
        id,
        qrCode: "manual-verification-screen",
        expiresAt: 2000,
        context,
      });

      // When: 用户取消人工验证流程。
      const result = await service.cancel(id);

      // Then: screencast 必须先停止，随后关闭 Playwright context。
      expect(result).toEqual({ status: "cancelled" });
      expect(stopManualVerificationScreencast).toHaveBeenCalledTimes(1);
      expect(context.close).toHaveBeenCalledTimes(1);
    });

    it("D. 人工验证完成后继续同一页面流程并返回二维码或登录成功 Cookie", async () => {
      // Given: 首次打开页面遇到人工验证，用户完成后同一 context 可以刷新出二维码。
      const context = {
        openLoginPage: vi.fn(async () => "请完成下列验证后继续"),
        openRedirectURL: vi.fn(async () => undefined),
        getCookies: vi.fn(async () => []),
        close: vi.fn(async () => undefined),
        refreshQRCode: vi.fn(async () => QR_SRC),
      };
      const createContext = vi.fn(async () => context);
      const service = createServiceWithOnDemandObscura({
        createContext,
        createID: () => "douyin-login-manual-verification-d",
        now: () => 1000,
      });

      // When: 后端先返回 manual_verification，随后轮询同一页面。
      await expect(service.start()).resolves.toMatchObject({
        id: "douyin-login-manual-verification-d",
        status: "manual_verification",
      });
      const pollResult = await service.poll("douyin-login-manual-verification-d");

      // Then: 不应新建 context，应继续原页面并返回二维码或已登录 Cookie。
      expect(createContext).toHaveBeenCalledTimes(1);
      expect(context.refreshQRCode).toHaveBeenCalledTimes(1);
      expect(["waiting", "completed"]).toContain(pollResult.status);
      if (pollResult.status === "waiting") {
        expect(pollResult.qrCode).toBe(QR_SRC);
      } else if (pollResult.status === "completed") {
        expect(pollResult.cookies.length).toBeGreaterThan(0);
      }
    });

    it("E. 输入事件只允许必要白名单字段并拒绝敏感字段或任意 CDP method", async () => {
      // Given: 人工验证输入通道只接受鼠标和键盘的最小事件字段。
      const { service } = createService();
      const dispatchInput = (service as unknown as ManualVerificationInputService)
        .dispatchManualVerificationInput;
      const serviceInternals = service as unknown as {
        readonly sessions: Map<string, unknown>;
      };
      serviceInternals.sessions.set("douyin-login-input", {
        kind: "browser",
        id: "douyin-login-input",
        qrCode: "manual-verification-screen",
        expiresAt: Date.now() + 300000,
        context: {
          dispatchManualVerificationInput: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          getCookies: vi.fn(async () => []),
          openLoginPage: vi.fn(async () => QR_SRC),
          openRedirectURL: vi.fn(async () => undefined),
        },
      });

      // When/Then: 后端必须提供受限输入入口；当前缺失实现应以断言失败暴露。
      expect(dispatchInput).toEqual(expect.any(Function));
      if (typeof dispatchInput !== "function") {
        return;
      }

      await expect(
        dispatchInput("douyin-login-input", { kind: "mouse", type: "move", x: 120, y: 240 }),
      ).resolves.toEqual({ status: "accepted" });

      const forbiddenPayloads: readonly unknown[] = [
        { kind: "mouse", type: "down", x: 1, y: 1, cookie: "sessionid=secret" },
        { kind: "key", type: "down", key: "Enter", token: "secret-token" },
        { kind: "key", type: "up", key: "Tab", storageState: { cookies: [] } },
        { kind: "mouse", type: "move", x: 1, y: 1, data: "data:image/png;base64,full-frame" },
        { method: "Page.navigate", params: { url: "https://douyin.com" } },
      ];

      for (const payload of forbiddenPayloads) {
        await expect(
          dispatchInput("douyin-login-input", payload as ManualVerificationInput),
        ).rejects.toThrow(/unsupported|forbidden|sensitive|invalid/i);
      }
    });

    it("F. 诊断日志和错误 evidence 必须脱敏", () => {
      // Given: 人工验证诊断 evidence 内含 Cookie、Token、storageState、完整 data:image 和 stack 片段。
      const sensitiveCookie = "sessionid=secret-cookie-value";
      const sensitiveToken = "token=secret-token-value";
      const sensitiveStorageState = 'storageState={"cookies":[{"value":"secret"}]}';
      const sensitiveImage = "data:image/png;base64,secret_full_frame";
      const sensitiveStack = "at verifyFrame (/tmp/private/manual.ts:12:34)";
      const error = new DouyinLoginDiagnosticError(
        "generic_failure",
        `manual verification failed ${sensitiveCookie} ${sensitiveToken}`,
        ["请重新打开人工验证会话"],
        { cause: new Error(`manual evidence ${sensitiveStorageState}\n${sensitiveStack}`) },
        {
          events: [`console:error:${sensitiveCookie}:${sensitiveToken}:${sensitiveImage}:${sensitiveStack}`],
          page: {
            qrImageCount: 0,
            bodyText: `请完成下列验证后继续 ${sensitiveStorageState}`,
          },
          qrSource: sensitiveImage,
        },
      );

      // When: 诊断对象被序列化给路由或日志消费者。
      const diagnosticText = JSON.stringify(error.toDiagnostic());
      const causeText = String((error as Error & { readonly cause?: unknown }).cause);
      const fullDiagnosticText = `${error.message}\n${diagnosticText}\n${causeText}\n${error.stack ?? ""}`;

      // Then: 所有 evidence 和错误链路都不能泄露敏感原文。
      expect(fullDiagnosticText).not.toContain(sensitiveCookie);
      expect(fullDiagnosticText).not.toContain(sensitiveToken);
      expect(fullDiagnosticText).not.toContain(sensitiveStorageState);
      expect(fullDiagnosticText).not.toContain(sensitiveImage);
      expect(fullDiagnosticText).not.toContain(sensitiveStack);
    });
  });
});
