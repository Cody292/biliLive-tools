import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPassportCheckURL,
  checkDouyinQRCodeStatus,
  extractQRCode,
  extractQRCodeStatus,
  isDouyinAuthCookieSuccess,
  isThinCheckURL,
  resetDouyinCookieJar,
  seedDouyinCookieJar,
  __private__,
} from "./douyinQRCode.js";

function createJSONResponse(body: unknown) {
  return {
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: vi.fn(async () => body),
  };
}

beforeEach(() => {
  resetDouyinCookieJar();
  seedDouyinCookieJar({ ttwid: "test-ttwid" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetDouyinCookieJar();
});

describe("douyinQRCode product protocol (B.7)", () => {
  it("禁 thin check：仅 token+service 判定为 thin", () => {
    const thin = "https://sso.douyin.com/check_qrconnect/?token=abc&service=https%3A%2F%2Fwww.douyin.com";
    expect(isThinCheckURL(thin)).toBe(true);
  });

  it("passport check URL 非 thin 且含 passport_jssdk_version", () => {
    const url = buildPassportCheckURL("token-xyz");
    expect(isThinCheckURL(url)).toBe(false);
    expect(url.hostname).toBe("login.douyin.com");
    expect(url.pathname).toContain("check_qrconnect");
    expect(url.searchParams.get("passport_jssdk_version")).toBeTruthy();
    expect(url.searchParams.get("token")).toBe("token-xyz");
  });

  it("extractQRCode 兼容裸 base64 PNG", () => {
    // minimal PNG header base64
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(80).fill(1)]).toString(
      "base64",
    );
    const result = extractQRCode({ data: { token: "tok123", qrcode: pngB64 } });
    expect(result).toBeDefined();
    expect(result?.token).toBe("tok123");
    expect(result?.qrCode.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("extractQRCode 回退 qrcode_index_url（含 amemv）", () => {
    const result = extractQRCode({
      data: {
        token: "tok456",
        qrcode_index_url:
          "https://api.amemv.com/ucenter_web/app/aweme/scan_login/index/douyin_scan_code_login",
      },
    });
    expect(result?.token).toBe("tok456");
    expect(result?.qrCode).toContain("api.amemv.com");
  });

  it("extractQRCode 仅 index 且无 token 时失败", () => {
    expect(
      extractQRCode({ data: { qrcode_index_url: "https://sso.douyin.com/qr/connect/?token=x" } }),
    ).toBeUndefined();
  });

  it("状态机：new/scanned/expired/confirmed 字符串与数字", () => {
    expect(extractQRCodeStatus({ data: { status: "new" } })).toEqual({ kind: "waiting" });
    expect(extractQRCodeStatus({ data: { status: "1" } })).toEqual({ kind: "waiting" });
    expect(extractQRCodeStatus({ data: { status: "scanned" } })).toEqual({ kind: "scanned" });
    expect(extractQRCodeStatus({ data: { status: "2" } })).toEqual({ kind: "scanned" });
    expect(extractQRCodeStatus({ data: { status: "5" } })).toEqual({ kind: "expired" });
    expect(extractQRCodeStatus({ data: { status: "expired" } })).toEqual({ kind: "expired" });
    expect(
      extractQRCodeStatus({
        data: {
          status: "confirmed",
          redirect_url: "https://www.douyin.com/passport/sso/login/callback/?ticket=t",
        },
      }),
    ).toEqual({
      kind: "confirmed",
      redirectURL: "https://www.douyin.com/passport/sso/login/callback/?ticket=t",
    });
    expect(
      extractQRCodeStatus({
        data: {
          status: "3",
          redirect_url: "https://www.douyin.com/passport/sso/login/callback/?ticket=t",
        },
      }),
    ).toMatchObject({ kind: "confirmed" });
  });

  it("2046 → need_app_verify，不得映射为 waiting", () => {
    const status = extractQRCodeStatus({
      error_code: 2046,
      description: "请前往抖音APP完成验证",
      data: { status: "scanned" },
    });
    expect(status).toEqual({
      kind: "need_app_verify",
      errorCode: 2046,
      description: "请前往抖音APP完成验证",
    });
  });

  it("error_code=22 illegal_app 不得映射为 waiting", () => {
    const status = extractQRCodeStatus({
      error_code: 22,
      description: "非法应用",
      data: {},
    });
    expect(status).toEqual({
      kind: "illegal_app",
      errorCode: 22,
      description: "非法应用",
    });
  });

  it("Cookie 成功判定：sessionid + sid_tt", () => {
    expect(
      isDouyinAuthCookieSuccess([
        { name: "sessionid" },
        { name: "sid_tt" },
      ]),
    ).toBe(true);
  });

  it("Cookie 成功判定：仅 sessionid 不足", () => {
    expect(isDouyinAuthCookieSuccess([{ name: "sessionid" }])).toBe(false);
  });

  it("Cookie 成功判定：sessionid + uid_tt", () => {
    expect(
      isDouyinAuthCookieSuccess([
        { name: "sessionid" },
        { name: "uid_tt" },
      ]),
    ).toBe(true);
  });

  it("checkDouyinQRCodeStatus 请求非 thin URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(isThinCheckURL(url)).toBe(false);
      expect(url).toContain("passport_jssdk_version");
      expect(url).toContain("login.douyin.com");
      return createJSONResponse({ data: { status: "new" }, error_code: 0 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const status = await checkDouyinQRCodeStatus("poll-token");
    expect(status).toEqual({ kind: "waiting" });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("出码 URL 常量指向 login.passport 主路径", () => {
    expect(__private__.DOUYIN_PASSPORT_GET_QRCODE_URL).toContain("login.douyin.com");
    expect(__private__.DOUYIN_PASSPORT_GET_QRCODE_URL).toContain("get_qrcode");
    expect(__private__.DOUYIN_PASSPORT_CHECK_URL).toContain("check_qrconnect");
  });
});
