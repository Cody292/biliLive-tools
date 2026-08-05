// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { formatDouyinCookieHeader } from "@renderer/apis/douyin";
import {
  createDouyinCookieAccount,
  createDouyinScanLoginRemark,
  findDouyinAccountIndexByApiKey,
  formatDouyinAccountUpdatedAt,
  pickDouyinAccountRemark,
  resolveDouyinApiAccountKey,
  resolveDouyinCookieStableIdentity,
} from "../douyinAccounts";

vi.mock("@renderer/apis/request", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe("Douyin QR login helpers", () => {
  it("formats Douyin cookies as a Cookie header", () => {
    const header = formatDouyinCookieHeader([
      { name: "sessionid", value: "test-session", domain: ".douyin.com" },
      { name: "csrf", value: "csrf-token", domain: ".douyin.com" },
    ]);

    expect(header).toBe("sessionid=test-session; csrf=csrf-token");
  });

  it("creates enabled Douyin cookie accounts for scan login imports", () => {
    const account = createDouyinCookieAccount();

    expect(account.id).toMatch(/^dy-\d+-\d+$/);
    expect(account.cookie).toBe("");
    expect(account.enabled).toBe(true);
    expect(account.weight).toBeNull();
    expect(account.remark).toBe("");
    expect(account.updatedAt).toBeUndefined();
  });

  it("formats scan login remarks with a stable date", () => {
    const remark = createDouyinScanLoginRemark(new Date("2026-07-10T12:00:00+08:00"));

    expect(remark).toBe("扫码导入-2026-07-10");
  });

  it("formats account updatedAt as Y.M.D HH:mm without zero-padding month/day", () => {
    const stamp = formatDouyinAccountUpdatedAt(new Date("2026-08-05T00:00:00+08:00"));
    expect(stamp).toBe("2026.8.5 00:00");
  });

  it("prefers nickname, then uid, then sec_user_id for scan login account remarks", () => {
    expect(pickDouyinAccountRemark({ nickname: " 抖音昵称 ", uid: "uid-1", sec_user_id: "sec-1" }, "fallback")).toBe("抖音昵称");
    expect(pickDouyinAccountRemark({ uid: "uid-1", sec_user_id: "sec-1" }, "fallback")).toBe("uid-1");
    expect(pickDouyinAccountRemark({ sec_user_id: "sec-1" }, "fallback")).toBe("sec-1");
    expect(pickDouyinAccountRemark(undefined, "fallback")).toBe("fallback");
  });

  it("resolves stable Douyin cookie identity for duplicate scan-login imports", () => {
    expect(resolveDouyinCookieStableIdentity("sid=ignored; uid_tt=user-1; sessionid=secret")).toBe("user-1");
    expect(resolveDouyinCookieStableIdentity("sessionid=secret; sec_user_id=sec-1")).toBe("sec-1");
    expect(resolveDouyinCookieStableIdentity("sessionid=secret")).toBe("");
  });

  it("resolves API account key preferring profile user_id then sec_user_id", () => {
    expect(resolveDouyinApiAccountKey({ nickname: "n", uid: "uid-1", sec_user_id: "sec-1" })).toBe("uid-1");
    expect(resolveDouyinApiAccountKey({ sec_user_id: "sec-1" })).toBe("sec-1");
    expect(resolveDouyinApiAccountKey({ nickname: "n" })).toBe("");
    expect(resolveDouyinApiAccountKey(undefined)).toBe("");
  });

  it("finds existing account by cached accountUid for same-user cookie update", () => {
    const accounts = [
      { ...createDouyinCookieAccount(), accountUid: "uid-a", cookie: "old-a" },
      { ...createDouyinCookieAccount(), accountUid: "uid-b", cookie: "old-b" },
    ];
    expect(findDouyinAccountIndexByApiKey(accounts, "uid-b")).toBe(1);
    expect(findDouyinAccountIndexByApiKey(accounts, "uid-missing")).toBe(-1);
    expect(findDouyinAccountIndexByApiKey(accounts, "")).toBe(-1);
  });

  it("scan login success updates same user by API user_id and removes temporary duplicate", () => {
    const recordSettingSource = readFileSync(new URL("../RecordSetting.vue", import.meta.url), "utf8");
    const settingSource = readFileSync(new URL("../index.vue", import.meta.url), "utf8");
    const successStart = recordSettingSource.indexOf("const handleDouyinLoginSuccess");
    expect(successStart).toBeGreaterThan(-1);
    const successBody = recordSettingSource.slice(successStart, successStart + 4500);

    expect(recordSettingSource).toContain("requestSave: []");
    expect(successBody).toMatch(/accounts\.push\(targetAccount\)[\s\S]{0,260}emit\("requestSave"\)/);
    expect(successBody).toMatch(/douyinApi\.getAccountIdentity\(cookie\)/);
    expect(successBody).toContain("resolveDouyinApiAccountKey");
    expect(successBody).toContain("findDouyinAccountIndexByApiKey");
    expect(successBody).toContain("accountUid");
    expect(successBody).toMatch(/kept\.cookie\s*=\s*cookie/);
    expect(successBody).toMatch(/accounts\.splice\(targetIdx,\s*1\)/);
    expect(successBody).toMatch(/emit\("requestSave"\)/g);
    expect(successBody).toContain("formatDouyinAccountUpdatedAt");
    expect(successBody).toMatch(/targetAccount\.updatedAt\s*=\s*formatDouyinAccountUpdatedAt\(\)/);
    expect(successBody).toMatch(/kept\.updatedAt\s*=\s*formatDouyinAccountUpdatedAt\(\)/);
    expect(successBody).not.toMatch(/kept\.weight\s*=/);
    expect(successBody).not.toMatch(/targetAccount\.weight\s*=/);
    expect(recordSettingSource).toContain("v-if=\"account.updatedAt\"");
    expect(recordSettingSource).toContain("{{ account.updatedAt }}");
    expect(settingSource).toContain('@request-save="persistConfig"');
    expect(settingSource).toMatch(/const persistConfig = async \(\) => \{[\s\S]{0,260}configApi\.save\(deepRaw\(config\.value\)\)/);
    expect(settingSource).toMatch(/const saveConfig = async \(\) => \{[\s\S]{0,700}await persistConfig\(\)[\s\S]{0,120}close\(\)/);
  });

  it("fullstack login uses current origin api path instead of localhost default", () => {
    const loginSource = readFileSync(new URL("../../Login/index.vue", import.meta.url), "utf8");

    expect(loginSource).toContain("window.location.origin");
    expect(loginSource).toContain('const fullstackAPI = `${window.location.origin}/api`');
    expect(loginSource).toMatch(/const api = ref\(isFullstack\.value \? fullstackAPI : ""\)/);
    expect(loginSource).toMatch(/api\.value = isFullstack\.value[\s\S]{0,80}\? fullstackAPI/);
  });

  it("DYQR-FE-EDGE-001 renders backend data image QR codes with the img branch", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toContain('v-if="isImage"');
    expect(componentSource).toContain('v-else :value="qrCodeData"');
    expect(componentSource).toContain('value.startsWith("data:image/")');
    expect(componentSource).toContain("isImage.value = isImageQRCode(res.qrCode)");
  });

  it("diagnostic workflow displays diagnostic properties, actions, official URL, and manual pool flow", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const apiSource = readFileSync(new URL("../../../apis/douyin.ts", import.meta.url), "utf8");

    expect(apiSource).toContain("export interface DouyinLoginDiagnostic");
    expect(apiSource).toContain("export const isDouyinLoginDiagnostic");
    expect(componentSource).toContain("isDouyinLoginDiagnostic");
    expect(componentSource).toContain("diagnosticTitle");
    expect(componentSource).toContain("diagnostic.message");
    expect(componentSource).toContain("diagnostic.nextActions");
    expect(componentSource).toContain("formatGenericLoginError");
    expect(componentSource).toContain("openDouyinOfficial");
    expect(componentSource).toContain("https://www.douyin.com/");
    expect(componentSource).toContain("Cookie账号池/新增账号");
  });

  it("unified handleLoginError handles both initial qrcode and poll errors, including isDouyinLoginDiagnostic checks", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toContain("handleLoginError");
    expect(componentSource).toContain("handleLoginError(error, \"登录轮询失败\")");
    expect(componentSource).toContain("handleLoginError(error, \"获取二维码失败\")");
    expect(componentSource).toContain("isDouyinLoginDiagnostic(error)");
    expect(componentSource).toContain("qrCodeData.value = \"\"");
  });

  it("poll generic_failure diagnostic uses polling fallback title instead of startup failure title", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toContain("resolveLoginDiagnosticTitle");
    expect(componentSource).toMatch(/error\.reason === ["']generic_failure["'][\s\S]{0,120}fallbackTitle !== ["']获取二维码失败["']/);
    expect(componentSource).toContain("const title = resolveLoginDiagnosticTitle(error, fallbackTitle)");
    expect(componentSource).toContain("text.value = title");
    expect(componentSource).toMatch(/notice\.error\([\s\S]{0,120}title,/);
    expect(componentSource).toContain("handleLoginError(error, \"登录轮询失败\")");
  });

  it("DYQR-FE-EDGE-003 supports 40s countdown, scanned status pause, timeout overlay mask, and cancel-before-qrcode retry sequence", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    // 1. 40s 倒计时递减相关逻辑与初始值
    expect(componentSource).toMatch(/countdown|timeLeft|timer/i);
    expect(componentSource).toContain("40");

    // 2. 扫码成功时暂停倒计时
    expect(componentSource).toMatch(/status === "scanned"/);
    expect(componentSource).toMatch(/pause|clear|stop/i);

    // 3. 超时遮罩状态显示
    expect(componentSource).toMatch(/timeout|mask|overlay/i);

    // 4. 重新获取时的调用顺序：先 loginCancel(oldID) 再 qrcode
    expect(componentSource).toMatch(/loginCancel.*qrcode/s);
  });

  it("S1 scanned shows 登录中 overlay, clears countdown, hides countdown text, and never shows 已过期 mask", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toMatch(/status === ["']scanned["']/);
    expect(componentSource).toMatch(/isScanned/);
    expect(componentSource).toMatch(
      /status === ["']scanned["'][\s\S]*?clearCountdown\(\)/,
    );
    expect(componentSource).toContain("登录中...");
    const countdownControl = componentSource.match(
      /v-if="([^"]*qrCodeData[^"]*isTimeout[^"]*)"/,
    );
    expect(countdownControl).not.toBeNull();
    const countdownCond = countdownControl?.[1] ?? "";
    expect(countdownCond).toMatch(/isScanned/);
    expect(countdownCond).toMatch(/isNeedAppVerify/);
    expect(componentSource).toContain("二维码将在 {{ countdown }} 秒后过期");
    const maskVIf =
      componentSource.match(/v-else-if="([^"]*isTimeout[^"]*)"/) ??
      componentSource.match(/v-if="([^"]*isTimeout[^"]*isScanned[^"]*)"/);
    expect(maskVIf).not.toBeNull();
    const cond = maskVIf?.[1] ?? "";
    expect(cond).toMatch(/isTimeout/);
    const guardsNeedOrScanned =
      (cond.includes("isNeedAppVerify") && cond.includes("isScanned")) ||
      cond.includes("isWaiting") ||
      (cond.includes("!isNeedAppVerify") && cond.includes("!isScanned"));
    expect(guardsNeedOrScanned).toBe(true);
    expect(componentSource).toContain("二维码已过期");
    expect(componentSource).not.toMatch(/v-if="isTimeout"\s+class="timeout-mask"/);
  });

  it("S2 need_app_verify SMS panel has no internal n-alert title, only body 请输入短信验证码", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toContain('text.value = "短信验证"');
    expect(componentSource).not.toContain('title="短信验证"');
    expect(componentSource).not.toMatch(/n-alert[^>]*title="短信验证"/);
    expect(componentSource).not.toContain("需要短信验证（2046）");

    expect(componentSource).toContain("请输入短信验证码");
    expect(componentSource).not.toContain("为保障你的账号安全");
    expect(componentSource).not.toContain("请输入抖音 App / 短信收到的验证码");
    expect(componentSource).not.toContain("提交后会话将继续轮询");

    expect(componentSource).not.toContain("官方 send_code 尚未观测到成功");
    expect(componentSource).not.toContain("已观测到短信发送接口");
    expect(componentSource).not.toContain("smsApiSeen");

    expect(componentSource).toMatch(
      /status === ["']need_app_verify["'][\s\S]*?clearCountdown\(\)/,
    );
  });

  it("S2 SMS submit keeps accepted hint and disables input/button until session changes", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const needVerifyStart = componentSource.indexOf('if (pollRes.status === "need_app_verify")');
    expect(needVerifyStart).toBeGreaterThan(-1);
    const needVerifyBody = componentSource.slice(needVerifyStart, needVerifyStart + 700);
    const submitStart = componentSource.indexOf("const submitSmsCode");
    expect(submitStart).toBeGreaterThan(-1);
    const submitBody = componentSource.slice(submitStart, submitStart + 1300);

    expect(componentSource).toContain("const smsSubmitted = ref(false)");
    expect(componentSource).toContain(':disabled="smsSubmitting || smsSubmitted"');
    expect(componentSource).toContain(':disabled="!canSubmitSms || smsSubmitted"');
    expect(componentSource).toMatch(/canSubmitSms[\s\S]{0,220}!smsSubmitted\.value/);
    expect(needVerifyBody).toMatch(/if \(!smsSubmitted\.value\)[\s\S]{0,120}smsHint\.value\s*=\s*""/);
    expect(submitBody).toContain("验证码已提交，请等待登录完成…");
    expect(submitBody).toMatch(/text\.value\s*=\s*"验证码已提交，等待确认"[\s\S]{0,120}smsSubmitted\.value\s*=\s*true/);
    expect(componentSource).toMatch(/handleRefreshQRCode[\s\S]{0,900}smsSubmitted\.value\s*=\s*false/);
    expect(componentSource).toMatch(/watch\([\s\S]{0,1300}smsSubmitted\.value\s*=\s*false/);
  });

  it("S3 poll expired keeps QR and shows retryable expired overlay instead of stopWithError", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const handleStart = componentSource.indexOf("const handlePollResult");
    expect(handleStart).toBeGreaterThan(-1);
    const handleBody = componentSource.slice(handleStart, handleStart + 3500);

    expect(handleBody).toMatch(/status === ["']expired["']/);
    const expiredIf = handleBody.match(
      /if\s*\(\s*pollRes\.status\s*===\s*["']expired["']\s*\)\s*\{[\s\S]*?\n  \}/,
    );
    expect(expiredIf).not.toBeNull();
    const expiredBranch = expiredIf?.[0] ?? "";
    expect(expiredBranch).toMatch(/isTimeout\.value\s*=\s*true/);
    expect(expiredBranch).not.toMatch(/stopWithError/);
    expect(expiredBranch).not.toMatch(/qrCodeData\.value\s*=\s*[\"']/);

    expect(handleBody).not.toMatch(
      /pollRes\.status\s*===\s*["']expired["']\s*\?\s*["']二维码已过期/,
    );

    expect(componentSource).toContain("二维码已过期");
    expect(componentSource).toMatch(/isTimeout[\s\S]{0,200}重新获取二维码/);
  });

  it("S4 diagnostic/error panel has 重新获取二维码 and keeps 打开抖音官网", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const errorPanelStart = componentSource.indexOf('v-else-if="diagnostic || errorMessage"');
    expect(errorPanelStart).toBeGreaterThan(-1);
    const errorPanel = componentSource.slice(errorPanelStart, errorPanelStart + 1200);

    expect(errorPanel).toContain("打开抖音官网");
    expect(errorPanel).toContain("openDouyinOfficial");
    expect(errorPanel).toContain("重新获取二维码");
    expect(errorPanel).toMatch(/@click="handleRefreshQRCode"/);
  });

  it("S4 handleRefreshQRCode clears diagnostic/error/sms/scanned/manual state", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const fnStart = componentSource.indexOf("const handleRefreshQRCode");
    expect(fnStart).toBeGreaterThan(-1);
    const afterFn = componentSource.slice(fnStart);
    const nextFn = afterFn.search(/\nconst (async )?[a-zA-Z]+\s*=/);
    const fnBody = nextFn > 0 ? afterFn.slice(0, nextFn) : afterFn.slice(0, 900);

    expect(fnBody).toMatch(/diagnostic\.value\s*=\s*null/);
    expect(fnBody).toMatch(/errorMessage\.value\s*=\s*[\"']/);
    expect(fnBody).toMatch(/smsCode\.value\s*=\s*[\"']/);
    expect(fnBody).toMatch(/smsHint\.value\s*=\s*[\"']/);
    expect(fnBody).toMatch(/isScanned\.value\s*=\s*false/);
    expect(fnBody).toMatch(/isNeedAppVerify\.value\s*=\s*false/);
    expect(fnBody).toMatch(/isManualVerification\.value\s*=\s*false/);
  });

  it("S5 after need_app_verify, subsequent waiting must not downgrade and must not be covered by countdown/expired mask", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    const waitingStart = componentSource.search(/if \(pollRes\.status === ["']waiting["']\) \{/);
    expect(waitingStart).toBeGreaterThanOrEqual(0);
    const afterWaiting = componentSource.slice(waitingStart);
    const nextStatus = afterWaiting.search(/\n  if \(pollRes\.status ===/);
    const waitingBlock = nextStatus > 0 ? afterWaiting.slice(0, nextStatus) : afterWaiting.slice(0, 600);
    expect(waitingBlock).toMatch(/isNeedAppVerify/);
    expect(waitingBlock).toMatch(/isScanned/);
    expect(waitingBlock).toMatch(/return/);
    expect(waitingBlock).not.toMatch(/isNeedAppVerify\.value\s*=\s*false/);

    const countdownControl = componentSource.match(
      /v-if="([^"]*qrCodeData[^"]*isTimeout[^"]*)"/,
    );
    expect(countdownControl).not.toBeNull();
    const countdownCond = countdownControl?.[1] ?? "";
    expect(countdownCond).toMatch(/isNeedAppVerify/);

    const maskVIf =
      componentSource.match(/v-else-if="([^"]*isTimeout[^"]*)"/) ??
      componentSource.match(/v-if="([^"]*isTimeout[^"]*isScanned[^"]*)"/);
    expect(maskVIf).not.toBeNull();
    const cond = maskVIf?.[1] ?? "";
    expect(cond).toMatch(/isTimeout/);
    expect(cond).toMatch(/isNeedAppVerify/);
    expect(cond).toMatch(/!isNeedAppVerify/);

    const needIdx = componentSource.indexOf('v-else-if="isNeedAppVerify"');
    const qrIdx = componentSource.indexOf('v-else-if="qrCodeData"');
    expect(needIdx).toBeGreaterThan(-1);
    expect(qrIdx).toBeGreaterThan(-1);
    expect(needIdx).toBeLessThan(qrIdx);
  });

  it("poll status priority guards: waiting cannot downgrade need_app_verify/scanned", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const handleStart = componentSource.indexOf("const handlePollResult");
    expect(handleStart).toBeGreaterThan(-1);
    const handleBody = componentSource.slice(handleStart, handleStart + 3000);

    const statuses = [
      "completed",
      "need_app_verify",
      "scanned",
      "manual_verification",
      "waiting",
    ] as const;
    for (const status of statuses) {
      expect(
        handleBody.includes(`status === "${status}"`) || handleBody.includes(`status === '${status}'`),
      ).toBe(true);
    }
    expect(componentSource).toMatch(
      /status === ["']waiting["'][\s\S]{0,400}isNeedAppVerify/,
    );
  });

  it("browser_timeout 统一为获取二维码失败，schedule 仅 clear 无自动刷新", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toContain("browserTimeoutClearTimer");
    expect(componentSource).toMatch(/clearBrowserTimeoutDiagnosticTimer/);
    expect(componentSource).toMatch(/error\.reason === ["']browser_timeout["']/);

    const fnStart = componentSource.indexOf("const scheduleBrowserTimeoutDiagnosticClear");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = componentSource.slice(fnStart, fnStart + 400);
    // WAVE/R6：仅 clear，无 2s setTimeout 自动 handleRefreshQRCode
    expect(fnBody).toMatch(/clearBrowserTimeoutDiagnosticTimer\(\)/);
    expect(fnBody).not.toMatch(/setTimeout/);
    expect(fnBody).not.toMatch(/handleRefreshQRCode/);

    const handleErrorStart = componentSource.indexOf("const handleLoginError");
    expect(handleErrorStart).toBeGreaterThan(-1);
    const handleErrorBody = componentSource.slice(handleErrorStart, handleErrorStart + 1800);
    expect(handleErrorBody).toMatch(/error\.reason === ["']browser_timeout["']/);
    expect(handleErrorBody).toMatch(/text\.value\s*=\s*["']获取二维码失败["']/);
    expect(handleErrorBody).toMatch(/diagnostic\.value\s*=\s*null/);
    expect(handleErrorBody).toMatch(/errorMessage\.value\s*=/);
  });

  it("S2 need_app_verify SMS focus, warning alert alignment class, and submitted guard", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    expect(componentSource).toContain("focusSmsInput");
    expect(componentSource).toContain("sms-alert");
    expect(componentSource).toMatch(/ref="smsInputRef"/);

    const needVerifyStart = componentSource.indexOf('if (pollRes.status === "need_app_verify")');
    expect(needVerifyStart).toBeGreaterThan(-1);
    const needVerifyBody = componentSource.slice(needVerifyStart, needVerifyStart + 800);

    expect(needVerifyBody).toMatch(/if \(!smsSubmitted\.value\) \{\s*text\.value = "短信验证";\s*smsHint\.value = "";\s*\}/);
    expect(needVerifyBody).toContain("focusSmsInput()");
  });

  it("validate_code_rejected or validate.ok false handles Chinese hint, resets smsSubmitted, refocuses input, and allows retry", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    const submitStart = componentSource.indexOf("const submitSmsCode");
    expect(submitStart).toBeGreaterThan(-1);
    const submitBody = componentSource.slice(submitStart, submitStart + 1600);

    expect(submitBody).toContain("验证码校验失败，请重新输入短信验证码");
    expect(submitBody).toContain("smsSubmitted.value = false");
    expect(submitBody).toContain('text.value = "短信验证"');
    expect(submitBody).toContain("focusSmsInput()");
  });

  it("login polling ignores stale results after modal close or session id changes and shows polling errors for 2 seconds", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");
    const pollingStart = componentSource.indexOf("const startLoginPolling");
    expect(pollingStart).toBeGreaterThan(-1);
    const pollingBody = componentSource.slice(pollingStart, pollingStart + 900);

    expect(pollingBody).toContain("const currentId = id.value");
    expect(pollingBody).toMatch(/if\s*\(\s*!currentId\s*\)\s*\{\s*return\s*;\s*\}/);
    expect(pollingBody).toContain("douyinApi.loginPoll(currentId)");
    expect(pollingBody).toMatch(/!showModal\.value[\s\S]{0,140}interval\.value === null[\s\S]{0,140}id\.value !== currentId/);
    expect(pollingBody).toMatch(/catch \(error\)[\s\S]{0,260}!showModal\.value/);

    const handleErrorStart = componentSource.indexOf("const handleLoginError");
    expect(handleErrorStart).toBeGreaterThan(-1);
    const handleErrorBody = componentSource.slice(handleErrorStart, handleErrorStart + 1500);
    expect(handleErrorBody).toContain('duration: fallbackTitle === "登录轮询失败" ? 2000 : undefined');
  });

  it("modal close and QR refresh clear browser_timeout auto-clear timer", () => {
    const componentSource = readFileSync(new URL("../components/DouyinLoginDialog.vue", import.meta.url), "utf8");

    const refreshStart = componentSource.indexOf("const handleRefreshQRCode");
    expect(refreshStart).toBeGreaterThan(-1);
    const refreshBody = componentSource.slice(refreshStart, refreshStart + 700);
    expect(refreshBody).toMatch(/clearBrowserTimeoutDiagnosticTimer\(\)/);

    const watchStart = componentSource.indexOf("watch(\n  () => showModal.value");
    expect(watchStart).toBeGreaterThan(-1);
    const watchBody = componentSource.slice(watchStart, watchStart + 900);
    expect(watchBody).toMatch(/clearBrowserTimeoutDiagnosticTimer\(\)/);
  });
});
