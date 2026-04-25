import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import DouYinDanmaClient from "../src/index.js";

describe("DouYinDanma regressions", () => {
  it("loads proto definitions in ESM", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "douyin-proto-esm-"));
    const runnerPath = path.join(tempDir, "runner.mjs");

    try {
      await writeFile(
        runnerPath,
        `import proto from ${JSON.stringify(new URL("../src/proto.js", import.meta.url).href)};\nconsole.log(Boolean(proto?.douyin?.Response));\n`,
      );

      const { stdout, status, stderr } = await import("node:child_process").then(({ spawnSync }) =>
        spawnSync(process.execPath, [runnerPath], {
          encoding: "utf-8",
        }),
      );

      expect(status, stderr).toBe(0);
      expect(stdout.trim()).toBe("true");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("adds a_bogus to websocket query while keeping Windows browser parameters", async () => {
    const client = new DouYinDanmaClient("7632464326451874560", { autoReconnect: 0 });

    const url = await client.getWsInfo("7632464326451874560");

    expect(url).toBeDefined();

    const parsed = new URL(url!);
    expect(parsed.searchParams.get("a_bogus")).toBeTruthy();
    expect(parsed.searchParams.get("browser_platform")).toBe("Win32");
    expect(parsed.searchParams.get("browser_language")).toBe("zh-CN");
    expect(parsed.searchParams.get("browser_version")).toContain("Windows NT 10.0");
    expect(parsed.searchParams.get("browser_version")).not.toContain("HeadlessChrome");
  });

  it("prefers runtime host over default fallback", async () => {
    const client = new DouYinDanmaClient("7632464326451874560", {
      autoReconnect: 0,
      host: "runtime-host.douyin.test",
    });

    const url = await client.getWsInfo("7632464326451874560");

    expect(url).toContain("wss://runtime-host.douyin.test/webcast/im/push/v2/");
  });

  it("updates host from server pushServer for subsequent reconnects", async () => {
    const client = new DouYinDanmaClient("7632464326451874560", { autoReconnect: 0 });

    const updateHostFromPushServer = Reflect.get(client, "updateHostFromPushServer") as
      | ((pushServer?: string) => void)
      | undefined;

    expect(updateHostFromPushServer).toBeTypeOf("function");
    updateHostFromPushServer?.call(client, "wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/");

    const url = await client.getWsInfo("7632464326451874560");

    expect(url).toContain("wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/");
  });
});
