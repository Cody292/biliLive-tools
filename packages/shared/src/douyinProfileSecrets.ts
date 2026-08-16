import fs from "node:fs/promises";
import path from "node:path";

import { decrypt, encrypt } from "./utils/crypto.js";

/** Profile 目录内 secrets 侧车文件名 */
export const SECRETS_SIDECAR_FILENAME = "secrets.enc";

/** 脱敏前缀最大长度（禁止完整 cookie） */
const REDACT_PREFIX_MAX = 8;

/** 缺少 BILILIVE_TOOLS_BILIKEY */
export class MissingBilikeyError extends Error {
  readonly code = "MISSING_BILIKEY" as const;

  constructor(message = "BILILIVE_TOOLS_BILIKEY is required") {
    super(message);
    this.name = "MissingBilikeyError";
  }
}

/** 侧车明文载荷（cookie / session） */
export type SecretsPayload = {
  cookie: string;
  session?: string;
};

/** 日志/诊断用脱敏元数据 */
export type CookieRedactMeta = {
  cookieLen: number;
  prefix: string;
};

/**
 * 解析加密密钥：仅读取 BILILIVE_TOOLS_BILIKEY。
 * 缺省或空白 → MissingBilikeyError（禁止静默成功 / 禁止回落到硬编码）。
 */
export function resolveBilikey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.BILILIVE_TOOLS_BILIKEY?.trim();
  if (!key) {
    throw new MissingBilikeyError();
  }
  return key;
}

/**
 * 加密 cookie/session 侧车 blob（AES via shared crypto）。
 * @param key 可显式注入；缺省走 resolveBilikey
 */
export function encryptSecretsBlob(
  payload: SecretsPayload,
  key?: string,
): string {
  const passKey = key ?? resolveBilikey();
  return encrypt(JSON.stringify(payload), passKey);
}

/**
 * 解密侧车 blob。
 * @param key 可显式注入；缺省走 resolveBilikey
 */
export function decryptSecretsBlob(
  ciphertext: string,
  key?: string,
): SecretsPayload {
  const passKey = key ?? resolveBilikey();
  const raw = decrypt(ciphertext, passKey);
  const parsed = JSON.parse(raw) as SecretsPayload;
  if (typeof parsed?.cookie !== "string") {
    throw new Error("invalid secrets payload: cookie missing");
  }
  return {
    cookie: parsed.cookie,
    session: typeof parsed.session === "string" ? parsed.session : undefined,
  };
}

/**
 * 将加密 secrets 写入 profile 目录侧车文件。
 * @returns 写入文件路径
 */
export async function writeSecretsSidecar(
  profileDir: string,
  payload: SecretsPayload,
  key?: string,
): Promise<string> {
  const filePath = path.join(profileDir, SECRETS_SIDECAR_FILENAME);
  const cipher = encryptSecretsBlob(payload, key);
  await fs.writeFile(filePath, cipher, "utf8");
  return filePath;
}

/**
 * 从 profile 目录读取并解密 secrets 侧车。
 */
export async function readSecretsSidecar(
  profileDir: string,
  key?: string,
): Promise<SecretsPayload> {
  const filePath = path.join(profileDir, SECRETS_SIDECAR_FILENAME);
  const cipher = await fs.readFile(filePath, "utf8");
  return decryptSecretsBlob(cipher, key);
}

/**
 * 脱敏辅助：仅暴露长度与短前缀，禁止完整 cookie。
 */
export function redactCookieMeta(cookie: string): CookieRedactMeta {
  if (!cookie) {
    return { cookieLen: 0, prefix: "" };
  }
  return {
    cookieLen: cookie.length,
    prefix: cookie.slice(0, REDACT_PREFIX_MAX),
  };
}
