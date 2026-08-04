import http from "node:http";
import Koa from "koa";
import { bodyParser } from "@koa/bodyparser";
import { describe, expect, it } from "vitest";

import { DouyinLoginDiagnosticError } from "../services/douyinLogin.js";
import { createDouyinRouter } from "./douyin.js";

type DouyinRouteService = NonNullable<Parameters<typeof createDouyinRouter>[0]>;
type DouyinRouteOptions = NonNullable<Parameters<typeof createDouyinRouter>[1]>;

type TestSSEConnection = {
  readonly response: Response;
  readonly close: () => Promise<void>;
};

function createApp(
  service: DouyinRouteService = {
    start: async () => ({
      id: "douyin-login-1",
      status: "waiting" as const,
      qrCode: "data:image/png;base64,qr-code",
      expiresAt: 301000,
    }),
    poll: async () => ({
      id: "douyin-login-1",
      status: "waiting" as const,
      qrCode: "data:image/png;base64,qr-code",
      expiresAt: 301000,
    }),
    cancel: async () => ({ status: "cancelled" as const }),
    dispatchManualVerificationInput: async () => ({ status: "accepted" as const }),
    subscribeManualVerificationFrames: async (_id, handler) => {
      handler({ data: "jpeg-frame", format: "jpeg" });
      return { status: "subscribed" as const, unsubscribe: async () => {} };
    },
  },
  options: DouyinRouteOptions = {},
) {
  const app = new Koa();
  app.use(bodyParser());
  app.use(createDouyinRouter(service, options).routes());
  return app;
}

async function request(app: Koa, path: string, init: RequestInit = {}) {
  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test server address unavailable");
  }
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    server.close();
  }
}

async function requestStream(app: Koa, path: string): Promise<TestSSEConnection> {
  const server = http.createServer(app.callback());
  const controller = new AbortController();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("test server address unavailable");
  }
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    signal: controller.signal,
  });
  return {
    response,
    close: () => new Promise<void>((resolve) => {
      controller.abort();
      server.close(() => resolve());
    }),
  };
}

describe("douyin login routes", () => {
  it("POST /douyin/login 返回扫码会话和二维码数据", async () => {
    // Given: HTTP 应用注册了抖音登录路由。
    const app = createApp();

    // When: 客户端启动扫码登录。
    const response = await request(app, "/douyin/login", { method: "POST" });

    // Then: 返回会话 ID 和二维码 data URL。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "douyin-login-1",
      status: "waiting",
      qrCode: "data:image/png;base64,qr-code",
      expiresAt: 301000,
    });
  });

  it("GET /douyin/login/poll 缺少 id 时返回安全错误", async () => {
    // Given: HTTP 应用注册了抖音登录路由。
    const app = createApp();

    // When: 客户端缺少会话 ID 轮询。
    const response = await request(app, "/douyin/login/poll");

    // Then: 返回 400 且不暴露内部堆栈。
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ message: "id required" });
  });

  it("DYQR-EDGE-003 POST /douyin/login 启动失败时返回安全网关错误", async () => {
    // Given: 启动扫码服务抛出包含内部细节的错误。
    const app = createApp({
      start: async () => {
        throw new Error(
          "Cookie=sessionid=secret; CDP endpoint ws://127.0.0.1:9222/devtools/browser; selector img.qrcode; stack trace",
        );
      },
      poll: async () => ({ status: "not_found" as const }),
      cancel: async () => ({ status: "not_found" as const }),
    });

    // When: 客户端启动扫码登录.
    const response = await request(app, "/douyin/login", { method: "POST" });
    const bodyText = await response.text();

    // Then: 仅返回安全错误消息，不泄露内部调试信息。
    expect(response.status).toBe(502);
    expect(JSON.parse(bodyText)).toEqual({
      reason: "generic_failure",
      message: "抖音登录启动发生未知错误。",
      nextActions: ["请检查后端系统日志", "确认网络代理与抖音接口通信正常"],
    });
    expect(bodyText).not.toContain("stack");
    expect(bodyText).not.toContain("Cookie");
    expect(bodyText).not.toContain("CDP endpoint");
    expect(bodyText).not.toContain("selector");
  });

  it("POST /douyin/login 携带特定诊断类型时返回对应的错误 payload", async () => {
    // Given: 抖音启动抛出 sso_challenge 类型的 DouyinLoginDiagnosticError。
    const app = createApp({
      start: async () => {
        throw new DouyinLoginDiagnosticError(
          "sso_challenge",
          "抖音登录服务遇到安全验证挑战，需要进行身份验证。",
          ["动作1", "动作2"],
        );
      },
      poll: async () => ({ status: "not_found" as const }),
      cancel: async () => ({ status: "not_found" as const }),
    });

    // When: 客户端请求登录接口。
    const response = await request(app, "/douyin/login", { method: "POST" });

    // Then: 路由应该以 502 状态返回 toDiagnostic() 序列化结果。
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      reason: "sso_challenge",
      message: "抖音登录服务遇到安全验证挑战，需要进行身份验证。",
      nextActions: ["动作1", "动作2"],
    });
  });

  it("GET /douyin/login/poll 携带特定诊断类型时返回对应的错误 payload", async () => {
    // Given: 抖音轮询抛出 cdp_unavailable 类型的 DouyinLoginDiagnosticError。
    const app = createApp({
      start: async () => ({
        id: "douyin-login-1",
        status: "waiting" as const,
        qrCode: "data:image/png;base64,qr-code",
        expiresAt: 301000,
      }),
      poll: async () => {
        throw new DouyinLoginDiagnosticError(
          "cdp_unavailable",
          "浏览器自动化代理解析服务连接失败（CDP 不可用）。",
          ["动作1", "动作2"],
        );
      },
      cancel: async () => ({ status: "not_found" as const }),
    });

    // When: 客户端轮询扫码登录状态。
    const response = await request(app, "/douyin/login/poll?id=douyin-login-1");

    // Then: 路由应该以 502 状态返回 toDiagnostic() 序列化结果。
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      reason: "cdp_unavailable",
      message: "浏览器自动化代理解析服务连接失败（CDP 不可用）。",
      nextActions: ["动作1", "动作2"],
    });
  });

  it("GET /douyin/login/poll 返回 manual_verification 状态时只暴露安全契约字段", async () => {
    // Given: 服务层返回 manual_verification 状态，同时意外携带敏感字段。
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
        cookies: [{ name: "sessionid", value: "secret", domain: ".douyin.com" }],
        storageState: { cookies: [] },
        qrCode: "data:image/png;base64,secret-frame",
        token: "secret-token",
      } as never),
      cancel: async () => ({ status: "cancelled" as const }),
      dispatchManualVerificationInput: async () => ({ status: "accepted" as const }),
      subscribeManualVerificationFrames: async (_id, handler) => {
        handler({ data: "jpeg-frame", format: "jpeg" });
        return { status: "subscribed" as const, unsubscribe: async () => {} };
      },
    });

    // When: 客户端轮询手动验证状态。
    const response = await request(app, "/douyin/login/poll?id=manual-1");
    const bodyText = await response.text();

    // Then: 只返回前端手动验证所需的安全字段。
    expect(response.status).toBe(200);
    expect(JSON.parse(bodyText)).toEqual({
      id: "manual-1",
      status: "manual_verification",
      reason: "captcha_required",
      expiresAt: 301000,
      verification: { transport: "cdp", input: ["mouse", "key"], screencast: "active" },
    });
    expect(bodyText).not.toContain("sessionid");
    expect(bodyText).not.toContain("secret-token");
    expect(bodyText).not.toContain("storageState");
    expect(bodyText).not.toContain("data:image");
  });

  it("GET /douyin/login/manual/stream 为 manual 会话返回 SSE 帧且断开不取消登录会话", async () => {
    // Given: 服务层存在一个 manual browser 会话并能订阅 JPEG screencast 帧。
    let cancelCalled = false;
    let unsubscribeCalled = false;
    let resolveUnsubscribe: () => void = () => undefined;
    const unsubscribePromise = new Promise<void>((resolve) => {
      resolveUnsubscribe = resolve;
    });
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      cancel: async () => {
        cancelCalled = true;
        return { status: "cancelled" as const };
      },
      dispatchManualVerificationInput: async () => ({ status: "accepted" as const }),
      subscribeManualVerificationFrames: async (_id, handler) => {
        handler({ data: "jpeg-frame", format: "jpeg" });
        return {
          status: "subscribed" as const,
          unsubscribe: async () => {
            unsubscribeCalled = true;
            resolveUnsubscribe();
          },
        };
      },
    });

    // When: 客户端打开 SSE stream 并读取首个事件后断开。
    const connection = await requestStream(app, "/douyin/login/manual/stream?id=manual-1");
    const reader = connection.response.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    await connection.close();
    await Promise.race([
      unsubscribePromise,
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);

    // Then: SSE 只输出 frame 事件，客户端断开只取消订阅，不调用登录 cancel。
    const streamText = new TextDecoder().decode(chunk?.value);
    expect(connection.response.status).toBe(200);
    expect(connection.response.headers.get("content-type")).toContain("text/event-stream");
    expect(streamText).toContain("event: frame");
    expect(streamText).toContain('"data":"jpeg-frame"');
    expect(streamText).not.toContain("data:image");
    expect(unsubscribeCalled).toBe(true);
    expect(cancelCalled).toBe(false);
  });

  it("GET /douyin/login/manual/stream 对不存在会话返回 404", async () => {
    // Given: 服务层找不到 manual 会话。
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({ status: "not_found" as const }),
      cancel: async () => ({ status: "not_found" as const }),
      dispatchManualVerificationInput: async () => ({ status: "not_found" as const }),
      subscribeManualVerificationFrames: async () => ({ status: "not_found" as const }),
    });

    // When: 客户端请求不存在会话的 SSE stream。
    const response = await request(app, "/douyin/login/manual/stream?id=missing");

    // Then: 复用登录会话不存在的 404 约定。
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ status: "not_found" });
  });

  it("POST /douyin/login/manual/input 转发合法输入事件", async () => {
    // Given: 服务层记录收到的手动验证输入。
    let received: unknown;
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({ status: "not_found" as const }),
      cancel: async () => ({ status: "cancelled" as const }),
      dispatchManualVerificationInput: async (_id, event) => {
        received = event;
        return { status: "accepted" as const };
      },
      subscribeManualVerificationFrames: async (_id, handler) => {
        handler({ data: "jpeg-frame", format: "jpeg" });
        return { status: "subscribed" as const, unsubscribe: async () => {} };
      },
    });

    // When: 客户端提交鼠标输入事件。
    const response = await request(app, "/douyin/login/manual/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "manual-1", event: { kind: "mouse", type: "move", x: 12, y: 34 } }),
    });

    // Then: 路由返回 accepted 并原样转发事件对象。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "accepted" });
    expect(received).toEqual({ kind: "mouse", type: "move", x: 12, y: 34 });
  });

  it("POST /douyin/login/manual/input 拒绝非法字段且不转发服务层", async () => {
    // Given: 输入体带有禁止透传的 token 字段。
    let dispatchCalled = false;
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({ status: "not_found" as const }),
      cancel: async () => ({ status: "cancelled" as const }),
      dispatchManualVerificationInput: async () => {
        dispatchCalled = true;
        return { status: "accepted" as const };
      },
      subscribeManualVerificationFrames: async (_id, handler) => {
        handler({ data: "jpeg-frame", format: "jpeg" });
        return { status: "subscribed" as const, unsubscribe: async () => {} };
      },
    });

    // When: 客户端提交非法输入字段。
    const response = await request(app, "/douyin/login/manual/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "manual-1", event: { kind: "mouse", type: "move", x: 12, y: 34, token: "secret" } }),
    });
    const bodyText = await response.text();

    // Then: 路由边界拒绝请求且响应不泄露 token 值。
    expect(response.status).toBe(400);
    expect(JSON.parse(bodyText)).toEqual({ message: "invalid manual verification input" });
    expect(bodyText).not.toContain("secret");
    expect(dispatchCalled).toBe(false);
  });

  it("POST /douyin/login/manual/input 对不存在会话返回 404", async () => {
    // Given: 服务层返回 not_found。
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({ status: "not_found" as const }),
      cancel: async () => ({ status: "not_found" as const }),
      dispatchManualVerificationInput: async () => ({ status: "not_found" as const }),
      subscribeManualVerificationFrames: async () => ({ status: "not_found" as const }),
    });

    // When: 客户端向不存在会话发送输入。
    const response = await request(app, "/douyin/login/manual/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "missing", event: { kind: "key", type: "down", key: "A" } }),
    });

    // Then: 返回 404 not_found。
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ status: "not_found" });
  });

  it("POST /douyin/account/identity 返回账号身份且不经过登录轮询", async () => {
    // Given: 独立身份端点通过注入 fetcher 返回昵称。
    let receivedCookie = "";
    let pollCalled = false;
    const app = createApp(
      {
        start: async () => ({
          id: "douyin-login-1",
          status: "waiting" as const,
          qrCode: "data:image/png;base64,qr-code",
          expiresAt: 301000,
        }),
        poll: async () => {
          pollCalled = true;
          return { status: "not_found" as const };
        },
        cancel: async () => ({ status: "not_found" as const }),
      },
      {
        fetchAccountIdentity: async (cookie) => {
          receivedCookie = cookie;
          return { nickname: "抖音昵称", uid: "uid-1", sec_user_id: "sec-1" };
        },
      },
    );

    // When: 前端在账号已入池后异步查询身份。
    const response = await request(app, "/douyin/account/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: "uid_tt=uid-1; sessionid=secret" }),
    });

    // Then: 返回身份字段，不触发登录轮询。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ nickname: "抖音昵称", uid: "uid-1", sec_user_id: "sec-1" });
    expect(receivedCookie).toBe("uid_tt=uid-1; sessionid=secret");
    expect(pollCalled).toBe(false);
  });

  it("POST /douyin/account/identity 查询失败时返回空对象", async () => {
    // Given: 身份查询依赖失败。
    const app = createApp(undefined, {
      fetchAccountIdentity: async () => {
        throw new Error("identity lookup failed");
      },
    });

    // When: 客户端查询身份。
    const response = await request(app, "/douyin/account/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie: "not_a_real_cookie=1" }),
    });

    // Then: 失败不阻塞账号入池调用方。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });

  it("POST /douyin/account/identity 拒绝非法 payload 且不转发 cookie", async () => {
    // Given: 身份 fetcher 可观测是否被调用。
    let called = false;
    const app = createApp(undefined, {
      fetchAccountIdentity: async () => {
        called = true;
        return {};
      },
    });

    // When: 请求体缺少 cookie。
    const response = await request(app, "/douyin/account/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "secret" }),
    });
    const bodyText = await response.text();

    // Then: 边界拒绝，响应不泄露 token。
    expect(response.status).toBe(400);
    expect(JSON.parse(bodyText)).toEqual({ message: "invalid account identity payload" });
    expect(bodyText).not.toContain("secret");
    expect(called).toBe(false);
  });

  it("POST /douyin/login/cancel 继续通过服务层取消 manual 会话", async () => {
    // Given: manual 会话由服务层负责停止 screencast 并清理 Obscura。
    let cancelledID = "";
    const app = createApp({
      start: async () => ({
        id: "manual-1",
        status: "manual_verification" as const,
        reason: "captcha_required" as const,
        expiresAt: 301000,
        verification: { transport: "cdp" as const, input: ["mouse", "key"] as const, screencast: "active" as const },
      }),
      poll: async () => ({ status: "not_found" as const }),
      cancel: async (id) => {
        cancelledID = id;
        return { status: "cancelled" as const };
      },
      dispatchManualVerificationInput: async () => ({ status: "accepted" as const }),
      subscribeManualVerificationFrames: async (_id, handler) => {
        handler({ data: "jpeg-frame", format: "jpeg" });
        return { status: "subscribed" as const, unsubscribe: async () => {} };
      },
    });

    // When: 客户端取消 manual 会话。
    const response = await request(app, "/douyin/login/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "manual-1" }),
    });

    // Then: 路由保持现有 cancel 契约并把清理委托给服务层。
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "cancelled" });
    expect(cancelledID).toBe("manual-1");
  });
});
