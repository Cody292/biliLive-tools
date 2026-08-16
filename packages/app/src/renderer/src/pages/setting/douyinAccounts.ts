import type { DouyinAccountHealthStatus, DouyinCookieAccount } from "@biliLive-tools/types";

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
  // 留空 = UI「随机」；运行时 normalize 为权重 1 参与选择
  weight: null,
  healthStatus: "unknown",
});

export const getDouyinAccountHealthTagType = (
  status?: DouyinAccountHealthStatus,
): "success" | "warning" | "error" | "default" => {
  switch (status) {
    case "healthy":
      return "success";
    case "expiring":
      return "warning";
    case "invalid":
    case "relogin_required":
      return "error";
    case "unknown":
    default:
      return "default";
  }
};

export const getDouyinAccountHealthTagText = (status?: DouyinAccountHealthStatus): string => {
  switch (status) {
    case "healthy":
      return "健康";
    case "expiring":
      return "临期";
    case "invalid":
      return "失效";
    case "relogin_required":
      return "需重登";
    case "unknown":
    default:
      return "未校验";
  }
};

export const createDouyinScanLoginRemark = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `扫码导入-${year}-${month}-${day}`;
};

/** 账号池用户名左侧展示用；月日不补零，时分补零，如 2026.8.5 00:00 */
export const formatDouyinAccountUpdatedAt = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}.${month}.${day} ${hour}:${minute}`;
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

export type {
  DouyinSilentRenewInterpretInput,
  DouyinSilentRenewUiDecision,
} from "./douyinSilentRenewInterpret";
export { interpretDouyinSilentRenewResult } from "./douyinSilentRenewInterpret";

export type PersistDouyinScanLoginParams = {
  readonly accounts: DouyinCookieAccount[];
  readonly cookie: string;
  readonly getAccountIdentity: (cookie: string) => Promise<DouyinAccountIdentity>;
};

export type PersistDouyinScanLoginResult = {
  readonly didSave: boolean;
  readonly accounts: DouyinCookieAccount[];
  readonly failureReason?: "identity_unavailable" | "identity_empty" | "identity_mismatch";
};

const identityMatchesBoundUid = (
  accountUid: string | undefined,
  identity: DouyinAccountIdentity,
): boolean => {
  const bound = pickText(accountUid);
  if (bound === "") return true;
  return bound === pickText(identity.uid) || bound === pickText(identity.sec_user_id);
};

const applyScanLoginToAccount = (params: {
  readonly account: DouyinCookieAccount;
  readonly cookie: string;
  readonly identity: DouyinAccountIdentity;
  readonly apiKey: string;
}): void => {
  const fallbackRemark =
    params.account.remark.trim() !== "" ? params.account.remark : createDouyinScanLoginRemark();
  params.account.cookie = params.cookie;
  params.account.accountUid = params.apiKey;
  params.account.updatedAt = formatDouyinAccountUpdatedAt();
  params.account.healthStatus = "healthy";
  params.account.healthReason = undefined;
  params.account.healthCheckedAt = Date.now();
  params.account.remark = pickDouyinAccountRemark(params.identity, fallbackRemark);
};

/** 扫码落盘：必须先等 identity；失败不入池。同用户合并且不改 weight。 */
export const persistDouyinScanLogin = async (
  params: PersistDouyinScanLoginParams,
): Promise<PersistDouyinScanLoginResult> => {
  const { accounts, cookie, getAccountIdentity } = params;

  let identity: DouyinAccountIdentity;
  try {
    identity = await getAccountIdentity(cookie);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { didSave: false, accounts, failureReason: "identity_unavailable" };
  }

  const apiKey = resolveDouyinApiAccountKey(identity);
  if (apiKey === "") {
    return { didSave: false, accounts, failureReason: "identity_empty" };
  }

  const stableIdentity = resolveDouyinCookieStableIdentity(cookie);
  const byCookie =
    stableIdentity === ""
      ? -1
      : accounts.findIndex(
          (account) => resolveDouyinCookieStableIdentity(account.cookie) === stableIdentity,
        );

  if (byCookie >= 0) {
    const existing = accounts[byCookie];
    if (existing === undefined) {
      return { didSave: false, accounts, failureReason: "identity_unavailable" };
    }
    if (!identityMatchesBoundUid(existing.accountUid, identity)) {
      return { didSave: false, accounts, failureReason: "identity_mismatch" };
    }
    applyScanLoginToAccount({ account: existing, cookie, identity, apiKey });
    return { didSave: true, accounts };
  }

  const byApiKey = findDouyinAccountIndexByApiKey(accounts, apiKey);
  if (byApiKey >= 0) {
    const existing = accounts[byApiKey];
    if (existing === undefined) {
      return { didSave: false, accounts, failureReason: "identity_unavailable" };
    }
    applyScanLoginToAccount({ account: existing, cookie, identity, apiKey });
    return { didSave: true, accounts };
  }

  const created = createDouyinCookieAccount();
  applyScanLoginToAccount({ account: created, cookie, identity, apiKey });
  accounts.push(created);
  return { didSave: true, accounts };
};
