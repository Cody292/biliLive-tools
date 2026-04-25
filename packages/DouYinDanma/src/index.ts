import WebSocket from "ws";
import { TypedEmitter } from "tiny-typed-emitter";

import { decompressGzip, getXMsStub, getSignature, getUserUniqueId } from "./utils.js";
import protobuf from "./proto.js";
import { getCookie } from "./api.js";
import { ABogus } from "./abogus.js";

import type {
  ChatMessage,
  MemberMessage,
  LikeMessage,
  SocialMessage,
  GiftMessage,
  RoomUserSeqMessage,
  RoomStatsMessage,
  RoomRankMessage,
  Message,
  PrivilegeScreenChatMessage,
  ScreenChatMessage,
} from "../types/types.js";

type DouyinProtoModule = {
  douyin: {
    PushFrame: {
      decode(data: Buffer): any;
      create(data: Record<string, unknown>): any;
      encode(data: unknown): { finish(): Buffer };
    };
    Response: {
      decode(data: unknown): any;
    };
    ChatMessage: { decode(data: unknown): { toJSON(): unknown } };
    RoomUserSeqMessage: { decode(data: unknown): { toJSON(): unknown } };
    MemberMessage: { decode(data: unknown): { toJSON(): unknown } };
    GiftMessage: { decode(data: unknown): { toJSON(): unknown } };
    LikeMessage: { decode(data: unknown): { toJSON(): unknown } };
    SocialMessage: { decode(data: unknown): { toJSON(): unknown } };
    RoomStatsMessage: { decode(data: unknown): { toJSON(): unknown } };
    RoomRankMessage: { decode(data: unknown): { toJSON(): unknown } };
    PrivilegeScreenChatMessage: { decode(data: unknown): { toJSON(): unknown } };
    ScreenChatMessage: { decode(data: unknown): { toJSON(): unknown } };
  };
};



interface Events {
  init: (url: string) => void;
  open: () => void;
  close: () => void;
  reconnect: (count: number) => void;
  heartbeat: () => void;
  error: (error: Error) => void;
  chat: (message: ChatMessage) => void;
  member: (message: MemberMessage) => void;
  like: (message: LikeMessage) => void;
  social: (message: SocialMessage) => void;
  gift: (message: GiftMessage) => void;
  roomUserSeq: (message: RoomUserSeqMessage) => void;
  roomStats: (message: RoomStatsMessage) => void;
  roomRank: (message: RoomRankMessage) => void;
  privilegeScreenChat: (message: PrivilegeScreenChatMessage) => void;
  screenChat: (message: ScreenChatMessage) => void;
  message: (message: Message) => void;
}

class DouYinDanmaClient extends TypedEmitter<Events> {
  private ws!: WebSocket;
  private roomId: string;
  private heartbeatInterval: number;
  private heartbeatTimer!: NodeJS.Timeout;
  private isHeartbeatRunning: boolean = false;
  private autoStart: boolean;
  private autoReconnect: number;
  private reconnectAttempts: number;
  private reconnectInterval: number;
  private cookie?: string;
  private timeoutInterval: number;
  private lastMessageTime: number;
  private timeoutTimer!: NodeJS.Timeout;
  private isTimeoutCheckRunning: boolean = false;
  private isReconnecting: boolean = false;
  private host: string;
  private readonly defaultHost: string;
  private readonly userAgent: string;

  constructor(
    roomId: string,
    options: {
      autoStart?: boolean;
      autoReconnect?: number;
      heartbeatInterval?: number;
      reconnectInterval?: number;
      cookie?: string;
      timeoutInterval?: number;
      host?: string;
    } = {},
  ) {
    super();
    this.roomId = roomId;
    this.heartbeatInterval = options.heartbeatInterval ?? 10000;
    this.autoStart = options.autoStart ?? false;
    this.autoReconnect = options.autoReconnect ?? 10;
    this.reconnectAttempts = 0;
    this.reconnectInterval = options.reconnectInterval ?? 10000;
    this.cookie = options.cookie;
    this.timeoutInterval = options.timeoutInterval ?? 100000; // 默认100秒
    this.lastMessageTime = Date.now();
    this.defaultHost = "webcast100-ws-web-hl.douyin.com";
    this.host = options.host ?? this.defaultHost;
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

    if (this.autoStart) {
      this.connect();
    }
  }

  async connect() {
    const url = await this.getWsInfo(this.roomId);
    if (!url) {
      this.emit("error", new Error("获取抖音弹幕签名失败"));
      return;
    }
    this.emit("init", url);
    const cookies = this.cookie || (await getCookie());
    this.ws = new WebSocket(url, {
      headers: {
        Cookie: cookies,
        "User-Agent": this.userAgent,
        Origin: "https://live.douyin.com",
        Referer: "https://live.douyin.com/",
      },
    });

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.emit("open");
      this.startHeartbeat();
      this.startTimeoutCheck();
    });

    this.ws.on("message", (data) => {
      this.lastMessageTime = Date.now();
      this.decode(data as Buffer);
    });

    this.ws.on("close", () => {
      this.emit("close");
      this.reconnect();
    });

    this.ws.on("error", (error) => {
      this.emit("error", error);
      this.reconnect();
    });
  }

  send(data: any) {
    if (!this.ws) {
      return;
    }
    this.ws.send(data);
  }

  close() {
    if (!this.ws) {
      return;
    }
    this.reconnectAttempts = this.autoReconnect;
    this.stopHeartbeat();
    this.stopTimeoutCheck();

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  private startHeartbeat() {
    if (this.isHeartbeatRunning) {
      return;
    }

    this.stopHeartbeat();
    this.isHeartbeatRunning = true;

    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.emit("heartbeat");
        this.send(":\x02hb");
      } else {
        console.log("连接未就绪，当前状态:", this.ws.readyState);
      }
    }, this.heartbeatInterval);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.isHeartbeatRunning = false;
    }
  }

  private startTimeoutCheck() {
    if (this.isTimeoutCheckRunning) {
      return;
    }

    this.stopTimeoutCheck();
    this.isTimeoutCheckRunning = true;

    // 重置最后消息时间，给连接一些初始化时间
    this.lastMessageTime = Date.now();
    this.timeoutTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastMessageTime > this.timeoutInterval) {
        console.log("No message received for too long, reconnecting...");
        // 在重连前重置时间，避免立即触发下一次重连
        this.lastMessageTime = now;
        this.reconnect();
      }
    }, 1000);
  }

  private stopTimeoutCheck() {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.isTimeoutCheckRunning = false;
    }
  }

  private reconnect() {
    if (this.isReconnecting) {
      return;
    }

    this.stopHeartbeat();
    this.stopTimeoutCheck();

    if (this.reconnectAttempts < this.autoReconnect) {
      this.isReconnecting = true;
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect();
        this.isReconnecting = false;
        this.emit("reconnect", this.reconnectAttempts);
      }, this.reconnectInterval);
    }
  }

  async handleMessage() {}

  /**
   * 处理弹幕消息
   */
  async handleChatMessage(chatMessage: ChatMessage) {
    this.emit("chat", chatMessage);
    this.emit("message", chatMessage);
  }

  /**
   * 处理进入房间
   */
  async handleEnterRoomMessage(message: MemberMessage) {
    this.emit("member", message);
    this.emit("message", message);
  }

  /**
   * 处理礼物消息
   */
  async handleGiftMessage(message: GiftMessage) {
    this.emit("gift", message);
    this.emit("message", message);
  }

  /**
   * 处理点赞消息
   */
  async handleLikeMessage(message: LikeMessage) {
    this.emit("like", message);
    this.emit("message", message);
  }

  /**
   * 处理social消息
   */
  async handleSocialMessage(message: SocialMessage) {
    this.emit("social", message);
    this.emit("message", message);
  }

  /**
   * 处理RoomUserSeqMessage
   */
  async handleRoomUserSeqMessage(message: RoomUserSeqMessage) {
    this.emit("roomUserSeq", message);
    this.emit("message", message);
  }

  /**
   * 处理 WebcastRoomStatsMessage
   */
  async handleRoomStatsMessage(message: RoomStatsMessage) {
    this.emit("roomStats", message);
    this.emit("message", message);
  }

  /**
   * 处理 WebcastRoomRankMessage
   */
  async handleRoomRankMessage(message: RoomRankMessage) {
    this.emit("roomRank", message);
    this.emit("message", message);
  }

  async handlePrivilegeScreenChatMessage(message: PrivilegeScreenChatMessage) {
    this.emit("privilegeScreenChat", message);
    this.emit("message", message);
  }

  async handleScreenChatMessage(message: ScreenChatMessage) {
    this.emit("screenChat", message);
    this.emit("message", message);
  }

  /**
   * 处理其他消息
   */
  async handleOtherMessage(message: any) {
    this.emit("message", message);
  }

  async decode(data: Buffer) {
    const douyinProto = protobuf as DouyinProtoModule;
    const PushFrame = douyinProto.douyin.PushFrame;
    const Response = douyinProto.douyin.Response;
    const ChatMessage = douyinProto.douyin.ChatMessage;
    const RoomUserSeqMessage = douyinProto.douyin.RoomUserSeqMessage;
    const MemberMessage = douyinProto.douyin.MemberMessage;
    const GiftMessage = douyinProto.douyin.GiftMessage;
    const LikeMessage = douyinProto.douyin.LikeMessage;
    const SocialMessage = douyinProto.douyin.SocialMessage;
    const RoomStatsMessage = douyinProto.douyin.RoomStatsMessage;
    const RoomRankMessage = douyinProto.douyin.RoomRankMessage;
    const PrivilegeScreenChatMessage = douyinProto.douyin.PrivilegeScreenChatMessage;
    const ScreenChatMessage = douyinProto.douyin.ScreenChatMessage;
    const wssPackage = PushFrame.decode(data);

    // @ts-ignore
    const logId = wssPackage.logId;

    let decompressed: unknown;
    try {
      // @ts-ignore
      if (wssPackage.payload instanceof Buffer) {
        // @ts-ignore
        decompressed = await decompressGzip(wssPackage.payload);
      } else {
        return;
      }
    } catch (e) {
      this.emit("error", e as Error);
      return;
    }

    const payloadPackage = Response.decode(decompressed);
    this.updateHostFromPushServer((payloadPackage as { pushServer?: string }).pushServer);

    let ack: Buffer | null = null;
    // @ts-ignore
    if (payloadPackage.needAck) {
      const obj = PushFrame.create({
        logId: logId,
        // @ts-ignore
        payloadType: payloadPackage.internalExt,
      });
      ack = PushFrame.encode(obj).finish();
    }

    const msgs: any[] = [];
    // @ts-ignore
    for (const msg of payloadPackage.messagesList) {
      // const now = new Date();
      try {
        if (msg.method === "WebcastChatMessage") {
          const chatMessage = ChatMessage.decode(msg.payload);
          this.handleChatMessage(chatMessage.toJSON() as ChatMessage);
        } else if (msg.method === "WebcastMemberMessage") {
          const memberMessage = MemberMessage.decode(msg.payload);
          this.handleEnterRoomMessage(memberMessage.toJSON() as MemberMessage);
        } else if (msg.method === "WebcastGiftMessage") {
          const giftMessage = GiftMessage.decode(msg.payload);
          this.handleGiftMessage(giftMessage.toJSON() as GiftMessage);
        } else if (msg.method === "WebcastLikeMessage") {
          const message = LikeMessage.decode(msg.payload);
          this.handleLikeMessage(message.toJSON() as LikeMessage);
        } else if (msg.method === "WebcastSocialMessage") {
          const message = SocialMessage.decode(msg.payload);
          this.handleSocialMessage(message.toJSON() as SocialMessage);
        } else if (msg.method === "WebcastRoomUserSeqMessage") {
          const message = RoomUserSeqMessage.decode(msg.payload);
          this.handleRoomUserSeqMessage(message.toJSON() as RoomUserSeqMessage);
        } else if (msg.method === "WebcastRoomStatsMessage") {
          const message = RoomStatsMessage.decode(msg.payload);
          this.handleRoomStatsMessage(message.toJSON() as RoomStatsMessage);
        } else if (msg.method === "WebcastRoomRankMessage") {
          const message = RoomRankMessage.decode(msg.payload);
          this.handleRoomRankMessage(message.toJSON() as RoomRankMessage);
        } else if (msg.method === "WebcastPrivilegeScreenChatMessage") {
          const message = PrivilegeScreenChatMessage.decode(msg.payload);
          this.handlePrivilegeScreenChatMessage(message.toJSON() as PrivilegeScreenChatMessage);
        } else if (msg.method === "WebcastScreenChatMessage") {
          const message = ScreenChatMessage.decode(msg.payload);
          this.handleScreenChatMessage(message.toJSON() as ScreenChatMessage);
        } else {
          // WebcastRanklistHourEntranceMessage,WebcastInRoomBannerMessage,WebcastRoomStreamAdaptationMessage
        }
      } catch (e) {
        console.error("error:", e, msg);
      }
    }
    if (ack) {
      this.send(ack);
    }
    return [msgs, ack];
  }
  private getResolvedHost(pushServer?: string): string {
    const normalized = pushServer?.trim();
    if (!normalized) {
      return this.host;
    }

    if (normalized.startsWith("ws://") || normalized.startsWith("wss://")) {
      return new URL(normalized).host;
    }

    if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
      return new URL(normalized).host;
    }

    return normalized;
  }

  private updateHostFromPushServer(pushServer?: string) {
    const resolvedHost = this.getResolvedHost(pushServer);
    if (resolvedHost) {
      this.host = resolvedHost;
    }
  }

  async getWsInfo(roomId: string): Promise<string | undefined> {
    const userUniqueId = getUserUniqueId();
    // const userUniqueId = "7877922945687137703";
    const versionCode = 180800;
    const webcastSdkVersion = "1.0.15";

    const sigParams = {
      live_id: "1",
      aid: "6383",
      version_code: versionCode,
      webcast_sdk_version: webcastSdkVersion,
      room_id: roomId,
      sub_room_id: "",
      sub_channel_id: "",
      did_rule: "3",
      user_unique_id: userUniqueId,
      device_platform: "web",
      device_type: "",
      ac: "",
      identity: "audience",
    };

    let signature: string;
    try {
      const m = getXMsStub(sigParams);
      signature = getSignature(m);
    } catch {
      return;
    }

    const baseParams: Record<string, string> = {
      app_name: "douyin_web",
      room_id: roomId,
      compress: "gzip",
      version_code: String(versionCode),
      webcast_sdk_version: webcastSdkVersion,
      update_version_code: webcastSdkVersion,
      live_id: "1",
      did_rule: "3",
      user_unique_id: userUniqueId,
      identity: "audience",
      device_platform: "web",
      cookie_enabled: "true",
      screen_width: "1920",
      screen_height: "1080",
      browser_language: "zh-CN",
      browser_platform: "Win32",
      browser_name: "Mozilla",
      browser_version: this.userAgent,
      browser_online: "true",
      tz_name: "Etc/GMT-8",
      host: "https://live.douyin.com",
      aid: "6383",
      endpoint: "live_pc",
      support_wrds: "1",
      im_path: "/webcast/im/fetch/",
      need_persist_msg_count: "15",
      heartbeatDuration: "0",
      signature: signature.toString(),
    };

    const abogus = new ABogus(undefined, this.userAgent);
    const [finalQuery] = abogus.generateAbogus(new URLSearchParams(baseParams).toString(), "");

    const resolvedHost = this.host || this.defaultHost;
    const wssUrl = `wss://${resolvedHost}/webcast/im/push/v2/?${finalQuery}`;
    return wssUrl;
  }
}

export default DouYinDanmaClient;
