import Router from "@koa/router";
import { z } from "zod";

import { scheduleHealthAccountPatch } from "@biliLive-tools/shared";

import { douyinLoginService, DouyinLoginDiagnosticError } from "../services/douyinLogin.js";
import {
  fetchDouyinAccountIdentity,
  mapProbeToHealthHint,
  probeOnce,
  type DouyinAccountIdentity,
  type ProbeOnceResult,
} from "../services/douyinIdentityProbe.js";
import { appConfig } from "../index.js";

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

/** 手动/设置页：按 accountId 或 cookie 校验，写健康字段 */
const AccountProbeSchema = z
  .object({
    accountId: z.string().trim().min(1).optional(),
    cookie: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.accountId || v.cookie), {
    message: "accountId or cookie required",
  });

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

type ResolveProbeCookie = (input: {
  accountId?: string;
  cookie?: string;
}) => Promise<{ accountId?: string; cookie: string } | null>;

type DouyinRouterOptions = {
  readonly fetchAccountIdentity?: (cookie: string) => Promise<DouyinAccountIdentity>;
  readonly probeOnce?: (cookie: string) => Promise<ProbeOnceResult>;
  readonly resolveProbeCookie?: ResolveProbeCookie;
  readonly scheduleHealthPatch?: (input: {
    accountId: string;
    patch: {
      healthStatus?: "healthy" | "expiring" | "invalid" | "relogin_required" | "unknown";
      healthCheckedAt?: number;
      healthReason?: string;
    };
  }) => void;
};

export function createDouyinRouter(
  service: DouyinLoginServiceContract = douyinLoginService,
  options: DouyinRouterOptions = {},
) {
  const router = new Router({
    prefix: "/douyin",
  });
  const fetchAccountIdentity = options.fetchAccountIdentity ?? fetchDouyinAccountIdentity;
  const runProbeOnce = options.probeOnce ?? probeOnce;
  const scheduleHealthPatch = options.scheduleHealthPatch ?? scheduleHealthAccountPatch;
  const resolveProbeCookie: ResolveProbeCookie =
    options.resolveProbeCookie ??
    (async ({ accountId, cookie }) => {
      if (cookie) return { accountId, cookie };
      if (!accountId) return null;
      try {
        const all = appConfig?.getAll?.() as
          | { recorder?: { douyin?: { accounts?: Array<{ id?: string; cookie?: string }> } } }
          | undefined;
        const accounts = all?.recorder?.douyin?.accounts;
        if (!Array.isArray(accounts)) return null;
        const found = accounts.find((a) => a?.id === accountId);
        const c = found?.cookie?.trim();
        if (!c) return null;
        return { accountId, cookie: c };
      } catch {
        return null;
      }
    });

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

  /**
   * 探针 B 手动校验：返回 classifiable ProbeOnceResult，并在有 accountId 时写健康字段。
   * ok→healthy；auth_failed→invalid；timeout/network 仅 reason、status 不变。
   */
  router.post("/account/probe", async (ctx) => {
    const parsed = AccountProbeSchema.safeParse(ctx.request.body);
    if (!parsed.success) {
      ctx.status = 400;
      ctx.body = { message: "invalid account probe payload" };
      return;
    }

    let accountId = parsed.data.accountId;
    let cookie = parsed.data.cookie;

    if (!cookie && accountId) {
      const resolved = await resolveProbeCookie({ accountId, cookie });
      if (!resolved) {
        ctx.status = 404;
        ctx.body = { message: "account not found" };
        return;
      }
      accountId = resolved.accountId ?? accountId;
      cookie = resolved.cookie;
    }

    if (!cookie) {
      ctx.status = 400;
      ctx.body = { message: "cookie required" };
      return;
    }

    const result = await runProbeOnce(cookie);
    const now = Date.now();
    const healthHint = mapProbeToHealthHint(result);

    if (accountId) {
      if (result.ok) {
        scheduleHealthPatch({
          accountId,
          patch: {
            healthStatus: "healthy",
            healthCheckedAt: now,
            healthReason: "probe ok",
          },
        });
      } else if (result.class === "auth_failed") {
        scheduleHealthPatch({
          accountId,
          patch: {
            healthStatus: "invalid",
            healthCheckedAt: now,
            healthReason: result.reason ?? "auth_failed",
          },
        });
      } else {
        // timeout/network：仅 reason，status 不变
        scheduleHealthPatch({
          accountId,
          patch: {
            healthReason: result.reason ?? result.class,
          },
        });
      }
    }

    ctx.body = {
      ...result,
      healthHint: healthHint ?? null,
      accountId: accountId ?? null,
    };
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
