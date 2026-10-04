import { describe, it, expect, vi } from "vitest";
import { requestStreamWithDouyuFailover } from "./cookieFailover.js";

describe("requestStreamWithDouyuFailover", () => {
  it("off: request 被叫 1 次，auth 原样；request 抛则抛，不再试", async () => {
    const error = new Error("stream error");
    const request = vi.fn().mockRejectedValue(error);

    await expect(
      requestStreamWithDouyuFailover(
        {
          mode: "off",
          auth: "raw_auth_cookie",
          candidates: [
            { uid: 1, cookie: "c1" },
            { uid: 2, cookie: "c2" },
          ],
        },
        request,
      ),
    ).rejects.toThrow("stream error");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("raw_auth_cookie");
  });

  it("always 无 candidates: 只 request 1 次", async () => {
    const request = vi.fn().mockResolvedValue("stream_data");

    const result = await requestStreamWithDouyuFailover(
      {
        mode: "always",
        auth: "default_auth",
      },
      request,
    );

    expect(result).toBe("stream_data");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("default_auth");

    const requestEmpty = vi.fn().mockResolvedValue("stream_empty");
    const resultEmpty = await requestStreamWithDouyuFailover(
      {
        mode: "always",
        auth: "default_auth",
        candidates: [],
      },
      requestEmpty,
    );
    expect(resultEmpty).toBe("stream_empty");
    expect(requestEmpty).toHaveBeenCalledTimes(1);
    expect(requestEmpty).toHaveBeenCalledWith("default_auth");
  });

  it("always 三候选，auth 匹配第 2 个：先 2 失败再 1 成功（顺序：匹配的先，然后原数组里剩余：1 然后 3）", async () => {
    const callOrder: string[] = [];
    const request = vi.fn().mockImplementation(async (cookie: string) => {
      callOrder.push(cookie);
      if (cookie === "c2") {
        throw new Error("fail on c2");
      }
      if (cookie === "c1") {
        return "success_c1";
      }
      throw new Error("fail on other");
    });

    const candidates = [
      { uid: 101, cookie: "c1" },
      { uid: 102, cookie: "c2" },
      { uid: 103, cookie: "c3" },
    ];

    const result = await requestStreamWithDouyuFailover(
      {
        mode: "always",
        auth: "c2",
        candidates,
      },
      request,
    );

    expect(result).toBe("success_c1");
    expect(request).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["c2", "c1"]);
  });

  it("always 全失败：调用次数=候选数，抛最后错误", async () => {
    const callOrder: string[] = [];
    const request = vi.fn().mockImplementation(async (cookie: string) => {
      callOrder.push(cookie);
      throw new Error(`err_${cookie}`);
    });

    const candidates = [
      { uid: 101, cookie: "c1" },
      { uid: 102, cookie: "c2" },
      { uid: 103, cookie: "c3" },
    ];

    await expect(
      requestStreamWithDouyuFailover(
        {
          mode: "always",
          auth: "c2",
          candidates,
        },
        request,
      ),
    ).rejects.toThrow("err_c3");

    expect(request).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual(["c2", "c1", "c3"]);
  });

  it("always auth 不在候选：从候选[0]开始按数组序", async () => {
    const callOrder: string[] = [];
    const request = vi.fn().mockImplementation(async (cookie: string) => {
      callOrder.push(cookie);
      if (cookie === "c1") {
        throw new Error("fail on c1");
      }
      if (cookie === "c2") {
        return "success_c2";
      }
      throw new Error("fail on c3");
    });

    const candidates = [
      { uid: 101, cookie: "c1" },
      { uid: 102, cookie: "c2" },
      { uid: 103, cookie: "c3" },
    ];

    const result = await requestStreamWithDouyuFailover(
      {
        mode: "always",
        auth: "orphan_auth",
        candidates,
      },
      request,
    );

    expect(result).toBe("success_c2");
    expect(request).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["c1", "c2"]);
  });
});
