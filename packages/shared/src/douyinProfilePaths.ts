import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** 生产环境 Profile 根目录（一号一目录） */
export const DEFAULT_DOUYIN_PROFILE_BASE_DIR =
  process.env.DOUYIN_PROFILE_BASE_DIR ??
  (existsSync("/app/data") ? "/app/data/douyin-profiles" : "/code/biliLive-tools/data/douyin-profiles");

/** 安全 accountId：字母数字、点、下划线、连字符；禁止空/路径穿越/分隔符 */
const SAFE_ACCOUNT_ID_RE = /^[A-Za-z0-9._-]+$/;

/** accountId 消毒失败 */
export class InvalidAccountIdError extends Error {
  readonly code = "INVALID_ACCOUNT_ID" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountIdError";
  }
}

/**
 * 消毒 accountId：trim 后校验为安全目录名。
 * 拒绝空、`..`、`/`、`\` 及非安全字符。
 */
export function sanitizeAccountId(accountId: string): string {
  const id = accountId.trim();
  if (!id) {
    throw new InvalidAccountIdError("accountId must not be empty");
  }
  if (id === "." || id === ".." || id.includes("..")) {
    throw new InvalidAccountIdError("accountId must not contain path traversal");
  }
  if (id.includes("/") || id.includes("\\")) {
    throw new InvalidAccountIdError("accountId must not contain path separators");
  }
  if (!SAFE_ACCOUNT_ID_RE.test(id)) {
    throw new InvalidAccountIdError(
      "accountId must be a safe directory name ([A-Za-z0-9._-]+)",
    );
  }
  return id;
}

/**
 * 解析账号 Profile 目录路径。
 * @param accountId 账号 ID（会消毒）
 * @param baseDir 可注入根目录；缺省为生产默认根
 */
export function resolveProfileDir(
  accountId: string,
  baseDir: string = DEFAULT_DOUYIN_PROFILE_BASE_DIR,
): string {
  const safeId = sanitizeAccountId(accountId);
  return path.join(baseDir, safeId);
}

export type EnsureProfileDirOptions = {
  /** 覆盖默认 Profile 根（测试用 tmp） */
  baseDir?: string;
  /** 可注入 mkdir（便于单测） */
  mkdir?: (dir: string, opts: { recursive: true }) => Promise<unknown>;
};

/**
 * 确保一号一目录存在（递归 mkdir）。
 * @returns 已创建/已存在的 profile 目录绝对路径
 */
export async function ensureProfileDir(
  accountId: string,
  options: EnsureProfileDirOptions = {},
): Promise<string> {
  const dir = resolveProfileDir(accountId, options.baseDir);
  const mkdir = options.mkdir ?? ((d, o) => fs.mkdir(d, o));
  await mkdir(dir, { recursive: true });
  return dir;
}
