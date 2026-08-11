import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { defaultsDeep, get, cloneDeep } from "lodash-es";
import { TypedEmitter } from "tiny-typed-emitter";
import { APP_DEFAULT_CONFIG } from "./enum.js";
import log from "./utils/log.js";
import {
  bindHealthPersistHost,
  flushHealthPersist,
  scheduleHealthAccountPatch,
} from "./douyinHealthPersist.js";

import type { AppConfig as AppConfigType, DeepPartial } from "@biliLive-tools/types";

interface ConfigEvents {
  /** 更新配置时触发 */
  update: (newData: any, oldData: any) => void;
}

export default class Config extends TypedEmitter<ConfigEvents> {
  filepath: string;
  data: {
    [propName: string]: any;
  };
  constructor() {
    super();
    this.filepath = "";
    this.data = {};
  }
  set(key: string | number, value: any) {
    this.read();
    const oldData = cloneDeep(this.data);
    this.data[key] = value;
    this.save();
    this.emit("update", this.data, oldData);
  }
  setAll(data: { [propName: string]: any }) {
    const oldData = this.read();
    this.data = data;
    this.save();
    this.emit("update", this.data, oldData);
  }
  get(key: string | number) {
    this.read();
    return this.data[key];
  }
  save() {
    // 保存文件
    fs.writeFileSync(this.filepath, JSON.stringify(this.data));
  }
  load(filepath: string) {
    this.filepath = filepath;
  }
  init(filepath: string, initData: { [propName: string]: any } = {}) {
    this.filepath = filepath;
    if (!fs.existsSync(this.filepath)) {
      this.data = initData;
    } else {
      try {
        this.read();
        this.data = defaultsDeep(this.data, initData);
      } catch (e) {
        this.data = initData;
        log.error(e);
        log.error("读取配置文件失败，初始化配置");
      }
    }
    this.save();
  }
  clear() {
    // 清空文件
    this.data = {};
    this.save();
  }
  read() {
    // 读取文件
    this.data = JSON.parse(fs.readFileSync(this.filepath, "utf-8"));
    return this.data;
  }
}

export class AppConfig extends Config {
  declare data: AppConfigType;
  constructor(configPath?: string) {
    super();
    this.bindHealthPersist();
    if (configPath) {
      this.load(configPath);
    }
  }

  private bindHealthPersist() {
    bindHealthPersistHost({
      getData: () => this.data as unknown as Record<string, unknown>,
      save: () => {
        // 必须 super.save：AppConfig.set/get 会 flush，直接 this.save 会死循环
        super.save();
      },
    });
    // DouYinRecorder 探针 A → 防抖写盘（避免 DouYinRecorder 静态依赖 shared 包循环）
    // 探针 B setDouyinProbeOnce 在 http serverStart 注入（shared 不能依赖 http）
    void import("@bililive-tools/douyin-recorder")
      .then((mod) => {
        const setScheduler = (
          mod as {
            setDouyinHealthPatchScheduler?: (
              fn: ((input: { accountId: string; patch: unknown }) => void) | null,
            ) => void;
          }
        ).setDouyinHealthPatchScheduler;
        setScheduler?.((input) => {
          scheduleHealthAccountPatch({
            accountId: input.accountId,
            patch: input.patch as Parameters<typeof scheduleHealthAccountPatch>[0]["patch"],
          });
        });
      })
      .catch(() => {
        // best-effort：未装 recorder 时跳过
      });
  }

  load(filepath: string) {
    this.init(filepath);
  }
  // 需要传递：{ffmpegPath:"",ffprobePath:"",tool:{download:{savePath:""}}}
  init(filepath: string, data: DeepPartial<AppConfigType> = {}) {
    APP_DEFAULT_CONFIG.tool.download.savePath = path.join(os.homedir(), "Downloads");
    APP_DEFAULT_CONFIG.recorder.savePath = path.join(os.homedir(), "Downloads");
    APP_DEFAULT_CONFIG.video.subSavePath = path.join(os.homedir(), "Downloads");

    const isDocker = process.env.IS_DOCKER;
    if (isDocker) {
      APP_DEFAULT_CONFIG.tool.download.savePath = path.join("/app", "video");
      APP_DEFAULT_CONFIG.recorder.savePath = path.join("/app", "video");
      APP_DEFAULT_CONFIG.video.subSavePath = path.join("/app", "video");
      APP_DEFAULT_CONFIG.sync.baiduPCS.execPath = "/app/bin/BaiduPCS-Go";
      APP_DEFAULT_CONFIG.sync.aliyunpan.execPath = "/app/bin/aliyunpan";
    }
    // 16位随机密码，包含大小写字母和数字
    APP_DEFAULT_CONFIG.passKey = Math.random().toString(36).slice(-16);

    const initData = defaultsDeep(data, APP_DEFAULT_CONFIG);
    super.init(filepath, initData);
  }
  get<K extends keyof AppConfigType>(key: K): AppConfigType[K] {
    flushHealthPersist();
    return super.get(key);
  }
  // 使用lodash的get方法，保留type
  getDeep<TPath extends string>(path: TPath): ReturnType<typeof get> {
    return get(this.data, path);
  }
  set<K extends keyof AppConfigType>(key: K, value: AppConfigType[K]) {
    flushHealthPersist();
    return super.set(key, value);
  }
  setAll(newConfig: AppConfigType) {
    flushHealthPersist();
    return super.setAll(newConfig);
  }
  getAll() {
    flushHealthPersist();
    const data = this.read() as AppConfigType;
    return data;
  }
}

export const appConfig = new AppConfig();
