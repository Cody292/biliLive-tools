<template>
  <div>
    <n-tabs type="segment">
      <n-tab-pane name="bilibili" tab="B站">
        <div class="user-info">
          <div class="login-btns">
            <n-button type="primary" @click="login">登录账号</n-button>
            <n-button @click="exportAllAccounts">导出用户</n-button>
            <n-button @click="triggerImportAll">导入用户</n-button>
            <input
              ref="allImportInput"
              type="file"
              accept="application/json"
              style="display: none"
              @change="onImportAllFileChange"
            />
          </div>
        </div>
        <div class="container">
          <div
            v-for="item in userList"
            :key="item.uid"
            class="card"
            :class="{
              active: item.uid === userInfo.uid,
            }"
          >
            <div v-if="item.expiresText" class="expires">{{ item.expiresText }}</div>

            <span class="username">{{ item.name }}</span>
            <img :src="item.face" alt="" referrerpolicy="no-referrer" class="face" />
            <n-popover placement="right-start" trigger="hover">
              <template #trigger>
                <n-icon size="25" class="pointer menu">
                  <EllipsisHorizontalOutline />
                </n-icon>
              </template>
              <div style="padding: 5px 10px">uid: {{ item.uid }}</div>
              <div
                v-if="item.uid !== userInfo.uid"
                class="section"
                @click="changeAccount(item.uid)"
              >
                使用
              </div>
              <div class="section" @click="updateAccountInfo(item.uid)">刷新信息</div>
              <div class="section" @click="updateAuth(item.uid)">更新授权</div>
              <div class="section" @click="getCookie(item.uid)">复制cookie</div>
              <div class="section" @click="exportCurrentAccount(item.uid)">导出</div>
              <div class="section section-danger" @click="logout(item.uid)">退出账号</div>
            </n-popover>
          </div>
        </div>
        <BiliLoginDialog v-model="loginTvDialogVisible" @confirm="loginConfirm"></BiliLoginDialog>
      </n-tab-pane>
      <n-tab-pane name="douyu" tab="斗鱼">
        <div class="user-info">
          <div class="login-btns">
            <n-button type="primary" @click="douyuLogin">登录账号</n-button>
            <n-button @click="exportDouyuAccounts">导出用户</n-button>
            <n-button @click="triggerDouyuImport">导入用户</n-button>
            <input
              ref="douyuImportInput"
              type="file"
              accept="application/json"
              style="display: none"
              @change="onDouyuImportFileChange"
            />
          </div>
        </div>
        <div class="container">
          <div v-for="item in douyuUserList" :key="item.uid" class="card douyu-card">
            <div class="expires" :class="{ expired: douyuRemainingDays(item.createdAt) === 0 }">
              {{ douyuExpiryText(item.createdAt) }}
            </div>
            <span class="username">{{ item.name }}</span>
            <img
              v-if="item.avatar"
              :src="item.avatar"
              alt=""
              referrerpolicy="no-referrer"
              class="face"
            />
            <div v-else class="face-placeholder">{{ item.uid }}</div>
            <n-popover placement="right-start" trigger="hover">
              <template #trigger>
                <n-icon size="25" class="pointer menu"><EllipsisHorizontalOutline /></n-icon>
              </template>
              <div style="padding: 5px 10px">uid: {{ item.uid }}</div>
              <div class="section" @click="douyuValidate(item.uid)">校验有效性</div>
              <div class="section" @click="douyuUpdateAuth(item.uid)">更新授权</div>
              <div class="section" @click="exportDouyuAccount(item.uid)">导出</div>
              <div class="section section-danger" @click="douyuLogout(item.uid)">退出账号</div>
            </n-popover>
          </div>
        </div>
        <DouyuLoginDialog v-model="douyuLoginVisible" @confirm="douyuLoginConfirm" />
      </n-tab-pane>
      <n-tab-pane name="douyin" tab="抖音">
        <div class="user-info">
          <div class="login-btns">
            <n-button type="primary" @click="douyinScanLogin">扫码登录</n-button>
          </div>
        </div>
        <div class="container">
          <div v-for="item in douyinAccounts" :key="item.id" class="card douyin-card">
            <span class="username douyin-remark" :title="item.remark || undefined">
              {{ item.remark || "" }}
            </span>
            <n-tag
              :type="getDouyinAccountHealthTagType(item.healthStatus)"
              size="small"
              class="douyin-health-tag"
              :title="item.healthReason || undefined"
            >
              {{ getDouyinAccountHealthTagText(item.healthStatus) }}
            </n-tag>
            <span v-if="item.updatedAt" class="douyin-updated-at">{{ item.updatedAt }}</span>
            <n-popover placement="right-start" trigger="hover">
              <template #trigger>
                <n-icon size="25" class="pointer menu"><EllipsisHorizontalOutline /></n-icon>
              </template>
              <div v-if="item.accountUid" style="padding: 5px 10px">ID: {{ item.accountUid }}</div>
              <div class="section" @click="handleProbeAccount(item)">
                {{ probingMap[item.id] ? "校验中..." : "校验" }}
              </div>
              <div class="section" @click="handleSilentRenewAccount(item)">
                {{ renewingMap[item.id] ? "重登中..." : "重登" }}
              </div>
              <div class="section section-danger" @click="deleteDouyinAccount(item.id)">删除</div>
            </n-popover>
          </div>
        </div>
        <DouyinLoginDialog v-model="showDouyinLoginDialog" @success="handleDouyinLoginSuccess" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<script setup lang="ts">
import { userApi, taskApi, douyuApi, douyinApi } from "@renderer/apis";
import { verifyBiliKey } from "@renderer/utils";
import { useClipboard } from "@vueuse/core";
import type { BiliUser, DouyuUser, DouyinCookieAccount } from "@biliLive-tools/types";
import { cloneDeep } from "lodash-es";

import { useUserInfoStore, useAppConfig, useDouyuUserStore } from "@renderer/stores";
import BiliLoginDialog from "./components/BiliLoginDialog.vue";
import DouyuLoginDialog from "./components/DouyuLoginDialog.vue";
import DouyinLoginDialog from "@renderer/pages/setting/components/DouyinLoginDialog.vue";
import { useConfirm } from "@renderer/hooks";
import { EllipsisHorizontalOutline } from "@vicons/ionicons5";
import {
  persistDouyinScanLogin,
  formatDouyinAccountUpdatedAt,
  getDouyinAccountHealthTagText,
  getDouyinAccountHealthTagType,
  interpretDouyinSilentRenewResult,
} from "@renderer/pages/setting/douyinAccounts";

defineOptions({
  name: "User",
});

const { getUsers, changeUser } = useUserInfoStore();
const appConfigStore = useAppConfig();
const { appConfig } = storeToRefs(appConfigStore);
const { userInfo, userList } = storeToRefs(useUserInfoStore());
const notice = useNotification();
const { userList: douyuUserList } = storeToRefs(useDouyuUserStore());
const { getUsers: getDouyuUsers } = useDouyuUserStore();
const confirm = useConfirm();

const showDouyinLoginDialog = ref(false);
const probingMap = ref<Record<string, boolean>>({});
const renewingMap = ref<Record<string, boolean>>({});

const douyinAccounts = computed(() => appConfig.value?.recorder?.douyin?.accounts ?? []);

const ensureDouyinAccounts = (): DouyinCookieAccount[] => {
  const douyin = appConfig.value.recorder.douyin;
  if (!Array.isArray(douyin.accounts)) {
    douyin.accounts = [];
  }
  return douyin.accounts;
};

const persistRecorder = async () => {
  await appConfigStore.set("recorder", cloneDeep(appConfig.value.recorder));
  await appConfigStore.getAppConfig();
};

const confirmCookieLoginRisk = async (platform: string, extraRisk?: string) => {
  const [status] = await confirm.warning({
    title: `${platform} 登录提示`,
    content: [
      "Cookie 会用于相关的 API 请求中。程序请求与浏览器内正常使用所发送的请求不完全一致，能通过分析请求日志识别出来。",
      "软件开发者不对账号发生的任何事情负责，包括并不限于被标记为机器人账号、无法参与各种抽奖和活动等。建议使用小号。",
      "如您知晓您的账号会因以上所列出来的部分原因所导致无法使用或权益受损等情况，并愿意承担由此所会带来的一系列后果，请继续以下的操作，软件开发者不会对您账号所发生的任何后果承担责任。",
      extraRisk,
    ]
      .filter(Boolean)
      .join("\n"),
    positiveText: "继续登录",
    negativeText: "取消",
  });
  return status;
};

const douyinScanLogin = async () => {
  const status = await confirmCookieLoginRisk(
    "抖音",
    "抖音扫码登录后将会将Cookie自动填入账号池，请确保是个人常用或备用小号。",
  );
  if (status) {
    showDouyinLoginDialog.value = true;
  }
};

const handleDouyinLoginSuccess = async (cookie: string) => {
  const accounts = ensureDouyinAccounts();
  const persist = await persistDouyinScanLogin({
    accounts,
    cookie,
    getAccountIdentity: (nextCookie) => douyinApi.getAccountIdentity(nextCookie),
  });
  if (!persist.didSave) {
    const noticeText =
      persist.failureReason === "identity_mismatch"
        ? "账号重登失败：登录身份与账号不一致"
        : "扫码登录失败：无法确认身份，请重新扫码";
    notice.error({ title: noticeText, duration: 3000 });
    return;
  }
  await persistRecorder();
};

const handleProbeAccount = async (account: DouyinCookieAccount) => {
  if (!account.cookie) {
    notice.warning({ title: "请先输入 Cookie 或扫码登录", duration: 2000 });
    return;
  }
  if (probingMap.value[account.id] || renewingMap.value[account.id]) return;
  probingMap.value[account.id] = true;
  try {
    const res = await douyinApi.probeAccount({
      accountId: account.id,
      cookie: account.cookie,
    });
    const now = Date.now();
    if (res.healthHint) {
      account.healthStatus = res.healthHint;
      account.healthReason = res.ok ? undefined : (res.reason || res.class);
      account.healthCheckedAt = now;
    } else if (res.reason || res.class) {
      account.healthReason = res.reason || res.class;
      account.healthCheckedAt = now;
    }
    await persistRecorder();
    if (res.ok) {
      notice.success({ title: "账号校验成功：状态正常", duration: 2000 });
    } else {
      notice.warning({ title: `账号校验完成：${res.reason || res.class || "状态异常"}`, duration: 2500 });
    }
  } catch (err: unknown) {
    notice.error({
      title: `账号校验失败：${err instanceof Error ? err.message : "网络请求异常"}`,
      duration: 3000,
    });
  } finally {
    probingMap.value[account.id] = false;
  }
};

const handleSilentRenewAccount = async (account: DouyinCookieAccount) => {
  if (!account.id) {
    notice.warning({ title: "账号ID未知", duration: 2000 });
    return;
  }
  if (renewingMap.value[account.id] || probingMap.value[account.id]) {
    return;
  }
  renewingMap.value[account.id] = true;
  try {
    const res = await douyinApi.silentRenew({ accountId: account.id });
    const now = Date.now();
    const decision = interpretDouyinSilentRenewResult(res);
    if (decision.healthStatus !== undefined) {
      account.healthStatus = decision.healthStatus;
    }
    if (decision.healthReason !== undefined) {
      account.healthReason = decision.healthReason;
    } else if (decision.writeCookie) {
      account.healthReason = undefined;
    }
    account.healthCheckedAt = res.healthCheckedAt || now;
    if (decision.writeCookie && res.cookie) {
      account.cookie = res.cookie;
    }
    if (decision.writeUpdatedAt) {
      account.updatedAt = res.updatedAt || formatDouyinAccountUpdatedAt();
    }
    await persistRecorder();
    if (decision.noticeLevel === "success") {
      notice.success({ title: decision.notice, duration: 2000 });
    } else if (decision.noticeLevel === "warning") {
      notice.warning({ title: decision.notice, duration: 2500 });
    } else {
      notice.error({ title: decision.notice, duration: 3000 });
    }
    if (decision.openQr) {
      showDouyinLoginDialog.value = true;
    }
  } catch (err: unknown) {
    notice.error({
      title: `账号重登异常：${err instanceof Error ? err.message : "网络请求异常"}`,
      duration: 3000,
    });
  } finally {
    renewingMap.value[account.id] = false;
  }
};

const deleteDouyinAccount = async (id: string) => {
  const [status] = await confirm.warning({
    content: "确认删除该抖音账号？",
  });
  if (!status) return;
  ensureDouyinAccounts();
  appConfig.value.recorder.douyin.accounts = appConfig.value.recorder.douyin.accounts.filter(
    (account) => account.id !== id,
  );
  await persistRecorder();
  notice.success({ title: "删除成功", duration: 1000 });
};

const douyuLoginVisible = ref(false);
const DOUYU_VALID_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const currentTime = ref(Date.now());
let expiryTimer: ReturnType<typeof setInterval> | undefined;

const douyuRemainingDays = (createdAt: number): number | undefined => {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return undefined;
  return Math.max(
    0,
    Math.ceil((createdAt + DOUYU_VALID_DAYS * DAY_MS - currentTime.value) / DAY_MS),
  );
};

const douyuExpiryText = (createdAt: number): string => {
  const remaining = douyuRemainingDays(createdAt);
  return remaining === undefined ? "有效期未知" : `剩余 ${remaining} / ${DOUYU_VALID_DAYS} 天`;
};

onMounted(() => {
  expiryTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 60 * 1000);
});

onUnmounted(() => {
  if (expiryTimer) clearInterval(expiryTimer);
});

const loginTvDialogVisible = ref(false);
const login = async () => {
  const [status] = await confirm.warning({
    content: [
      "程序请求与浏览器内正常使用所发送的请求不完全一致，能通过分析请求日志识别出来。",
      "软件开发者不对账号发生的任何事情负责，包括并不限于被标记为机器人账号、无法参与各种抽奖和活动等。",
      "如您知晓您的账号会因以上所列出来的部分原因所导致无法使用或权益受损等情况，并愿意承担由此所会带来的一系列后果，请继续以下的操作，软件开发者不会对您账号所发生的任何后果承担责任。",
    ]
      .filter(Boolean)
      .join("\n"),
    positiveText: "继续登录",
    negativeText: "取消",
  });
  if (!status) return;

  loginTvDialogVisible.value = true;
};

const douyuLogin = async () => {
  const [status] = await confirm.warning({
    title: "斗鱼登录提示",
    content: [
      "Cookie 会用于斗鱼录制相关请求，建议使用小号。",
      "程序请求与浏览器正常使用的请求不完全一致，继续即表示你了解并愿意承担账号风险。",
    ].join("\n"),
    positiveText: "继续登录",
    negativeText: "取消",
  });
  if (status) douyuLoginVisible.value = true;
};

const douyuLoginConfirm = async () => {
  await getDouyuUsers();
};

const douyuUpdateAuth = async (uid: number) => {
  await douyuApi.updateAuth(uid);
  notice.success({
    title: "已更新授权",
    duration: 1000,
  });
  await getDouyuUsers();
};

const douyuValidate = async (uid: number) => {
  const { valid } = await douyuApi.validate(uid);
  if (valid) {
    notice.success({ title: "Cookie 有效", duration: 2000 });
  } else {
    notice.warning({ title: "Cookie 已失效", duration: 3000 });
  }
};

const douyuLogout = async (uid: number) => {
  const [status] = await confirm.warning({
    content: "确认退出该斗鱼账号？",
  });
  if (!status) return;
  await douyuApi.deleteUser(uid);
  await getDouyuUsers();
};

const logout = async (uid: number) => {
  const uids = [
    appConfig.value.webhook.uid,
    ...Object.values(appConfig.value.webhook.rooms).map((item) => item.uid),
  ];
  if (uids.includes(uid)) {
    const [status] = await confirm.warning({
      content: "当前帐号正在被webhook使用，是否确认退出？",
    });
    if (!status) return;
  } else {
    const [status] = await confirm.warning({
      content: "确认退出账号？",
    });
    if (!status) return;
  }

  await userApi.delete(uid);
  await getUsers();
  if (uid === userInfo.value.uid) {
    changeAccount(userList.value[0]?.uid);
  }
};
const changeAccount = async (uid: number) => {
  changeUser(uid);
};

const loginConfirm = async () => {
  await getUsers();
  if (!userInfo.value.uid) {
    changeAccount(userList.value[0]?.uid ?? "");
  }
};

const updateAccountInfo = async (uid: number) => {
  await userApi.refresh(uid);
  notice.success({
    title: "已获取最新数据",
    duration: 1000,
  });
  getUsers();
};
const updateAuth = async (uid: number) => {
  const tasks = (
    await taskApi.list({
      type: "bili",
    })
  ).list.filter((item) => item.status === "running");
  if (tasks.length) {
    const [status] = await confirm.warning({
      content: "当前有正在上传的任务，更新后可能会失败，是否确认更新？",
    });
    if (!status) return;
  }
  await userApi.updateAuth(uid);
  notice.success({
    title: "已更新授权",
    duration: 1000,
  });
  getUsers();
};

const { copy } = useClipboard({ legacy: true });
const allImportInput = ref<HTMLInputElement | null>(null);

const showBiliKeyBlockedNotice = (reason: "missing" | "mismatch" | "error" | "cancelled") => {
  if (reason === "missing") {
    notice.error({
      title: "未配置 BILILIVE_TOOLS_BILIKEY，当前操作已拦截",
      duration: 1600,
    });
    return;
  }
  if (reason === "mismatch") {
    notice.error({
      title: "密钥错误，当前操作已拦截",
      duration: 1600,
    });
    return;
  }
  if (reason === "error") {
    notice.error({
      title: "校验服务异常，当前操作已拦截",
      duration: 1600,
    });
    return;
  }
  notice.warning({
    title: "已取消校验，当前操作已拦截",
    duration: 1200,
  });
};

const downloadJSON = async (name: string, data: unknown): Promise<boolean> => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return true;
};

const readJSONFile = async <T,>(file: File): Promise<T> => {
  const text = await file.text();
  return JSON.parse(text) as T;
};

const isBiliUser = (value: unknown): value is BiliUser => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const user = value as {
    mid?: unknown;
    accessToken?: unknown;
    refreshToken?: unknown;
    cookie?: unknown;
  };

  return (
    typeof user.mid === "number" &&
    typeof user.accessToken === "string" &&
    typeof user.refreshToken === "string" &&
    !!user.cookie &&
    typeof user.cookie === "object"
  );
};

const exportCurrentAccount = async (uid: number) => {
  const isVerified = await verifyBiliKey({
    onBlocked: showBiliKeyBlockedNotice,
  });
  if (!isVerified) return;

  const user = await userApi.exportSingle(uid);
  const isExported = await downloadJSON(`bili-user-${uid}.json`, user);
  if (!isExported) return;
  notice.success({
    title: "导出成功",
    duration: 1200,
  });
};

const exportAllAccounts = async () => {
  const isVerified = await verifyBiliKey({
    onBlocked: showBiliKeyBlockedNotice,
  });
  if (!isVerified) return;

  const users = await userApi.exportAll();
  const isExported = await downloadJSON("bili-users-all.json", users);
  if (!isExported) return;
  notice.success({
    title: "导出成功",
    duration: 1200,
  });
};

const triggerImportAll = () => {
  allImportInput.value?.click();
};

const onImportAllFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const payload = await readJSONFile<unknown>(file);

    if (Array.isArray(payload)) {
      if (!payload.every(isBiliUser)) {
        throw new Error("invalid user list payload");
      }
      await userApi.importAll(payload);
    } else if (isBiliUser(payload)) {
      await userApi.importSingle(payload);
    } else {
      throw new Error("invalid user payload");
    }

    await getUsers();
    notice.success({
      title: "导入成功",
      duration: 1200,
    });
  } catch {
    notice.error({
      title: "导入失败，文件格式错误",
      duration: 1600,
    });
  } finally {
    input.value = "";
  }
};

const getCookie = async (uid: number) => {
  const isVerified = await verifyBiliKey({
    onBlocked: showBiliKeyBlockedNotice,
  });
  if (!isVerified) return;

  const cookie = await userApi.getCookie(uid);
  await copy(cookie);

  notice.success({
    title: "已复制到剪切板",
    duration: 1000,
  });
};

const douyuImportInput = ref<HTMLInputElement | null>(null);

const isDouyuUser = (value: unknown): value is DouyuUser => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const user = value as {
    uid?: unknown;
    name?: unknown;
    loginCookies?: {
      main?: unknown;
      passport?: unknown;
    };
  };

  return (
    typeof user.uid === "number" &&
    typeof user.name === "string" &&
    !!user.loginCookies &&
    typeof user.loginCookies === "object" &&
    typeof user.loginCookies.main === "string" &&
    typeof user.loginCookies.passport === "string"
  );
};

const exportDouyuAccounts = async () => {
  const users = await douyuApi.exportAll();
  const isExported = await downloadJSON("douyu-users-all.json", users);
  if (!isExported) return;
  notice.success({
    title: "导出成功",
    duration: 1200,
  });
};

const exportDouyuAccount = async (uid: number) => {
  const user = await douyuApi.exportSingle(uid);
  const isExported = await downloadJSON(`douyu-user-${uid}.json`, user);
  if (!isExported) return;
  notice.success({
    title: "导出成功",
    duration: 1200,
  });
};

const triggerDouyuImport = () => {
  douyuImportInput.value?.click();
};

const onDouyuImportFileChange = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const payload = await readJSONFile<unknown>(file);

    if (Array.isArray(payload)) {
      if (!payload.every(isDouyuUser)) {
        throw new Error("invalid douyu user list payload");
      }
      await douyuApi.importAll(payload);
    } else if (isDouyuUser(payload)) {
      await douyuApi.importSingle(payload);
    } else {
      throw new Error("invalid douyu user payload");
    }

    await getDouyuUsers();
    notice.success({
      title: "导入成功",
      duration: 1200,
    });
  } catch {
    notice.error({
      title: "导入失败，文件格式错误",
      duration: 1600,
    });
  } finally {
    input.value = "";
  }
};

onActivated(() => {
  currentTime.value = Date.now();
  getUsers();
  getDouyuUsers();
  appConfigStore.getAppConfig();
});
</script>

<style scoped lang="less">
.login-btns {
  display: inline-flex;
  gap: 10px;
}

.container {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
  .card {
    padding: 10px;
    width: 100px;
    border-radius: 10px;
    background-color: var(--bg-card);
    justify-content: center;
    align-items: center;
    border: 1px solid var(--border-primary);
    position: relative;
    display: flex;
    flex-direction: column;
    .face {
      width: 80%;
    }
    .menu {
      position: absolute;
      bottom: 0px;
      right: 5px;
      color: var(--text-secondary);
    }
  }
  .card.active {
    &::before {
      content: "正在使用";
      display: block;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      color: #ffffff;
      background-color: var(--bg-modal);
      display: flex;
      justify-content: center;
      align-items: center;
      border-radius: 10px;
    }
    .menu {
      color: #eee;
    }
  }
  .card.douyin-card {
    width: 120px;
    min-height: 100px;
    gap: 6px;
    justify-content: flex-start;
    padding-bottom: 24px;
    .douyin-remark {
      width: 100%;
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      min-height: 18px;
    }
    .douyin-health-tag {
      margin: 2px 0;
    }
    .douyin-updated-at {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      transform: scale(0.9);
      transform-origin: center;
    }
  }
}

.section {
  padding: 5px 10px;
  cursor: pointer;
  &:hover {
    background-color: var(--bg-hover);
  }

  &.section-danger {
    color: var(--color-danger-text);
  }
}
.expires {
  z-index: 1000;
  position: absolute;
  bottom: 0;
  left: 0;
  background: var(--color-success);
  color: var(--text-inverse);
  padding: 4px 6px;
  border-radius: 0 10px 0 10px;
  font-size: 10px;
  &.expired {
    background: var(--color-danger-text);
  }
}
.username {
  color: var(--text-primary);
}
.face-placeholder {
  width: 80%;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: var(--bg-hover);
}
</style>
