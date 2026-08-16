import path from "node:path";
import mitt from "mitt";
import {
  defaultFromJSON,
  defaultToJSON,
  genRecorderUUID,
  genRecordUUID,
  utils,
  createDownloader,
} from "@bililive-tools/manager";
import type {
  Recorder,
  RecorderCreateOpts,
  RecorderProvider,
  RecordHandle,
  Comment,
  GiveGift,
} from "@bililive-tools/manager";

import { getInfo, getStream } from "./stream.js";
import { singleton } from "./utils.js";
import { resolveShortURL, parseUser } from "./douyin_api.js";
import {
  isAuthFailureError,
  isQuarantinedAccount,
  markAuthFailure,
  probeAccountsNeedingCheck,
  resetAuthFailForAccount,
} from "./cookieAccountSelection.js";

import DouYinDanmaClient from "douyin-danma-listener";

import type { APIType } from "./types.js";

export {
  AUTH_FAIL_THRESHOLD,
  CHECK_WINDOW_MS,
  MIN_PROBE_INTERVAL_MS,
  applyHealthPatch,
  createAuthFailCounter,
  deriveSelectableDouyinCookieAccounts,
  isAuthFailureError,
  isPastCheckWindow,
  isQuarantinedAccount,
  mapProbeResultToHealthPatch,
  markAuthFailure,
  maybeProbeAccount,
  probeAccountsNeedingCheck,
  resetAuthFailForAccount,
  resetProbeBStateForTests,
  setDouyinHealthPatchScheduler,
  setDouyinProbeOnce,
  shouldProbeAccount,
} from "./cookieAccountSelection.js";
export type {
  AuthFailCounter,
  DouyinAccountHealthPatch,
  DouyinCookieAccountLike,
  DouyinProbeOnceFn,
  HealthPatchScheduler,
  MaybeProbeResult,
  ProbeOnceResult,
} from "./cookieAccountSelection.js";

export {
  PROBE_C_ACCOUNT_GAP_MS,
  PROBE_C_AUTH_INVALID_THRESHOLD,
  PROBE_C_AUTH_RELOGIN_THRESHOLD,
  PROBE_C_IDLE_INTERVAL_MS,
  clearDefaultProbeCAuthCounter,
  createProbeCAuthCounter,
  getDefaultProbeCAuthCounter,
  getProbeCAccountsGetter,
  isProbeCIdlePatrolEnabled,
  isProbeCIdlePatrolRunning,
  mapProbeCResultToHealthPatch,
  resetProbeCStateForTests,
  runProbeCIdleRound,
  setDouyinProbeCOnce,
  setProbeCAccountsGetter,
  setProbeCIdlePatrolEnabled,
  shouldProbeCIdleAccount,
  startProbeCIdlePatrol,
  stopProbeCIdlePatrol,
  wireProbeCHost,
} from "./probeC.js";
export type {
  ProbeCAuthCountState,
  ProbeCAuthCounter,
  ProbeCEscalation,
  ProbeCIdleRoundItem,
  ProbeCIdleSkipReason,
  ProbeCMapResult,
  ProbeCSleepFn,
  ResetProbeCStateOptions,
  RunProbeCIdleRoundOpts,
  StartProbeCIdlePatrolOpts,
  WireProbeCHostOpts,
} from "./probeC.js";

export { mapLayer1ProbeResultToHealthPatch } from "./probeB.js";

const douyinDanmaHosts = [
  "webcast100-ws-web-hl.douyin.com",
  "webcast100-ws-web-lf.douyin.com",
] as const;

const MAX_DOUYIN_RECORDINGS_PER_COOKIE = 4;
const FALLBACK_DOUYIN_COOKIE_ACCOUNT_INDEX = -1;
const NO_DOUYIN_COOKIE_ACCOUNT_INDEX = -2;
const douyinCookieRecordingCounts = new Map<string, number>();

function normalizeDouyinCookie(cookie?: string) {
  const normalized = cookie?.trim();
  return normalized ? normalized : undefined;
}

function getDouyinCookieRecordingCount(cookie: string) {
  return douyinCookieRecordingCounts.get(cookie) ?? 0;
}

function canAcquireDouyinCookieRecording(cookie: string) {
  return getDouyinCookieRecordingCount(cookie) < MAX_DOUYIN_RECORDINGS_PER_COOKIE;
}

function acquireDouyinCookieRecording(cookie: string, { allowOverflow = false } = {}) {
  if (!allowOverflow && !canAcquireDouyinCookieRecording(cookie)) return false;
  douyinCookieRecordingCounts.set(cookie, getDouyinCookieRecordingCount(cookie) + 1);
  return true;
}

function releaseDouyinCookieRecording(cookie?: string) {
  if (!cookie) return;
  const count = douyinCookieRecordingCounts.get(cookie);
  if (!count) return;
  if (count === 1) {
    douyinCookieRecordingCounts.delete(cookie);
    return;
  }
  douyinCookieRecordingCounts.set(cookie, count - 1);
}

function formatUnknownError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createRecorder(opts: RecorderCreateOpts): Recorder {
  // 内部实现时，应该只有 proxy 包裹的那一层会使用这个 recorder 标识符，不应该有直接通过
  // 此标志来操作这个对象的地方，不然会跳过 proxy 的拦截。
  const recorder: Recorder = {
    id: opts.id ?? genRecorderUUID(),
    extra: opts.extra ?? {},
    // @ts-ignore
    ...mitt(),
    ...opts,

    availableStreams: [],
    availableSources: [],
    qualityRetry: opts.qualityRetry ?? 0,
    useServerTimestamp: opts.useServerTimestamp ?? true,
    state: "idle",
    cache: null as any,
    appendTimeline: null as any,

    getChannelURL() {
      return `https://live.douyin.com/${this.channelId}`;
    },
    checkLiveStatusAndRecord: singleton(checkLiveStatusAndRecord),

    toJSON() {
      return defaultToJSON(provider, this);
    },

    async getLiveInfo() {
      const channelId = this.channelId;
      const info = await getInfo(channelId, {
        uid: this.uid,
      });
      return {
        channelId,
        ...info,
      };
    },
    async getStream() {
      const res = await getStream({
        channelId: this.channelId,
        quality: this.quality,
        streamPriorities: this.streamPriorities,
        sourcePriorities: this.sourcePriorities,
      });
      return res.currentStream;
    },
  };

  const recorderWithSupportUpdatedEvent = new Proxy(recorder, {
    set(obj, prop, value) {
      Reflect.set(obj, prop, value);

      if (typeof prop === "string") {
        obj.emit("Updated", [prop]);
      }

      return true;
    },
  });

  return recorderWithSupportUpdatedEvent;
}

const ffmpegOutputOptions: string[] = [];
const ffmpegInputOptions: string[] = ["-rw_timeout", "10000000", "-timeout", "10000000"];

const checkLiveStatusAndRecord: Recorder["checkLiveStatusAndRecord"] = async function ({
  getSavePath,
  banLiveId,
  isManualStart,
}) {
  // 如果已经在录制中,只在需要检查标题关键词时才获取最新信息
  if (this.recordHandle != null) {
    const shouldStop = await utils.checkTitleKeywordsWhileRecording(
      this,
      isManualStart,
      (channelId) =>
        getInfo(channelId, {
          api: this.api as APIType,
          uid: this.uid,
        }),
    );
    if (shouldStop) {
      return null;
    }

    // 已经在录制中，直接返回
    return this.recordHandle;
  }

  // 获取直播间信息
  let isLiveRadio = false;
  try {
    const liveInfo = await getInfo(this.channelId, {
      api: this.api as APIType,
      uid: this.uid,
    });
    this.liveInfo = liveInfo;
    isLiveRadio = liveInfo.isLiveRadio;
    this.emit("stateChange", { state: "idle" });
  } catch (error) {
    this.emit("stateChange", {
      state: "check-error",
      msg: `检查失败，` + (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }

  if (this.liveInfo.liveId && this.liveInfo.liveId === banLiveId) {
    this.tempStopIntervalCheck = true;
  } else {
    this.tempStopIntervalCheck = false;
  }
  if (this.tempStopIntervalCheck) return null;
  if (!this.liveInfo.living) return null;

  // 检查标题是否包含关键词
  if (utils.checkTitleKeywordsBeforeRecord(this.liveInfo.title, this, isManualStart)) return null;

  const qualityRetryLeft = (await this.cache.get("qualityRetryLeft")) ?? this.qualityRetry;
  const strictQuality = utils.shouldUseStrictQuality(
    qualityRetryLeft,
    this.qualityRetry,
    isManualStart,
  );

  let res: Awaited<ReturnType<typeof getStream>>;
  try {
    res = await getStream({
      channelId: this.channelId,
      quality: this.quality,
      streamPriorities: this.streamPriorities,
      sourcePriorities: this.sourcePriorities,
      strictQuality: strictQuality,
      formatPriorities: this.formatPriorities,
      doubleScreen: this.doubleScreen,
      api: this.api as APIType,
      uid: this.uid,
      isLiveRadio: isLiveRadio,
    });
    this.liveInfo.owner = res.owner;
    this.liveInfo.title = res.title;
    this.liveInfo.cover = res.cover;
    this.liveInfo.liveId = res.liveId;
    this.liveInfo.avatar = res.avatar;

    // 再检查一次，上一个接口可能不存在标题参数
    if (utils.checkTitleKeywordsBeforeRecord(this.liveInfo.title, this, isManualStart)) return null;
  } catch (err) {
    if (qualityRetryLeft > 0) await this.cache.set("qualityRetryLeft", qualityRetryLeft - 1);

    this.emit("stateChange", {
      state: "check-error",
      msg: `检查失败，` + (err instanceof Error ? err.message : String(err)),
    });
    throw err;
  }
  const { owner, title, liveStartTime, recordStartTime } = this.liveInfo;

  this.emit("stateChange", { state: "recording" });
  const { currentStream: stream, sources: availableSources, streams: availableStreams } = res;
  this.availableStreams = availableStreams.map((s) => s.desc);
  this.availableSources = availableSources.map((s) => s.name);
  this.usedStream = stream.name;
  this.usedSource = stream.source;

  const cookieMode = this.douyinCookieMode ?? "always";
  const shouldApplyCookie = cookieMode !== "off";
  const authDouyinCookie = normalizeDouyinCookie(this.auth);
  /**
   * §9.5：选号/恢复每次从权威源 `this.douyinCookieAccounts` 重算下标。
   * 使用权威数组下标（非派生列表下标），避免隔离后列表收缩导致 active 错位。
   * 过滤：enabled !== false && cookie 非空 && 非 quarantine(invalid|relogin_required)。
   * enabled 与 quarantine 正交。禁止启动时浅拷贝快照。
   */
  const getDouyinCookieForAccountIndex = (accountIndex: number) => {
    if (!shouldApplyCookie) return undefined;
    if (accountIndex === NO_DOUYIN_COOKIE_ACCOUNT_INDEX) return undefined;
    if (accountIndex === FALLBACK_DOUYIN_COOKIE_ACCOUNT_INDEX) return authDouyinCookie;
    return normalizeDouyinCookie(this.douyinCookieAccounts?.[accountIndex]?.cookie);
  };
  const getSelectableDouyinCookieAccountIndices = () => {
    if (!shouldApplyCookie) return [NO_DOUYIN_COOKIE_ACCOUNT_INDEX];
    const accounts = this.douyinCookieAccounts ?? [];
    const indices: number[] = [];
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (!account || account.enabled === false) continue;
      if (!normalizeDouyinCookie(account.cookie)) continue;
      if (isQuarantinedAccount(account)) continue;
      indices.push(i);
    }
    if (indices.length === 0) {
      return authDouyinCookie
        ? [FALLBACK_DOUYIN_COOKIE_ACCOUNT_INDEX]
        : [NO_DOUYIN_COOKIE_ACCOUNT_INDEX];
    }
    const authAccountIndex = indices.find(
      (index) => normalizeDouyinCookie(accounts[index]?.cookie) === authDouyinCookie,
    );
    if (authAccountIndex === undefined) return indices;
    return [authAccountIndex, ...indices.filter((index) => index !== authAccountIndex)];
  };
  const hasConfiguredDouyinCookie = () =>
    shouldApplyCookie &&
    (Boolean(authDouyinCookie) ||
      (this.douyinCookieAccounts ?? []).some(
        (account) => account.enabled !== false && Boolean(normalizeDouyinCookie(account.cookie)),
      ));
  const findAvailableDouyinCookieAccountIndex = () => {
    // §9.5 + 隔离过滤：每次选号重算
    const initialAccountIndices = getSelectableDouyinCookieAccountIndices();
    const availableAccountIndex = initialAccountIndices.find((accountIndex) => {
      const cookie = getDouyinCookieForAccountIndex(accountIndex);
      return !cookie || canAcquireDouyinCookieRecording(cookie);
    });
    if (availableAccountIndex !== undefined) return availableAccountIndex;
    return (
      initialAccountIndices.find((accountIndex) => getDouyinCookieForAccountIndex(accountIndex)) ??
      NO_DOUYIN_COOKIE_ACCOUNT_INDEX
    );
  };
  // 探针 B：选号/换号前对 unknown 或过窗账号做限流探测（注入 probeOnce；无注入则 no-op）
  if (shouldApplyCookie) {
    try {
      await probeAccountsNeedingCheck({
        accounts: this.douyinCookieAccounts,
      });
    } catch {
      // best-effort：探针失败不阻断录制
    }
  }
  let activeDouyinCookieAccountIndex = findAvailableDouyinCookieAccountIndex();
  let acquiredDouyinCookie: string | undefined;
  let hasNotifiedDouyinCookieLimit = false;
  const getActiveDouyinCookieAccount = () => {
    if (activeDouyinCookieAccountIndex < 0) return undefined;
    return this.douyinCookieAccounts?.[activeDouyinCookieAccountIndex];
  };
  const getActiveDouyinCookie = () => {
    return acquiredDouyinCookie;
  };
  const applyActiveDouyinCookieRemark = () => {
    const remark = getActiveDouyinCookieAccount()?.remark?.trim();
    const { currentDouyinCookieRemark: _previousRemark, ...extraWithoutRemark } = this.extra ?? {};
    this.extra = {
      ...extraWithoutRemark,
      ...(remark ? { currentDouyinCookieRemark: remark } : {}),
    };
  };
  const notifyDouyinCookieLimit = () => {
    if (!hasConfiguredDouyinCookie() || hasNotifiedDouyinCookieLimit) return;
    hasNotifiedDouyinCookieLimit = true;
    const text = "抖音 Cookie 均已达到 4 个录制占用，本直播间将继续超限使用 Cookie 连接弹幕，礼物获取状态请以真实场景为准，请及时处理。";
    if (typeof this.appendTimeline === "function") {
      this.appendTimeline({ text });
    }
    this.emit("Notification", {
      title: "抖音 Cookie 已满载",
      content: `直播间 ${this.channelId} 的${text}`,
    });
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} all cookie accounts reached ${MAX_DOUYIN_RECORDINGS_PER_COOKIE} active recordings; danma continues with cookie over limit`,
    });
  };
  const releaseAcquiredDouyinCookie = () => {
    releaseDouyinCookieRecording(acquiredDouyinCookie);
    acquiredDouyinCookie = undefined;
  };
  const ensureActiveDouyinCookieAcquired = () => {
    const nextCookie = getDouyinCookieForAccountIndex(activeDouyinCookieAccountIndex);
    if (!nextCookie) {
      releaseAcquiredDouyinCookie();
      notifyDouyinCookieLimit();
      return;
    }
    if (nextCookie === acquiredDouyinCookie) return;
    const shouldOverflowDouyinCookie = !canAcquireDouyinCookieRecording(nextCookie);
    if (shouldOverflowDouyinCookie) {
      notifyDouyinCookieLimit();
    }
    releaseAcquiredDouyinCookie();
    acquireDouyinCookieRecording(nextCookie, { allowOverflow: shouldOverflowDouyinCookie });
    acquiredDouyinCookie = nextCookie;
  };
  applyActiveDouyinCookieRemark();

  const getDouyinDanmaRecoveryKey = (accountIndex: number, hostIndex: number) =>
    `${getDouyinCookieForAccountIndex(accountIndex) ?? ""}\n${douyinDanmaHosts[hostIndex] ?? ""}`;
  const attemptedDouyinDanmaRecoveryKeys = new Set<string>();
  /** 6e：隔离号永不进 recovery；§9.5 每次重算 selectable */
  const getDouyinDanmaRecoveryAccountIndices = () => {
    if (!shouldApplyCookie) return [];
    const selectable = getSelectableDouyinCookieAccountIndices().filter(
      (index) => index !== NO_DOUYIN_COOKIE_ACCOUNT_INDEX,
    );
    if (selectable.length === 0) return [];
    return [
      ...new Set([
        ...(selectable.includes(activeDouyinCookieAccountIndex)
          ? [activeDouyinCookieAccountIndex]
          : []),
        ...selectable,
      ]),
    ];
  };
  const getDouyinDanmaRecoveryPriority = (accountIndex: number, hostIndex: number) => {
    const candidateCookie = getDouyinCookieForAccountIndex(accountIndex);
    const changesCookie = candidateCookie !== acquiredDouyinCookie;
    const changesHost = hostIndex !== activeDouyinDanmaHostIndex;
    if (!candidateCookie) return changesHost ? 3 : 4;
    return changesCookie && changesHost ? 0 : changesCookie ? 1 : 2;
  };
  const findNextDanmaRecoveryCandidate = () => {
    // §9.5 + 6e：每次从权威源重算非隔离候选
    const accountIndices = getDouyinDanmaRecoveryAccountIndices();
    const hostIndices = douyinDanmaHosts.map((_host, index) => index);
    const candidates = accountIndices.flatMap((accountIndex) =>
      hostIndices.map((hostIndex) => {
        return {
          accountIndex,
          hostIndex,
          priority: getDouyinDanmaRecoveryPriority(accountIndex, hostIndex),
        };
      }),
    );

    return candidates
      .filter(
        (candidate) =>
          candidate.accountIndex !== activeDouyinCookieAccountIndex ||
          candidate.hostIndex !== activeDouyinDanmaHostIndex,
      )
      .filter(
        (candidate) =>
          !attemptedDouyinDanmaRecoveryKeys.has(
            getDouyinDanmaRecoveryKey(candidate.accountIndex, candidate.hostIndex),
          ),
      )
      .filter((candidate) => {
        // 双保险：权威源上仍可能被并发 mark 为隔离
        if (candidate.accountIndex >= 0) {
          const account = this.douyinCookieAccounts?.[candidate.accountIndex];
          if (account && isQuarantinedAccount(account)) return false;
        }
        const candidateCookie = getDouyinCookieForAccountIndex(candidate.accountIndex);
        return (
          !candidateCookie ||
          candidateCookie === acquiredDouyinCookie ||
          canAcquireDouyinCookieRecording(candidateCookie)
        );
      })
      .sort((left, right) => left.priority - right.priority)[0];
  };

  /** 探针 A：鉴权类失败累计 → invalid；非鉴权不升级；无全局熔断 */
  const applyProbeAOnDanmaAuthFailure = (err: unknown) => {
    if (!isAuthFailureError(err)) return;
    const account = getActiveDouyinCookieAccount();
    const accountId = account?.id;
    if (!accountId) return;
    const reason = `danma auth: ${formatUnknownError(err)}`.slice(0, 200);
    const result = markAuthFailure({
      accountId,
      reason,
      accounts: this.douyinCookieAccounts,
    });
    if (result.kind === "invalidated") {
      this.emit("DebugLog", {
        type: "common",
        text: `douyin ${this.channelId} probe-A quarantine account id=${accountId} → invalid (${reason})`,
      });
    }
  };

  /** 探针 B：换号前对池内 need-probe 账号限流探测（best-effort） */
  const runProbeBBeforeSwitch = async () => {
    if (!shouldApplyCookie) return;
    try {
      await probeAccountsNeedingCheck({
        accounts: this.douyinCookieAccounts,
      });
    } catch {
      // best-effort
    }
  };

  let isEnded = false;
  const onEnd = (...args: unknown[]) => {
    if (isEnded) return;
    isEnded = true;
    this.emit("DebugLog", {
      type: "common",
      text: `record end, reason: ${JSON.stringify(args, (_, v) => (v instanceof Error ? v.stack : v))}`,
    });
    const reason = args[0] instanceof Error ? args[0].message : String(args[0]);
    this.recordHandle?.stop(reason);
  };

  const downloader = createDownloader(
    this.recorderType,
    {
      url: stream.url,
      outputOptions: ffmpegOutputOptions,
      inputOptions: ffmpegInputOptions,
      segment: this.segment ?? 0,
      getSavePath: (opts) =>
        getSavePath({
          owner,
          title: opts.title ?? title,
          startTime: opts.startTime,
          liveStartTime: liveStartTime,
          recordStartTime,
          extraMs: opts.extraMs,
        }),
      disableDanma: this.disableProvideCommentsWhenRecording,
      videoFormat: this.videoFormat ?? "auto",
      debugLevel: this.debugLevel ?? "none",
      onlyAudio: stream.onlyAudio,
      headers: {},
      proxy: this.proxy,
    },
    onEnd,
    async () => {
      const info = await getInfo(this.channelId, {
      });
      return info;
    },
  );

  const handleVideoCreated = async ({ filename, title, cover, rawFilename }) => {
    this.emit("videoFileCreated", { filename, cover, rawFilename });

    if (title && this?.liveInfo) {
      this.liveInfo.title = title;
    }
    if (cover && this?.liveInfo) {
      this.liveInfo.cover = cover;
    }
    const extraDataController = downloader.getExtraDataController();
    extraDataController?.setMeta({
      room_id: this.channelId,
      platform: provider?.id,
      // liveStartTimestamp: liveInfo.startTime?.getTime(),
      // recordStopTimestamp: Date.now(),
      title: title,
      user_name: owner,
    });
  };
  downloader.on("videoFileCreated", handleVideoCreated);
  downloader.on("videoFileCompleted", (data) => {
    this.emit("videoFileCompleted", data);
  });
  downloader.on("DebugLog", (data) => {
    this.emit("DebugLog", data);
  });
  downloader.on("progress", (progress) => {
    if (this.recordHandle) {
      this.recordHandle.progress = progress;
    }
    this.emit("progress", progress);
  });

  // 礼物消息缓存管理
  const giftMessageCache = new Map<
    string,
    {
      gift: GiveGift;
      timer: NodeJS.Timeout;
    }
  >();

  // 礼物延迟处理时间(毫秒),可根据实际情况调整
  const GIFT_DELAY = 5000;

  let activeDanmaClient: DouYinDanmaClient | undefined;
  let activeDouyinDanmaHostIndex = 0;
  let isDanmaStopped = false;
  const ignoredDanmaCloseClients = new WeakSet<DouYinDanmaClient>();
  const shouldManageDouyinDanmaRecovery = shouldApplyCookie;
  const getActiveDouyinDanmaHost = () => douyinDanmaHosts[activeDouyinDanmaHostIndex];
  const createDanmaClient = () =>
    new DouYinDanmaClient(String(this.liveInfo?.liveId ?? ""), {
      cookie: getActiveDouyinCookie(),
      host: getActiveDouyinDanmaHost(),
      autoReconnect: shouldManageDouyinDanmaRecovery ? 0 : undefined,
    });
  const closeDanmaClient = (client: DouYinDanmaClient) => {
    ignoredDanmaCloseClients.add(client);
    try {
      client.close();
    } catch (error) {
      ignoredDanmaCloseClients.delete(client);
      throw error;
    }
  };
  const attachDanmaHandlers = (client: DouYinDanmaClient) => {
    client.on("chat", (msg) => {
      const extraDataController = downloader.getExtraDataController();
      if (!extraDataController) return;
      let timestamp: number = Date.now();
      if (this.useServerTimestamp && msg.eventTime) {
        // 某些消息可能没有 eventTime 字段
        timestamp = Number(msg.eventTime) * 1000;
      }
      const comment: Comment = {
        type: "comment",
        timestamp: timestamp,
        text: msg.content,
        color: "#ffffff",
        sender: {
          uid: msg.user.id,
          name: msg.user.nickName,
        },
      };
      this.emit("Message", comment);
      extraDataController.addMessage(comment);
    });
    client.on("privilegeScreenChat", (msg) => {
      const extraDataController = downloader.getExtraDataController();
      if (!extraDataController) return;
      const comment: Comment = {
        type: "comment",
        // 抖音飘屏没有时间戳数据，默认使用当前时间
        timestamp: Date.now(),
        text: msg.content,
        color: "#e0c39c",
        sender: {
          uid: msg.user.id,
          name: msg.user.nickName,
        },
      };
      this.emit("Message", comment);
      extraDataController.addMessage(comment);
    });
    client.on("screenChat", (msg) => {
      const extraDataController = downloader.getExtraDataController();
      if (!extraDataController) return;
      const comment: Comment = {
        type: "comment",
        timestamp: this.useServerTimestamp ? Number(msg.eventTime) / 1000000 : Date.now(),
        text: msg.content,
        color: "#d7f6fc",
        sender: {
          uid: msg.user.id,
          name: msg.user.nickName,
        },
      };
      this.emit("Message", comment);
      extraDataController.addMessage(comment);
    });
    client.on("gift", (msg) => {
      const extraDataController = downloader.getExtraDataController();
      if (!extraDataController) return;
      if (this.saveGiftDanma === false) return;

      const serverTimestamp =
        Number(msg.common.createTime) > 9999999999
          ? Number(msg.common.createTime)
          : Number(msg.common.createTime) * 1000;

      const gift: GiveGift = {
        type: "give_gift",
        timestamp: this.useServerTimestamp ? serverTimestamp : Date.now(),
        name: msg.gift.name,
        price: msg.gift.diamondCount / 10 || 0,
        count: Number(msg.totalCount ?? 1),
        color: "#ffffff",
        sender: {
          uid: msg.user.id,
          name: msg.user.nickName || "unknown",
        },
      };

      // 单独使用groupId并不可靠
      const groupId = `${msg.groupId}_${msg.user.id}_${msg.giftId}`;
      const existing = giftMessageCache.get(groupId);
      if (existing) {
        clearTimeout(existing.timer);
      }

      const timer = setTimeout(() => {
        const cachedGift = giftMessageCache.get(groupId);
        if (cachedGift) {
          this.emit("Message", cachedGift.gift);
          extraDataController.addMessage(cachedGift.gift);
          giftMessageCache.delete(groupId);
        }
      }, GIFT_DELAY);

      giftMessageCache.set(groupId, { gift, timer });
    });
    client.on("reconnect", handleDanmaReconnect);
    client.on("error", (err) => handleDanmaError(client, err));
    client.on("init", handleDanmaInit);
    client.on("open", () => handleDanmaOpen(client));
    client.on("close", () => handleDanmaClose(client));
  };
  const startDanmaClient = () => {
    if (isDanmaStopped) return;
    ensureActiveDouyinCookieAcquired();
    try {
      attemptedDouyinDanmaRecoveryKeys.add(
        getDouyinDanmaRecoveryKey(activeDouyinCookieAccountIndex, activeDouyinDanmaHostIndex),
      );
      activeDanmaClient = createDanmaClient();
      attachDanmaHandlers(activeDanmaClient);
      activeDanmaClient.connect();
    } catch (error) {
      const failedClient = activeDanmaClient;
      activeDanmaClient = undefined;
      if (failedClient) {
        try {
          closeDanmaClient(failedClient);
        } catch (closeError) {
          this.emit("DebugLog", {
            type: "common",
            text: `douyin ${this.channelId} danma close after connect error: ${formatUnknownError(closeError)}`,
          });
        }
      }
      releaseAcquiredDouyinCookie();
      throw error;
    }
  };
  const rotateDouyinCookieAndHostAfterDanmaFailure = async () => {
    if (isDanmaStopped) {
      return false;
    }
    if (!shouldManageDouyinDanmaRecovery) {
      return false;
    }
    // 换号前探针 B（30s 限流 + shouldProbe）
    await runProbeBBeforeSwitch();
    const previousClient = activeDanmaClient;
    const candidate = findNextDanmaRecoveryCandidate();
    if (!candidate) {
      return false;
    }
    if (previousClient) {
      try {
        closeDanmaClient(previousClient);
      } catch (error) {
        this.emit("DebugLog", {
          type: "common",
          text: `douyin ${this.channelId} previous danma close error: ${formatUnknownError(error)}`,
        });
        return false;
      }
    }
    activeDouyinCookieAccountIndex = candidate.accountIndex;
    activeDouyinDanmaHostIndex = candidate.hostIndex;
    ensureActiveDouyinCookieAcquired();
    applyActiveDouyinCookieRemark();
    // 换号成功：新账号 auth-fail 计数保持独立；旧号若未达阈值保留计数
    const remark =
      getActiveDouyinCookieAccount()?.remark?.trim() ||
      (getActiveDouyinCookie() ? "未命名账号" : "无 Cookie 降级");
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma switch cookie account and host: ${remark}, ${getActiveDouyinDanmaHost()}`,
    });
    startDanmaClient();
    return true;
  };

  const handleDanmaReconnect = (attempts: number) => {
    this.appendTimeline({ text: `弹幕连接断开，正在重试: ${attempts}` });
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma has reconnect ${attempts}`,
    });
  };
  const handleDanmaError = (client: DouYinDanmaClient, err: Error) => {
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma error: ${String(err)}`,
    });
    if (client !== activeDanmaClient) {
      return;
    }
    // 探针 A 挂点：鉴权失败累计；非鉴权不升级；不全局熔断
    applyProbeAOnDanmaAuthFailure(err);
    void rotateDouyinCookieAndHostAfterDanmaFailure();
  };
  const handleDanmaInit = (url: string) => {
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma init ${url}`,
    });
  };
  const handleDanmaOpen = (client: DouYinDanmaClient) => {
    if (client !== activeDanmaClient) {
      return;
    }
    // 成功路径：重置当前账号连续鉴权失败计数
    resetAuthFailForAccount(getActiveDouyinCookieAccount()?.id);
    this.appendTimeline({ text: `弹幕连接已建立` });
    this.emit("DebugLog", {
      type: "common",
      text: `douyin ${this.channelId} danma open`,
    });
  };
  const handleDanmaClose = (client: DouYinDanmaClient) => {
    this.emit("DebugLog", {
      type: "common",
      text: `douyin danma close`,
    });
    if (ignoredDanmaCloseClients.delete(client) || client !== activeDanmaClient) {
      return;
    }
    // close 无可靠鉴权分类时不 mark；仅换号恢复
    rotateDouyinCookieAndHostAfterDanmaFailure();
  };

  // client.on("open", () => {
  //   console.log("open");
  // });
  // client.on("close", () => {
  //   console.log("close");
  // });
  // client.on("error", (err) => {
  //   console.log("error", err);
  // });
  // client.on("heartbeat", () => {
  //   // console.log("heartbeat");
  // });

  if (!this.disableProvideCommentsWhenRecording) {
    startDanmaClient();
  }

  const downloaderArgs = downloader.getArguments();
  try {
    downloader.run();
  } catch (error) {
    const danmaClient = activeDanmaClient;
    activeDanmaClient = undefined;
    if (danmaClient) {
      try {
        closeDanmaClient(danmaClient);
      } catch (closeError) {
        this.emit("DebugLog", {
          type: "common",
          text: `douyin ${this.channelId} danma close after downloader start error: ${formatUnknownError(closeError)}`,
        });
      }
    }
    releaseAcquiredDouyinCookie();
    throw error;
  }

  const cut = utils.singleton<RecordHandle["cut"]>(async () => {
    if (!this.recordHandle) return;
    downloader.cut();
  });

  const stop = singleton<RecordHandle["stop"]>(async (reason?: string) => {
    if (!this.recordHandle) return;
    this.emit("stateChange", { state: "stopping-record" });

    try {
      // 清理所有礼物缓存定时器
      for (const [_groupId, cached] of giftMessageCache.entries()) {
        clearTimeout(cached.timer);
        // 立即添加剩余的礼物消息
        const extraDataController = downloader.getExtraDataController();
        if (extraDataController) {
          this.emit("Message", cached.gift);
          extraDataController.addMessage(cached.gift);
        }
      }
      giftMessageCache.clear();

      isDanmaStopped = true;
      const danmaClient = activeDanmaClient;
      activeDanmaClient = undefined;
      if (danmaClient) {
        try {
          closeDanmaClient(danmaClient);
        } catch (error) {
          this.emit("DebugLog", {
            type: "common",
            text: `stop danma client error: ${formatUnknownError(error)}`,
          });
        }
      }
      releaseAcquiredDouyinCookie();
      await downloader.stop();
    } catch (err) {
      this.emit("DebugLog", {
        type: "common",
        text: `stop record error: ${String(err)}`,
      });
    }
    this.usedStream = undefined;
    this.usedSource = undefined;
    this.emit("RecordStop", { recordHandle: this.recordHandle, reason });
    this.recordHandle = undefined;
    this.liveInfo = undefined;
    this.emit("stateChange", { state: "idle" });
    this.cache.set("qualityRetryLeft", this.qualityRetry);
  });

  this.recordHandle = {
    id: genRecordUUID(),
    stream: stream.name,
    source: stream.source,
    recorderType: downloader.type,
    url: stream.url,
    downloaderArgs,
    savePath: downloader.videoFilePath,
    stop,
    cut,
  };
  this.emit("RecordStart", this.recordHandle);

  return this.recordHandle;
};

export const provider: RecorderProvider<{}> = {
  id: "DouYin",
  name: "抖音",
  siteURL: "https://live.douyin.com/",

  matchURL(channelURL) {
    // 支持 v.douyin.com 和 live.douyin.com
    return /https?:\/\/(live|v|www)\.douyin\.com\//.test(channelURL);
  },

  async resolveChannelInfoFromURL(channelURL) {
    if (!this.matchURL(channelURL)) return null;

    let id: string;
    if (channelURL.includes("v.douyin.com")) {
      // 处理短链接
      try {
        id = await resolveShortURL(channelURL);
      } catch (err: any) {
        throw new Error(`解析抖音短链接失败: ${err?.message}`);
      }
    } else if (channelURL.includes("/user/")) {
      // 解析用户主页
      id = await parseUser(channelURL);
      if (!id) {
        throw new Error(`解析抖音用户主页失败`);
      }
    } else {
      // 处理常规直播链接
      id = path.basename(new URL(channelURL).pathname);
    }
    const info = await getInfo(id);

    return {
      id: info.roomId,
      title: info.title,
      owner: info.owner,
      avatar: info.avatar,
      uid: info.uid,
    };
  },

  createRecorder(opts) {
    return createRecorder({ providerId: provider.id, ...opts });
  },

  fromJSON(recorder) {
    return defaultFromJSON(this, recorder);
  },

  setFFMPEGOutputArgs(args) {
    ffmpegOutputOptions.splice(0, ffmpegOutputOptions.length, ...args);
  },
};
