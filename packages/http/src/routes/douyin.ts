import Router from "@koa/router";
import { z } from "zod";

import { douyinLoginService, DouyinLoginDiagnosticError } from "../services/douyinLogin.js";

import type { DouyinLoginService } from "../services/douyinLogin.js";

const LoginIDSchema = z.object({
  id: z.string().min(1),
});

const SubmitSmsCodeSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(4).max(8).regex(/^\d{4,8}$/),
}).strict();

const ManualVerificationMouseEventSchema = z.object({
  kind: z.literal("mouse"),
  type: z.enum(["move", "down", "up"]),
  x: z.number().finite(),
  y: z.number().finite(),
  button: z.enum(["left", "right", "middle"]).optional(),
}).strict();


const ManualVerificationKeyEventSchema = z.object({
  kind: z.literal("key"),
  type: z.enum(["down", "up"]),
  key: z.string().min(1),
  code: z.string().optional(),
  text: z.string().optional(),
}).strict();

const ManualVerificationInputSchema = z.object({
  id: z.string().min(1),
  event: z.union([ManualVerificationMouseEventSchema, ManualVerificationKeyEventSchema]),
}).strict();

const AccountIdentitySchema = z.object({
  cookie: z.string().trim().min(1),
}).strict();

type ManualVerificationResponse = {
  readonly id: string;
  readonly status: "manual_verification";
  readonly reason: "captcha_required";
  readonly expiresAt: number;
  readonly verification: {
    readonly transport: "cdp";
    readonly input: readonly ["mouse", "key"];
    readonly screencast: "active" | "unavailable";
  };
};

type DouyinAccountIdentity = {
  readonly nickname?: string;
  readonly uid?: string;
  readonly sec_user_id?: string;
};

type DouyinLoginServiceContract = Pick<
  DouyinLoginService,
  "start" | "poll" | "cancel"
> &
  Partial<
    Pick<
      DouyinLoginService,
      | "dispatchManualVerificationInput"
      | "subscribeManualVerificationFrames"
      | "submitSmsCode"
    >
  >;

function sanitizeLoginResult(result: Awaited<ReturnType<DouyinLoginServiceContract["poll"]>>) {
  if (result.status === "manual_verification") {
    return sanitizeManualVerificationResult(result);
  }
  if (result.status === "need_app_verify") {
    return sanitizeNeedAppVerifyResult(result);
  }
  if (result.status === "completed") {
    return sanitizeCompletedResult(result);
  }
  return result;
}

function sanitizeNeedAppVerifyResult(
  result: Extract<Awaited<ReturnType<DouyinLoginServiceContract["poll"]>>, { status: "need_app_verify" }>,
) {
  return {
    id: result.id,
    status: "need_app_verify" as const,
    error_code: 2046 as const,
    qrCode: result.qrCode,
    expiresAt: result.expiresAt,
    webSms: {
      tried: result.webSms.tried,
      smsApiSeen: result.webSms.smsApiSeen,
      ...(result.webSms.sendResult === undefined
        ? {}
        : {
            sendResult: {
              hostPath: result.webSms.sendResult.hostPath,
              ok: result.webSms.sendResult.ok,
              ...(result.webSms.sendResult.message === undefined
                ? {}
                : { message: result.webSms.sendResult.message }),
            },
          }),
    },
    ...(result.description === undefined ? {} : { description: result.description }),
  };
}

function sanitizeCompletedResult(
  result: Extract<Awaited<ReturnType<DouyinLoginServiceContract["poll"]>>, { status: "completed" }>,
) {
  return {
    id: result.id,
    status: "completed" as const,
    // 仅返回 cookie 键名结构；值保留供账号池写入但 route 层不额外日志
    cookies: result.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
    })),
  };
}


function sanitizeManualVerificationResult(result: ManualVerificationResponse): ManualVerificationResponse {
  return {
    id: result.id,
    status: "manual_verification",
    reason: result.reason,
    expiresAt: result.expiresAt,
    verification: {
      transport: result.verification.transport,
      input: result.verification.input,
      screencast: result.verification.screencast,
    },
  };
}

const DOUYIN_IDENTITY_TIMEOUT_MS = 3500;

function pickDouyinIdentityText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function firstDouyinIdentityText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const picked = pickDouyinIdentityText(value);
    if (picked !== undefined) {
      return picked;
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDouyinIdentityUser(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const directUser = payload.user ?? payload.user_info ?? payload.userInfo;
  if (isPlainRecord(directUser)) {
    return directUser;
  }
  const data = payload.data;
  if (!isPlainRecord(data)) {
    return undefined;
  }
  const dataUser = data.user ?? data.user_info ?? data.userInfo;
  return isPlainRecord(dataUser) ? dataUser : undefined;
}

function normalizeDouyinIdentityPayload(payload: unknown): DouyinAccountIdentity {
  if (!isPlainRecord(payload)) {
    return {};
  }
  const user = readDouyinIdentityUser(payload) ?? payload;
  const nickname = firstDouyinIdentityText(user.nickname, user.nick_name, user.name, payload.nickname);
  const uid = firstDouyinIdentityText(user.uid, user.user_id, user.userId, payload.uid);
  const secUserID = firstDouyinIdentityText(user.sec_uid, user.sec_user_id, user.secUid, payload.sec_user_id);
  return {
    ...(nickname === undefined ? {} : { nickname }),
    ...(uid === undefined ? {} : { uid }),
    ...(secUserID === undefined ? {} : { sec_user_id: secUserID }),
  };
}

async function fetchDouyinAccountIdentity(cookie: string): Promise<DouyinAccountIdentity> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOUYIN_IDENTITY_TIMEOUT_MS);
  try {
    const response = await fetch(
      "https://www.douyin.com/aweme/v1/web/user/profile/self/?aid=6383&device_platform=webapp",
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/json, text/plain, */*",
          cookie,
          referer: "https://www.douyin.com/",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
      },
    );
    if (!response.ok) {
      return {};
    }
    const text = await response.text();
    if (text.trim() === "") {
      return {};
    }
    return normalizeDouyinIdentityPayload(JSON.parse(text));
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

type DouyinRouterOptions = {
  readonly fetchAccountIdentity?: (cookie: string) => Promise<DouyinAccountIdentity>;
};

export function createDouyinRouter(
  service: DouyinLoginServiceContract = douyinLoginService,
  options: DouyinRouterOptions = {},
) {
  const router = new Router({
    prefix: "/douyin",
  });
  const fetchAccountIdentity = options.fetchAccountIdentity ?? fetchDouyinAccountIdentity;

  router.post("/login", async (ctx) => {
    try {
      ctx.body = await service.start();
    } catch (error) {
      if (error instanceof DouyinLoginDiagnosticError) {
        ctx.status = 502;
        ctx.body = error.toDiagnostic();
        return;
      }
      if (error instanceof Error) {
        ctx.status = 502;
        ctx.body = {
          reason: "generic_failure",
          message: "抖音登录启动发生未知错误。",
          nextActions: ["请检查后端系统日志", "确认网络代理与抖音接口通信正常"],
        };
        return;
      }
      throw error;
    }
  });

  router.post("/account/identity", async (ctx) => {
    const parsed = AccountIdentitySchema.safeParse(ctx.request.body);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "invalid account identity payload" };
      return;
    }
    try {
      ctx.body = await fetchAccountIdentity(parsed.data.cookie);
    } catch {
      ctx.body = {};
    }
  });

  router.get("/login/poll", async (ctx) => {
    const parsed = LoginIDSchema.safeParse(ctx.request.query);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "id required" };
      return;
    }
    try {
      const result = await service.poll(parsed.data.id);
      if (result.status === "not_found") {
        ctx.status = 404;
      }
      ctx.body = sanitizeLoginResult(result);
    } catch (error) {
      if (error instanceof DouyinLoginDiagnosticError) {
        ctx.status = 502;
        ctx.body = error.toDiagnostic();
        return;
      }
      throw error;
    }
  });

  router.get("/login/manual/stream", async (ctx) => {
    const parsed = LoginIDSchema.safeParse(ctx.request.query);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "id required" };
      return;
    }
    if (service.subscribeManualVerificationFrames === undefined) {
      ctx.status = 404;
      ctx.body = { status: "not_found" };
      return;
    }
    const pollResult = await service.poll(parsed.data.id);
    if (pollResult.status !== "manual_verification") {
      ctx.status = 404;
      ctx.body = { status: "not_found" };
      return;
    }
    const pendingFrames: string[] = [];
    let streaming = false;
    const result = await service.subscribeManualVerificationFrames(parsed.data.id, (frame) => {
      const payload = `event: frame\ndata: ${JSON.stringify(frame)}\n\n`;
      if (streaming) {
        ctx.res.write(payload);
        return;
      }
      pendingFrames.push(payload);
    });
    if (result.status === "not_found") {
      ctx.status = 404;
      ctx.body = { status: "not_found" };
      return;
    }
    ctx.respond = false;
    ctx.req.socket.setTimeout(0);
    ctx.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    streaming = true;
    for (const frame of pendingFrames) {
      ctx.res.write(frame);
    }
    const interval = setInterval(async () => {
      const pollResult = await service.poll(parsed.data.id);
      if (pollResult.status === "manual_verification") {
        return;
      }
      clearInterval(interval);
      await result.unsubscribe();
      ctx.res.end();
    }, 1000);
    let closed = false;
    const cleanup = async () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(interval);
      await result.unsubscribe();
    };
    ctx.req.on("close", cleanup);
    ctx.res.on("close", cleanup);
  });

  router.post("/login/manual/input", async (ctx) => {
    const parsed = ManualVerificationInputSchema.safeParse(ctx.request.body);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "invalid manual verification input" };
      return;
    }
    if (service.dispatchManualVerificationInput === undefined) {
      ctx.status = 404;
      ctx.body = { status: "not_found" };
      return;
    }
    try {
      const result = await service.dispatchManualVerificationInput(parsed.data.id, parsed.data.event);
      if (result.status === "not_found") {
        ctx.status = 404;
      }
      ctx.body = result;
    } catch (error) {
      if (error instanceof Error) {
        ctx.status = 400;
        ctx.body = { message: "invalid manual verification input" };
        return;
      }
      throw error;
    }
  });

  router.post("/login/cancel", async (ctx) => {
    const parsed = LoginIDSchema.safeParse(ctx.request.body);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "id required" };
      return;
    }
    const result = await service.cancel(parsed.data.id);
    if (result.status === "not_found") {
      ctx.status = 404;
    }
    ctx.body = result;
  });

  router.post("/login/sms", async (ctx) => {
    const parsed = SubmitSmsCodeSchema.safeParse(ctx.request.body);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "invalid sms code payload" };
      return;
    }
    if (service.submitSmsCode === undefined) {
      ctx.status = 404;
      ctx.body = { status: "not_found" };
      return;
    }
    try {
      const result = await service.submitSmsCode(parsed.data.id, parsed.data.code);
      if (result.status === "not_found") {
        ctx.status = 404;
      } else if (result.status === "invalid_code") {
        ctx.status = 400;
      } else if (result.status === "not_applicable") {
        ctx.status = 409;
      }
      // 脱敏：不回显完整 code
      ctx.body = result;
    } catch (error) {
      if (error instanceof DouyinLoginDiagnosticError) {
        ctx.status = 502;
        ctx.body = error.toDiagnostic();
        return;
      }
      throw error;
    }
  });

  return router;
}


export default createDouyinRouter();
