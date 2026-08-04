import type { DouyinCookieAccount } from "@biliLive-tools/types";

export type DouyinAccountIdentity = {
  readonly nickname?: string;
  readonly uid?: string;
  readonly sec_user_id?: string;
};

const DOUYIN_STABLE_IDENTITY_COOKIE_NAMES = [
  "uid_tt",
  "uid_tt_ss",
  "sec_user_id",
  "sec_uid",
] as const;

export const createDouyinCookieAccount = (): DouyinCookieAccount => ({
  id: `dy-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  remark: "",
  cookie: "",
  enabled: true,
  weight: 1,
});

export const createDouyinScanLoginRemark = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `扫码导入-${year}-${month}-${day}`;
};

const pickText = (value: string | undefined): string => {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
};

export const pickDouyinAccountRemark = (
  identity: DouyinAccountIdentity | undefined,
  fallbackRemark: string,
): string => {
  const nickname = pickText(identity?.nickname);
  if (nickname !== "") return nickname;
  const uid = pickText(identity?.uid);
  if (uid !== "") return uid;
  const secUserID = pickText(identity?.sec_user_id);
  if (secUserID !== "") return secUserID;
  return fallbackRemark;
};

export const resolveDouyinApiAccountKey = (identity: DouyinAccountIdentity | undefined): string => {
  const uid = pickText(identity?.uid);
  if (uid !== "") return uid;
  return pickText(identity?.sec_user_id);
};

export const resolveDouyinCookieStableIdentity = (cookie: string): string => {
  const cookiePairs = cookie.split(";");
  for (const name of DOUYIN_STABLE_IDENTITY_COOKIE_NAMES) {
    const prefix = `${name}=`;
    const matchedPair = cookiePairs.find((pair) => pair.trim().startsWith(prefix));
    const value = matchedPair?.trim().slice(prefix.length).trim() ?? "";
    if (value !== "") return value;
  }
  return "";
};

export const findDouyinAccountIndexByApiKey = (
  accounts: readonly DouyinCookieAccount[],
  apiKey: string,
): number => {
  const key = pickText(apiKey);
  if (key === "") return -1;
  return accounts.findIndex((account) => pickText(account.accountUid) === key);
};
