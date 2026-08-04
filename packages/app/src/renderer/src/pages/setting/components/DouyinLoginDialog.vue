<!-- 抖音扫码登录弹框 -->
<template>
  <n-modal v-model:show="showModal" :mask-closable="false" auto-focus>
    <n-card
      style="width: calc(100% - 60px); max-width: 450px"
      :bordered="false"
      size="huge"
      role="dialog"
      aria-modal="true"
      class="card"
    >
      <div style="text-align: center">
        <h2>{{ text || "抖音账号登录" }}</h2>
        <div class="qr-wrap">
          <template v-if="isManualVerification">
            <div
              v-if="frameBase64"
              class="screencast-container"
              tabindex="0"
              @mousedown="handleMouseDown"
              @mouseup="handleMouseUp"
              @mousemove="handleMouseMove"
              @keydown="handleKeyDown"
              @keyup="handleKeyUp"
            >
              <img
                :src="'data:image/jpeg;base64,' + frameBase64"
                class="screencast-image"
                draggable="false"
                alt="安全验证"
              />
            </div>
            <n-spin v-else size="large" />
          </template>
          <template v-else-if="isNeedAppVerify">
            <div class="sms-panel">
              <n-alert type="warning" class="sms-alert">
                <p>请输入短信验证码</p>
              </n-alert>
              <div class="sms-form">
                <n-input
                  ref="smsInputRef"
                  v-model:value="smsCode"
                  maxlength="8"
                  placeholder="短信验证码"
                  :disabled="smsSubmitting || smsSubmitted"
                  @keyup.enter="submitSmsCode"
                />
                <n-button type="primary" :loading="smsSubmitting" :disabled="!canSubmitSms || smsSubmitted" @click="submitSmsCode">
                  提交验证码
                </n-button>
              </div>
              <p v-if="smsHint" class="sms-hint">{{ smsHint }}</p>
            </div>
          </template>
          <template v-else-if="qrCodeData">
            <div class="qr-container" style="position: relative; display: inline-block;">
              <img v-if="isImage" :src="qrCodeData" class="qr-image" alt="抖音登录二维码" />
              <n-qr-code v-else :value="qrCodeData" color="#fe2c55" background-color="#F5F5F5" :size="250" />
              <div v-if="isScanned" class="timeout-mask">
                <span class="timeout-mask-text">登录中...</span>
              </div>
              <div v-else-if="isTimeout && !isScanned && !isNeedAppVerify" class="timeout-mask">
                <span>二维码已过期</span>
                <n-button size="small" type="primary" @click="handleRefreshQRCode">重新获取二维码</n-button>
              </div>
            </div>
          </template>
          <template v-else-if="diagnostic || errorMessage">
            <div class="error-panel">
              <n-alert type="error" :title="diagnostic ? diagnosticTitle : '获取二维码失败'">
                <p v-if="diagnostic">{{ diagnostic.message }}</p>
                <p v-else>{{ errorMessage }}</p>

                <div v-if="diagnostic?.nextActions && diagnostic.nextActions.length > 0" class="next-actions">
                  <div class="next-actions-title">建议操作：</div>
                  <ul class="next-actions-list">
                    <li v-for="action in diagnostic.nextActions" :key="action">{{ action }}</li>
                  </ul>
                </div>

                <div class="manual-cookie-tip">
                  您也可以前往 <strong>Cookie账号池/新增账号</strong> 进行手动导入。
                </div>
              </n-alert>

              <div class="official-action">
                <n-button type="primary" @click="handleRefreshQRCode">
                  重新获取二维码
                </n-button>
                <n-button type="primary" ghost @click="openDouyinOfficial">
                  打开抖音官网
                </n-button>
              </div>
            </div>
          </template>
          <n-spin v-else size="large" />
        </div>
        <p v-if="statusHint && !isManualVerification && !isNeedAppVerify" style="color: #666; font-size: 14px">{{ statusHint }}</p>
        <p v-if="qrCodeData && !isTimeout && !isManualVerification && !isScanned && !isNeedAppVerify" style="color: #999; font-size: 12px; margin-top: 8px;">
          二维码将在 {{ countdown }} 秒后过期
        </p>
      </div>
      <template #footer>
        <div class="footer">
          <n-button class="btn" @click="close">取消</n-button>
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useNotification } from "naive-ui";
import type { InputInst } from "naive-ui";
import { douyinApi } from "@renderer/apis";

import type { DouyinLoginDiagnostic, DouyinLoginPollResult } from "@renderer/apis/douyin";

const showModal = defineModel<boolean>({ required: true, default: false });
const emits = defineEmits<{
  close: [];
  success: [cookie: string];
}>();

const notice = useNotification();

const qrCodeData = ref("");
const id = ref("");
const text = ref("");
const isImage = ref(false);
const interval = ref<ReturnType<typeof setInterval> | null>(null);

const countdown = ref(40);
const countdownInterval = ref<ReturnType<typeof setInterval> | null>(null);
// Writable so poll expired can force overlay without clearing QR
const isTimeout = computed({
  get: () => countdown.value <= 0,
  set: (value: boolean) => {
    if (value) {
      countdown.value = 0;
    }
  },
});

const clearCountdown = () => {
  if (countdownInterval.value !== null) {
    clearInterval(countdownInterval.value);
    countdownInterval.value = null;
  }
};

const startCountdown = () => {
  countdown.value = 40;
  clearCountdown();
  countdownInterval.value = setInterval(() => {
    const nextCountdown = countdown.value - 1;
    countdown.value = Math.max(nextCountdown, 0);
    if (nextCountdown <= 0) {
      clearLoginInterval();
    }
  }, 1000);
};

const diagnostic = ref<DouyinLoginDiagnostic | null>(null);
const diagnosticTitleOverride = ref("");
const errorMessage = ref("");

const isManualVerification = ref(false);
const isNeedAppVerify = ref(false);
const isScanned = ref(false);
const statusHint = ref("");
const smsCode = ref("");
const smsHint = ref("");
const smsSubmitting = ref(false);
const smsSubmitted = ref(false);
const frameBase64 = ref("");
const eventSource = ref<EventSource | null>(null);
const isMouseDown = ref(false);
const browserTimeoutClearTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const browserTimeoutQRCodeRetryUsed = ref(false);
const smsInputRef = ref<InputInst | null>(null);

const focusSmsInput = () => {
  nextTick(() => {
    smsInputRef.value?.focus();
  });
};

const canSubmitSms = computed(() => {
  return /^\d{4,8}$/.test(smsCode.value.trim()) && !smsSubmitting.value && !smsSubmitted.value && Boolean(id.value);
});

const closeEventSource = () => {
  if (eventSource.value) {
    eventSource.value.close();
    eventSource.value = null;
  }
};

const clearBrowserTimeoutDiagnosticTimer = () => {
  if (browserTimeoutClearTimer.value === null) {
    return;
  }
  clearTimeout(browserTimeoutClearTimer.value);
  browserTimeoutClearTimer.value = null;
};

// WAVE/R6：仅 clear，无 2s 自动 handleRefreshQRCode
// const scheduleBrowserTimeoutDiagnosticClear = () => {
//   clearBrowserTimeoutDiagnosticTimer();
// };

const DIAGNOSTIC_TITLES: Readonly<Record<DouyinLoginDiagnostic["reason"], string>> = {
  sso_challenge: "抖音安全验证拦截",
  sso_blocked: "抖音安全策略拦截出码",
  risk_4031: "抖音安全风险拦截(4031)",
  illegal_app: "抖音登录入口不可用",
  cdp_unavailable: "浏览器代理不可用",
  engine_unavailable: "同会话浏览器引擎不可用",
  browser_timeout: "同会话浏览器出码超时",
  qr_unavailable: "二维码不可用",
  generic_failure: "抖音登录启动失败",
};

const diagnosticTitle = computed(() => {
  return diagnosticTitleOverride.value || (diagnostic.value ? DIAGNOSTIC_TITLES[diagnostic.value.reason] : "获取二维码失败");
});

const resolveLoginDiagnosticTitle = (error: DouyinLoginDiagnostic, fallbackTitle: string): string => {
  if (error.reason === "generic_failure" && fallbackTitle !== "获取二维码失败") {
    return fallbackTitle;
  }
  return DIAGNOSTIC_TITLES[error.reason];
};

const isImageQRCode = (value: string): boolean => {
  return value.startsWith("data:image/") || value.startsWith("blob:") || /^https?:\/\//.test(value);
};

const formatGenericLoginError = (error: unknown): string => {
  const fallbackMessage = "抖音官方登录页可能拦截了自动二维码获取，请稍后重试，或使用 Cookie账号池/新增账号 手动导入。";
  if (typeof error === "string") {
    return error === "failed to start douyin login" ? fallbackMessage : error;
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message === "failed to start douyin login" ? fallbackMessage : error.message;
  }
  return fallbackMessage;
};

const cancelLoginSession = () => {
  const sessionId = id.value;
  if (!sessionId) {
    return;
  }
  void douyinApi.loginCancel(sessionId).catch(() => undefined);
};

const clearLoginInterval = () => {
  if (interval.value !== null) {
    clearInterval(interval.value);
    interval.value = null;
  }
  clearCountdown();
  closeEventSource();
  frameBase64.value = "";
  isManualVerification.value = false;
};

const stopWithError = (message: string) => {
  clearLoginInterval();
  cancelLoginSession();
  isNeedAppVerify.value = false;
  isScanned.value = false;
  statusHint.value = "";
  smsSubmitted.value = false;
  notice.error({
    title: "登录失败",
    description: message,
  });
  text.value = message;
};

const handleLoginError = (error: unknown, fallbackTitle = "获取二维码失败") => {
  clearLoginInterval();
  cancelLoginSession();
  isNeedAppVerify.value = false;
  isScanned.value = false;
  statusHint.value = "";
  // WAVE/R2：browser_timeout 统一为「获取二维码失败」+ errorMessage，不展示同会话超时专属 diagnostic 页
  if (douyinApi.isDouyinLoginDiagnostic(error) && error.reason === "browser_timeout") {
    qrCodeData.value = "";
    diagnostic.value = null;
    diagnosticTitleOverride.value = "";
    clearBrowserTimeoutDiagnosticTimer();
    const msg = error.message || "获取二维码失败，请重试";
    errorMessage.value = msg;
    text.value = "获取二维码失败";
    notice.error({
      title: "获取二维码失败",
      description: msg,
      duration: 2000,
    });
    return;
  }
  if (douyinApi.isDouyinLoginDiagnostic(error)) {
    qrCodeData.value = "";
    diagnostic.value = error;
    const title = resolveLoginDiagnosticTitle(error, fallbackTitle);
    diagnosticTitleOverride.value = title;
    text.value = title;
    clearBrowserTimeoutDiagnosticTimer();
    notice.error({
      title,
      description: error.message,
      duration: fallbackTitle === "登录轮询失败" ? 2000 : undefined,
    });
  } else {
    qrCodeData.value = "";
    diagnosticTitleOverride.value = "";
    clearBrowserTimeoutDiagnosticTimer();
    const msg = formatGenericLoginError(error);
    errorMessage.value = msg;
    text.value = fallbackTitle === "获取二维码失败" ? "获取二维码失败，请重试" : "登录失败，请重试";
    notice.error({
      title: fallbackTitle,
      description: msg,
      duration: fallbackTitle === "登录轮询失败" ? 2000 : undefined,
    });
  }
};

const handlePollResult = (pollRes: DouyinLoginPollResult) => {
  if (pollRes.status === "waiting") {
    if (isNeedAppVerify.value || isScanned.value) {
      return;
    }
    isManualVerification.value = false;
    closeEventSource();
    frameBase64.value = "";
    statusHint.value = "使用抖音 App 扫码完成登录";
    if (pollRes.qrCode) {
      qrCodeData.value = pollRes.qrCode;
      isImage.value = isImageQRCode(pollRes.qrCode);
    }
    return;
  }

  if (pollRes.status === "scanned") {
    if (isNeedAppVerify.value) {
      return;
    }
    isManualVerification.value = false;
    isScanned.value = true;
    clearCountdown();
    closeEventSource();
    frameBase64.value = "";
    text.value = "已扫码，请在手机上确认";
    statusHint.value = "已扫码，请在手机上确认登录";
    if (pollRes.qrCode) {
      qrCodeData.value = pollRes.qrCode;
      isImage.value = isImageQRCode(pollRes.qrCode);
    }
    return;
  }

  if (pollRes.status === "need_app_verify") {
    isManualVerification.value = false;
    isNeedAppVerify.value = true;
    isScanned.value = false;
    clearCountdown();
    closeEventSource();
    frameBase64.value = "";
    if (!smsSubmitted.value) {
      text.value = "短信验证";
      smsHint.value = "";
    }
    focusSmsInput();
    if (pollRes.qrCode) {
      qrCodeData.value = pollRes.qrCode;
      isImage.value = isImageQRCode(pollRes.qrCode);
    }
    return;
  }

  if (pollRes.status === "manual_verification") {
    if (isNeedAppVerify.value || isScanned.value) {
      return;
    }
    isManualVerification.value = true;
    text.value = "抖音需要人工验证，请在下方窗口完成滑块验证";
    statusHint.value = "";
    if (!eventSource.value && id.value) {
      eventSource.value = douyinApi.openManualVerificationStream(id.value, {
        onFrame: (frame) => {
          frameBase64.value = frame.data;
        },
        onError: (err) => {
          console.error("SSE stream error:", err);
        },
      });
    }
    return;
  }

  if (pollRes.status === "completed") {
    closeEventSource();
    clearLoginInterval();
    isNeedAppVerify.value = false;
    isScanned.value = false;
    text.value = "登录成功";
    statusHint.value = "";
    notice.success({
      title: "登录成功",
      duration: 1500,
    });
    emits("success", douyinApi.formatDouyinCookieHeader(pollRes.cookies));
    showModal.value = false;
    return;
  }

  if (pollRes.status === "expired") {
    // Keep QR visible; stop polling/countdown; show retryable expired overlay
    clearLoginInterval();
    isTimeout.value = true;
    isScanned.value = false;
    isNeedAppVerify.value = false;
    statusHint.value = "";
    return;
  }

  stopWithError("登录会话未找到");
};

const submitSmsCode = async () => {
  if (!canSubmitSms.value || !id.value) {
    return;
  }
  smsSubmitting.value = true;
  smsHint.value = "";
  try {
    const result = await douyinApi.submitSms(id.value, smsCode.value.trim());
    if (result.status === "accepted") {
      if (result.validate.ok) {
        smsHint.value = "验证码已提交，请等待登录完成…";
        text.value = "验证码已提交，等待确认";
        smsSubmitted.value = true;
      } else {
        smsHint.value = "验证码校验失败，请重新输入短信验证码";
        smsSubmitted.value = false;
        text.value = "短信验证";
        focusSmsInput();
      }
      return;
    }
    if (result.status === "invalid_code") {
      smsHint.value = "验证码格式无效，请输入 4–8 位数字";
      return;
    }
    if (result.status === "not_applicable") {
      smsHint.value = "当前会话不需要短信验证，请继续等待扫码结果";
      return;
    }
    stopWithError("登录会话未找到");
  } catch (error) {
    handleLoginError(error, "提交短信验证码失败");
  } finally {
    smsSubmitting.value = false;
  }
};

const startLoginPolling = () => {
  interval.value = setInterval(async () => {
    const currentId = id.value;
    if (!currentId) {
      return;
    }
    try {
      const result = await douyinApi.loginPoll(currentId);
      if (!showModal.value || interval.value === null || id.value !== currentId) {
        return;
      }
      handlePollResult(result);
    } catch (error) {
      if (!showModal.value || interval.value === null || id.value !== currentId) {
        return;
      }
      handleLoginError(error, "登录轮询失败");
    }
  }, 2000);
};

const handleRefreshQRCode = async () => {
  clearBrowserTimeoutDiagnosticTimer();
  browserTimeoutQRCodeRetryUsed.value = false;
  clearCountdown();
  clearLoginInterval();
  diagnostic.value = null;
  diagnosticTitleOverride.value = "";
  errorMessage.value = "";
  isNeedAppVerify.value = false;
  isScanned.value = false;
  isManualVerification.value = false;
  smsCode.value = "";
  smsHint.value = "";
  smsSubmitted.value = false;
  const oldId = id.value;
  id.value = "";
  qrCodeData.value = "";
  if (oldId) {
    try {
      await douyinApi.loginCancel(oldId);
    } catch {
      // ignore
    }
  }
  // r9c：重新获取 = 先 cancel 旧会话再冷却，强制服务端新浏览器
  await new Promise<void>((r) => setTimeout(r, 2_500));
  try {
    text.value = "获取二维码中...";
    const res = await douyinApi.qrcode();
    id.value = res.id;
    if (res.status === "manual_verification") {
      handlePollResult(res);
      startLoginPolling();
      return;
    }
    qrCodeData.value = res.qrCode;
    isImage.value = isImageQRCode(res.qrCode);
    text.value = "请使用抖音 App 扫码";
    statusHint.value = "使用抖音 App 扫码完成登录";
    startCountdown();
    startLoginPolling();
  } catch (error) {
    handleLoginError(error, "获取二维码失败");
  }
};

const onOpen = async () => {
  text.value = "获取二维码中...";
  qrCodeData.value = "";
  id.value = "";
  isImage.value = false;
  diagnostic.value = null;
  diagnosticTitleOverride.value = "";
  errorMessage.value = "";
  browserTimeoutQRCodeRetryUsed.value = false;
  isManualVerification.value = false;
  isNeedAppVerify.value = false;
  isScanned.value = false;
  statusHint.value = "";
  smsCode.value = "";
  smsHint.value = "";
  smsSubmitting.value = false;
  frameBase64.value = "";
  closeEventSource();

  try {
    const res = await douyinApi.qrcode();
    id.value = res.id;
    if (res.status === "manual_verification") {
      handlePollResult(res);
      startLoginPolling();
      return;
    }

    qrCodeData.value = res.qrCode;
    isImage.value = isImageQRCode(res.qrCode);
    text.value = "请使用抖音 App 扫码";
    statusHint.value = "使用抖音 App 扫码完成登录";
    startCountdown();
    startLoginPolling();
  } catch (error) {
    handleLoginError(error, "获取二维码失败");
  }
};

const getCoordinates = (event: MouseEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const clientX = event.clientX - rect.left;
  const clientY = event.clientY - rect.top;
  
  const img = (event.currentTarget as HTMLElement).querySelector("img");
  if (img && img.naturalWidth && img.naturalHeight) {
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    return {
      x: Math.round(clientX * scaleX),
      y: Math.round(clientY * scaleY),
    };
  }
  
  return {
    x: Math.round(clientX),
    y: Math.round(clientY),
  };
};

const handleMouseDown = async (event: MouseEvent) => {
  isMouseDown.value = true;
  const coords = getCoordinates(event);
  await forwardMouseEvent("down", coords.x, coords.y, event.button);
};

const handleMouseUp = async (event: MouseEvent) => {
  isMouseDown.value = false;
  const coords = getCoordinates(event);
  await forwardMouseEvent("up", coords.x, coords.y, event.button);
};

let lastMoveTime = 0;
const handleMouseMove = async (event: MouseEvent) => {
  if (!isMouseDown.value) return;
  const now = Date.now();
  if (now - lastMoveTime < 50) return;
  lastMoveTime = now;
  
  const coords = getCoordinates(event);
  await forwardMouseEvent("move", coords.x, coords.y, event.button);
};

const forwardMouseEvent = async (type: "down" | "up" | "move", x: number, y: number, buttonCode: number) => {
  if (!id.value) return;
  
  let button: "left" | "middle" | "right" = "left";
  if (buttonCode === 1) button = "middle";
  if (buttonCode === 2) button = "right";

  const ev = {
    kind: "mouse",
    type,
    x,
    y,
    button,
  };
  
  try {
    await douyinApi.sendManualVerificationInput(id.value, ev);
  } catch (err) {
    console.error("Failed to send mouse input", err);
  }
};

const handleKeyDown = async (event: KeyboardEvent) => {
  event.preventDefault();
  await forwardKeyEvent("down", event);
};

const handleKeyUp = async (event: KeyboardEvent) => {
  event.preventDefault();
  await forwardKeyEvent("up", event);
};

const forwardKeyEvent = async (type: "down" | "up", event: KeyboardEvent) => {
  if (!id.value) return;
  
  const keyEvent = {
    kind: "key",
    type,
    key: event.key,
    code: event.code,
    text: event.key.length === 1 ? event.key : "",
  };
  
  try {
    await douyinApi.sendManualVerificationInput(id.value, keyEvent);
  } catch (err) {
    console.error("Failed to send key input", err);
  }
};

const openDouyinOfficial = () => {
  window.open("https://www.douyin.com/", "_blank", "noopener,noreferrer");
};

const close = () => {
  showModal.value = false;
};

watch(
  () => showModal.value,
  (val) => {
    if (val) {
      onOpen();
      return;
    }

    clearLoginInterval();
    clearBrowserTimeoutDiagnosticTimer();
    if (id.value) {
      douyinApi.loginCancel(id.value).catch(() => {
        text.value = "登录会话已取消";
      });
    }
    isNeedAppVerify.value = false;
    isScanned.value = false;
    statusHint.value = "";
    smsCode.value = "";
    smsHint.value = "";
    smsSubmitted.value = false;
    emits("close");
  },
);
</script>

<style scoped lang="less">
.qr-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 250px;
  margin: 20px 0;
}

.qr-image {
  width: 250px;
  height: 250px;
  object-fit: contain;
}

.timeout-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.9);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
  z-index: 10;
}

.timeout-mask-text {
  color: #666;
  font-size: 14px;
}

.screencast-container {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 360px;
  height: 250px;
  overflow: hidden;
  border: 1px solid #eee;
  outline: none;
  cursor: crosshair;
  background-color: #f9f9f9;
}

.screencast-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
}

.sms-panel {
  width: 100%;
  padding: 0 16px;
  text-align: left;
}

.sms-alert {
  :deep(.n-alert-body) {
    display: flex;
    align-items: center;
  }
}

.sms-form {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  align-items: center;
}

.sms-hint {
  margin-top: 10px;
  color: #666;
  font-size: 13px;
}

.error-panel {
  width: 100%;
  padding: 0 16px;
  text-align: left;
}

.next-actions {
  margin-top: 8px;
}

.next-actions-title {
  margin-bottom: 4px;
  font-weight: bold;
}

.next-actions-list {
  margin: 0;
  padding-left: 20px;
}

.manual-cookie-tip {
  margin-top: 12px;
  color: #666;
  font-size: 13px;
}

.official-action {
  margin-top: 16px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}

.footer {
  text-align: right;
  .btn {
    width: 100px;
  }
}
</style>
