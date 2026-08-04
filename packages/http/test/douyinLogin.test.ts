import { beforeEach, describe, expect, it, vi } from "vitest";

type InitScript = string | (() => void) | { readonly path?: string; readonly content?: string };

const mockAddInitScript = vi.fn<(script: InitScript) => Promise<void>>(async () => undefined);
const mockPage = {
  goto: vi.fn(async () => undefined),
  waitForSelector: vi.fn(async () => ({
    getAttribute: vi.fn(async () => "data:image/png;base64,mocked-qr"),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
  })),
  evaluate: vi.fn(async () => "data:image/png;base64,mocked-qr"),
};
const mockBrowserContext = {
  newPage: vi.fn(async () => mockPage),
  cookies: vi.fn(async () => []),
  close: vi.fn(async () => undefined),
  addInitScript: mockAddInitScript,
};
const mockBrowser = {
  newContext: vi.fn(async () => mockBrowserContext),
  close: vi.fn(async () => undefined),
};

vi.mock("node:module", () => ({
  createRequire: () => (id: string) => {
    if (id === "playwright-core") {
      return {
        chromium: {
          connectOverCDP: async () => mockBrowser,
        },
      };
    }
    throw new Error(`unmocked createRequire call: ${id}`);
  },
}));

vi.mock("../src/services/douyinQRCode.js", () => ({
  acquireDouyinQRCode: vi.fn(async () => undefined),
  checkDouyinQRCodeStatus: vi.fn(async () => undefined),
  isDouyinAuthCookieSuccess: (cookies: readonly { readonly name: string }[]) => {
    const names = new Set(cookies.map((cookie) => cookie.name));
    if (!names.has("sessionid") && !names.has("sessionid_ss")) {
      return false;
    }
    return (
      names.has("sid_tt") ||
      names.has("uid_tt") ||
      names.has("uid_tt_ss") ||
      names.has("sid_guard")
    );
  },
  DouyinSSOChallengeError: class DouyinSSOChallengeError extends Error {},
}));


import { DouyinLoginService, __private__ } from "../src/services/douyinLogin.js";

type LoginServiceOptions = NonNullable<ConstructorParameters<typeof DouyinLoginService>[0]>;
type LoginContext = Awaited<ReturnType<NonNullable<LoginServiceOptions["createContext"]>>>;
type QRCodePage = Parameters<typeof __private__.findQRCodeSource>[0];
type QRCodeImage = Awaited<ReturnType<QRCodePage["waitForSelector"]>>;

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

const createLoginService = (context: LoginContext, now = 1_000): DouyinLoginService =>
  new DouyinLoginService({
    cdpEndpoint: "http://127.0.0.1:9222",
    enableHTTPQRCode: false,
    enableSessionRuntime: false,
    createContext: async () => context,
    createID: () => "login-1",
    now: () => now,
    sessionTTLMs: 60_000,
  });


describe("DouyinLoginService first-party QR flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Given first-party QR flow When resolving the login entry Then it does not use known illegal SSO routes", () => {
    expect(__private__.douyinLoginURL).toMatch(/^https:\/\/(creator|www)\.douyin\.com\/?$/);
    expect(__private__.douyinLoginURL).not.toContain("/passport/web/login/");
    expect(__private__.douyinLoginURL).not.toContain("sso");
  });

  it("Given official first-party QR markup When extracting QR source Then img aria-label selector is supported", async () => {
    const selectors: string[] = [];
    const qrImage: QRCodeImage = {
      getAttribute: vi.fn(async () => "https://www.douyin.com/official-login-qr.png"),
      screenshot: vi.fn(async () => PNG_BYTES),
    };
    const page: QRCodePage = {
      goto: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async (selector) => {
        selectors.push(selector);
        if (selector === 'img[aria-label="二维码"]') {
          return qrImage;
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      evaluate: vi.fn(async () => "data:image/png;base64,official"),
    };

    const result = await __private__.findQRCodeSource(page);

    expect(selectors).toContain('img[aria-label="二维码"]');
    expect(result.source).toBe("data:image/png;base64,official");
  });

  it("Given waiting browser session When Douyin sessionid cookie appears Then polling completes with cookies", async () => {
    const context: LoginContext = {
      openLoginPage: vi.fn(async () => "data:image/png;base64,qr"),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => [
        { name: "sessionid", value: "session-value", domain: ".douyin.com" },
        { name: "sid_tt", value: "sid-value", domain: ".douyin.com" },
      ]),
      close: vi.fn(async () => undefined),
    };
    const service = createLoginService(context);

    await service.start();
    const result = await service.poll("login-1");

    expect(result).toEqual({
      id: "login-1",
      status: "completed",
      cookies: [
        { name: "sessionid", value: "session-value", domain: ".douyin.com" },
        { name: "sid_tt", value: "sid-value", domain: ".douyin.com" },
      ],
    });
    expect(context.close).toHaveBeenCalledTimes(1);
  });


  it("Given expired QR is visible When polling browser session Then it refreshes QR without changing public response shape", async () => {
    const context: LoginContext = {
      openLoginPage: vi.fn(async () => "data:image/png;base64,old"),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
      refreshQRCode: vi.fn(async () => "data:image/png;base64,new"),
    };
    const service = createLoginService(context);

    await service.start();
    const result = await service.poll("login-1");

    expect(result).toEqual({
      id: "login-1",
      status: "waiting",
      qrCode: "data:image/png;base64,new",
      expiresAt: 61_000,
    });
    expect(context.close).not.toHaveBeenCalled();
  });

  it("Given official first-party QR markup with container When extracting QR source Then div#animate_qrcode_container img selector is supported", async () => {
    const selectors: string[] = [];
    const qrImage: QRCodeImage = {
      getAttribute: vi.fn(async () => "https://www.douyin.com/official-login-qr.png"),
      screenshot: vi.fn(async () => PNG_BYTES),
    };
    const page: QRCodePage = {
      goto: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async (selector) => {
        selectors.push(selector);
        if (selector === "div#animate_qrcode_container img") {
          return qrImage;
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      evaluate: vi.fn(async () => "data:image/png;base64,official"),
    };

    const result = await __private__.findQRCodeSource(page);

    expect(selectors).toContain("div#animate_qrcode_container img");
    expect(result.source).toBe("data:image/png;base64,official");
  });

  it("Given default cdp context When creating context Then it registers stealth init script", async () => {
    mockAddInitScript.mockClear();
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
    enableSessionRuntime: false,
    });
    const result = await service.start();
    expect(result.status).toBe("waiting");
    expect(mockAddInitScript).toHaveBeenCalledTimes(1);
    expect(mockAddInitScript).toHaveBeenCalledWith(expect.any(Function));
  });

  it("Given missing document head When stealth init script runs Then it creates a style target", async () => {
    mockAddInitScript.mockClear();
    const service = new DouyinLoginService({
      cdpEndpoint: "http://127.0.0.1:9222",
    enableSessionRuntime: false,
    });
    await service.start();
    const initScript = mockAddInitScript.mock.lastCall?.[0];
    if (typeof initScript !== "function") {
      throw new Error("expected function init script");
    }

    const insertBefore = vi.fn((element: { readonly tagName: string }) => element);
    const documentElement = {
      firstChild: null,
      insertBefore,
    };
    const document = {
      head: null,
      querySelector: vi.fn((selector: string) => (selector === "head" ? null : null)),
      createElement: vi.fn((tagName: string) => ({ tagName: tagName.toUpperCase() })),
      documentElement,
      addEventListener: vi.fn(),
    };
    const navigator = Object.create({});
    const window = {};

    vi.stubGlobal("document", document);
    vi.stubGlobal("navigator", navigator);
    vi.stubGlobal("window", window);

    await initScript();

    expect(document.createElement).toHaveBeenCalledWith("head");
    expect(insertBefore).toHaveBeenCalledTimes(1);
    expect(document.addEventListener).not.toHaveBeenCalled();
    expect(window).toHaveProperty("chrome");
  });

  it("Given no QR code found When starting service Then it throws qr_unavailable diagnostic error", async () => {
    const context: LoginContext = {
      openLoginPage: vi.fn(async () => {
        const dummyPage: QRCodePage = {
          goto: vi.fn(async () => undefined),
          waitForSelector: vi.fn(async () => {
            throw new Error("not found");
          }),
          evaluate: vi.fn(async () => ""),
        };
        await __private__.findQRCodeSource(dummyPage);
        return "";
      }),
      openRedirectURL: vi.fn(async () => undefined),
      getCookies: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    };
    const service = createLoginService(context);
    await expect(service.start()).rejects.toThrow("未能从抖音登录页面加载出有效的登录二维码。");
  });
});
