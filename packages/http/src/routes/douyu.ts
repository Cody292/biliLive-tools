import Router from "@koa/router";
import crypto from "node:crypto";

import {
  deleteDouyuUser,
  DouyuQrcodeLogin,
  isDouyuUserPayload,
  readDouyuUser,
  readDouyuUserList,
  writeDouyuUser,
  refreshDouyuUser,
  validateDouyuUser,
} from "@biliLive-tools/shared/recorder/douyu.js";

const router = new Router({ prefix: "/douyu" });
const sessions = new Map<string, DouyuQrcodeLogin>();

const purgeExpiredSessions = () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      session.cancel();
      sessions.delete(id);
    }
  }
};

router.post("/login", async (ctx) => {
  purgeExpiredSessions();
  const session = await DouyuQrcodeLogin.create();
  const id = crypto.randomUUID();
  sessions.set(id, session);
  ctx.body = { id, url: session.url, expiresAt: session.expiresAt };
});

router.get("/login/poll", async (ctx) => {
  const id = String(ctx.query.id || "");
  if (!id) {
    ctx.status = 400;
    ctx.body = "id required";
    return;
  }
  const session = sessions.get(id);
  if (!session) {
    ctx.status = 400;
    ctx.body = "login info not found";
    return;
  }
  const result = await session.poll();
  if (result.status === "completed") {
    writeDouyuUser(result.user);
    sessions.delete(id);
    ctx.body = { status: "completed" };
    return;
  }
  if (result.status === "error") sessions.delete(id);
  ctx.body = result;
});

router.post("/login/cancel", async (ctx) => {
  const { id } = ctx.request.body as { id?: string };
  if (!id) {
    ctx.status = 400;
    ctx.body = "id required";
    return;
  }
  const session = sessions.get(id);
  if (!session) {
    ctx.status = 400;
    ctx.body = "login info not found";
    return;
  }
  session.cancel();
  sessions.delete(id);
  ctx.body = "success";
});

router.get("/user/list", (ctx) => {
  ctx.body = readDouyuUserList().map(({ uid, name, avatar, createdAt, updatedAt }) => ({
    uid,
    name,
    avatar,
    createdAt,
    updatedAt,
  }));
});

router.post("/user/update_auth", async (ctx) => {
  const uid = Number((ctx.request.body as { uid?: number })?.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    ctx.status = 400;
    ctx.body = "valid uid required";
    return;
  }
  await refreshDouyuUser(uid);
  ctx.body = "success";
});

router.post("/user/validate", async (ctx) => {
  const uid = Number((ctx.request.body as { uid?: number })?.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    ctx.status = 400;
    ctx.body = "valid uid required";
    return;
  }
  ctx.body = { valid: await validateDouyuUser(uid) };
});

router.post("/user/delete", (ctx) => {
  const uid = Number((ctx.request.body as { uid?: number }).uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    ctx.status = 400;
    ctx.body = "valid uid required";
    return;
  }
  deleteDouyuUser(uid);
  ctx.body = "success";
});

router.get("/user/export", (ctx) => {
  ctx.body = readDouyuUserList();
});

router.post("/user/export_single", (ctx) => {
  const uid = Number((ctx.request.body as { uid?: number })?.uid);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    ctx.status = 400;
    ctx.body = "valid uid required";
    return;
  }
  const user = readDouyuUser(uid);
  if (!user) {
    ctx.status = 404;
    ctx.body = "用户不存在";
    return;
  }
  ctx.body = user;
});

router.post("/user/import", (ctx) => {
  const { users } = (ctx.request.body as { users?: unknown }) || {};
  if (!Array.isArray(users)) {
    ctx.status = 400;
    ctx.body = "参数错误";
    return;
  }
  for (const item of users) {
    if (!isDouyuUserPayload(item)) {
      ctx.status = 400;
      ctx.body = "账号数据不完整";
      return;
    }
  }
  for (const item of users) {
    writeDouyuUser(item, { preserveTimestamps: true });
  }
  ctx.status = 200;
});

router.post("/user/import_single", (ctx) => {
  const { user } = (ctx.request.body as { user?: unknown }) || {};
  if (!isDouyuUserPayload(user)) {
    ctx.status = 400;
    ctx.body = "账号数据不完整";
    return;
  }
  writeDouyuUser(user, { preserveTimestamps: true });
  ctx.status = 200;
});

export default router;
