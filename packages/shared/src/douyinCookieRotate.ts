import { createHash } from "node:crypto";

/** 判定 cookie 轮换的鉴权 Set-Cookie 名白名单（仅名字，不含值）。 */
export const AUTH_SET_COOKIE_NAMES = Object.freeze([
  "sessionid",
  "sessionid_ss",
  "sid_tt",
  "sid_guard",
  "uid_tt",
] as const);

const AUTH_SET_COOKIE_NAME_SET: ReadonlySet<string> = new Set(AUTH_SET_COOKIE_NAMES);

export type CookieRotateCheckInput = {
  readonly hashBefore12: string;
  readonly hashAfter12: string;
  readonly setCookieNames: readonly string[];
};

/**
 * 对完整 Cookie header 字符串做 SHA-256，返回小写 hex 前 12 位。
 * 哈希对象是整段 header 原文，不解析、不截取单个 name。
 */
export function hashCookieHeader12(header: string): string {
  return createHash("sha256").update(header).digest("hex").slice(0, 12);
}

/**
 * 从 Set-Cookie 头提取 cookie 名（`=` 前、`;` 第一段，trim）。
 * 空串 / undefined 返回 []。不回传 cookie 值。
 */
export function collectSetCookieNames(
  setCookieHeader: string | string[] | undefined,
): string[] {
  if (setCookieHeader == null) return [];
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const names: string[] = [];
  for (const header of headers) {
    const firstSegment = header.split(";", 1)[0] ?? "";
    const eq = firstSegment.indexOf("=");
    const name = (eq === -1 ? firstSegment : firstSegment.slice(0, eq)).trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

/**
 * 判断 cookie 是否发生轮换：hash 前后不同，或 Set-Cookie 名命中鉴权白名单。
 * 仅 ttwid / msToken 不视为轮换。
 */
export function isCookieRotated(input: CookieRotateCheckInput): boolean {
  if (input.hashBefore12 !== input.hashAfter12) return true;
  return input.setCookieNames.some((name) => AUTH_SET_COOKIE_NAME_SET.has(name));
}
