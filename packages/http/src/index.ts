import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import https from "node:https";
import Koa from "koa";
import Router from "@koa/router";
import cors from "@koa/cors";
import { bodyParser } from "@koa/bodyparser";
import logger from "@biliLive-tools/shared/utils/log.js";

import errorMiddleware from "./middleware/error.js";

import webhookRouter from "./routes/webhook.js";
import configRouter from "./routes/config.js";
import llmRouter from "./routes/llm.js";
import commonRouter from "./routes/common.js";
import userRouter from "./routes/user.js";
import presetRouter from "./routes/preset.js";
import SSERouter from "./routes/sse.js";
import recocderRouter, { handleRecorderUpgrade } from "./routes/recorder.js";
import biliRouter from "./routes/bili.js";
import douyinRouter from "./routes/douyin.js";
import taskRouter from "./routes/task.js";
import assetsRouter from "./routes/assets.js";
import videoRouter from "./routes/video.js";
import recordHistoryRouter from "./routes/recordHistory.js";
import filesRouter from "./routes/files.js";
import danmaRouter from "./routes/danma.js";
import syncRouter from "./routes/sync.js";
import aiRouter from "./routes/ai.js";
import { WebhookHandler } from "./services/webhook/webhook.js";
import { createFileCache } from "./services/fileCache.js";

import type { DouyinCookieAccount, GlobalConfig } from "@biliLive-tools/types";
import type { AwilixContainer } from "awilix";
import type { AppConfig, GlobalContainer } from "@biliLive-tools/shared";

export let config: GlobalConfig;
export let handler!: WebhookHandler;
export let appConfig!: AppConfig;
export let container!: AwilixContainer<GlobalContainer>;
export const fileCache = createFileCache();

let stopSilentRenewHandle: (() => void) | null = null;
let silentRenewSignalRegistered = false;

function registerSilentRenewShutdown(stopFn: () => void): void {
  stopSilentRenewHandle = stopFn;
  if (silentRenewSignalRegistered) {
    return;
  }
  silentRenewSignalRegistered = true;
  const onSignal = () => {
    try {
      stopSilentRenewHandle?.();
    } catch {}
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

export const __dirname = path.dirname(fileURLToPath(import.meta.url));

const authMiddleware = (passKey: string | number) => {
  return async (ctx: Koa.Context, next: Koa.Next) => {
    const authHeader = ctx.headers["authorization"] || ctx.request.query.auth;
    // 忽略视频请求
    if (ctx.path.includes("/common/video/")) {
      await next();
      return;
    }
    if (!authHeader) {
      ctx.status = 401;
      ctx.body = "Authorization header is missing";
      return;
    }

    if (!passKey) {
      ctx.status = 500;
      ctx.body = "passkey should be set";
      return;
    }

    const token = authHeader;
    if (token !== passKey) {
      ctx.status = 401;
      ctx.body = "Forbidden";
      return;
    }

    await next();
  };
};

const app = new Koa();
const router = new Router();

router.get("/", async (ctx) => {
  ctx.body = "Hello biliLive-tools, this is http server! Not for browser use.";
});

app.use(errorMiddleware);
app.use(cors());
app.use(bodyParser());
app.use(router.routes());
app.use(webhookRouter.routes());
app.use(assetsRouter.routes());

export async function serverStart(
  options: {
    port: number;
    host: string;
    auth: boolean;
    passKey: string;
  },
  axContainer: AwilixContainer,
) {
  container = axContainer;

  config = container.resolve("globalConfig");
  appConfig = container.resolve("appConfig");
  handler = new WebhookHandler(appConfig);

  // 探针 B + 探针 C：注入 probeOnce；层2 空闲巡检 best-effort 启动（默认 ON）
  void import("@bililive-tools/douyin-recorder")
    .then(async (rec) => {
      const setProbe = (
        rec as {
          setDouyinProbeOnce?: (
            fn: ((cookie: string) => Promise<unknown>) | null,
          ) => void;
        }
      ).setDouyinProbeOnce;
      if (!setProbe) return;
      const { probeOnce } = await import("./services/douyinIdentityProbe.js");
      const probeFn = (cookie: string) => probeOnce(cookie);
      setProbe(probeFn);

      const setProbeC = (
        rec as {
          setDouyinProbeCOnce?: (
            fn: ((cookie: string) => Promise<unknown>) | null,
          ) => void;
        }
      ).setDouyinProbeCOnce;
      setProbeC?.(probeFn);

      const wire = (
        rec as {
          wireProbeCHost?: (opts: {
            probeOnce?: ((cookie: string) => Promise<unknown>) | null;
            getAccounts?: () => unknown;
            enabled?: boolean;
          }) => { probeInjected: boolean; patrolStarted: boolean };
        }
      ).wireProbeCHost;

      const getAccounts = () => {
        try {
          const recorder = appConfig?.get?.("recorder") as
            | { douyin?: { accounts?: unknown } }
            | undefined;
          const accounts = recorder?.douyin?.accounts;
          return Array.isArray(accounts) ? accounts : null;
        } catch {
          return null;
        }
      };

      const getIdlePatrolEnabled = () => {
        try {
          const recorder = appConfig?.get?.("recorder") as
            | { douyin?: { probeC?: { idlePatrolEnabled?: boolean } } }
            | undefined;
          const enabled = recorder?.douyin?.probeC?.idlePatrolEnabled;
          return enabled !== false;
        } catch {
          return true;
        }
      };

      // getAccounts 拿不到列表时 wire 仍注入 probe 并 no-op start
      wire?.({
        probeOnce: probeFn as (cookie: string) => Promise<unknown>,
        getAccounts,
        enabled: getIdlePatrolEnabled(),
      });

      try {
        const { startSilentRenewScheduler, stopSilentRenewScheduler } =
          await import("./services/douyinSilentRenewScheduler.js");
        registerSilentRenewShutdown(stopSilentRenewScheduler);
        startSilentRenewScheduler({
          getAccounts: () => {
            const list = getAccounts();
            return Array.isArray(list) ? (list as unknown as readonly DouyinCookieAccount[]) : [];
          },
          log: (payload) => {
            logger.info("[douyin-silent-renew]", JSON.stringify(payload));
          },
        });
      } catch {}
    })
    .catch(() => {
      // best-effort
    });

  if (options.auth) {
    const passKey = process.env.BILILIVE_TOOLS_PASSKEY || options.passKey;
    const auth = authMiddleware(passKey);
    app.use(auth);
  }

  app.use(configRouter.routes());
  app.use(llmRouter.routes());
  app.use(userRouter.routes());
  app.use(commonRouter.routes());
  app.use(presetRouter.routes());
  app.use(recocderRouter.routes());
  app.use(biliRouter.routes());
  app.use(douyinRouter.routes());
  app.use(taskRouter.routes());
  app.use(videoRouter.routes());
  app.use(recordHistoryRouter.routes());
  app.use(filesRouter.routes());
  app.use(danmaRouter.routes());
  app.use(syncRouter.routes());
  app.use(aiRouter.routes());

  app.use(SSERouter.routes());
  app.use(router.allowedMethods());

  await createServer(options);
  return app;
}

// function createCertificateAsync(): Promise<pem.CertificateCreationResult> {
//   return new Promise((resolve, reject) => {
//     pem.createCertificate({ days: 1, selfSigned: true }, (err, keys) => {
//       if (err) {
//         reject(err);
//       }
//       resolve(keys);
//     });
//   });
// }

async function createServer(options: { port: number; host: string }) {
  logger.info(`开始创建服务器: ${options.host}:${options.port}`);

  const isHttps = false;
  if (isHttps) {
    // const keys = await createCertificateAsync();
    // const httpsServer = https.createServer(
    //   { key: keys.serviceKey, cert: keys.certificate },
    //   app.callback(),
    // );
    const httpsServer = https.createServer({ key: "", cert: "" }, app.callback());
    httpsServer.on("error", (err) => {
      throw err;
    });
    httpsServer.listen(options.port, options.host, () => {
      console.log(`Server is running at https://${options.host}:${options.port}`);
    });
  } else {
    const httpServer = http.createServer(app.callback());
    httpServer.on("error", (err) => {
      logger.error("HTTP 服务器错误:", err);
    });
    httpServer.on("upgrade", (request, socket, head) => {
      if (handleRecorderUpgrade(request, socket, head)) {
        return;
      }

      socket.destroy();
    });
    httpServer.listen(options.port, options.host, () => {
      logger.info(`Server is running at http://${options.host}:${options.port}`);
    });
  }
}
