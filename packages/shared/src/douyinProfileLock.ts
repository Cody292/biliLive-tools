import fs from "node:fs/promises";
import path from "node:path";

/** Profile 目录内锁文件名 */
export const PROFILE_LOCK_FILENAME = ".profile.lock";

/** 获取锁超时 */
export class ProfileLockTimeoutError extends Error {
  readonly code = "PROFILE_LOCK_TIMEOUT" as const;

  constructor(
    public readonly lockPath: string,
    public readonly timeoutMs: number,
  ) {
    super(`profile lock timeout after ${timeoutMs}ms: ${lockPath}`);
    this.name = "ProfileLockTimeoutError";
  }
}

/** 可注入的锁文件系统抽象（单测用） */
export type ProfileLockFs = {
  openExclusive: (lockPath: string) => Promise<void>;
  remove: (lockPath: string) => Promise<void>;
};

export type ProfileLockHandle = {
  /** 锁文件路径 */
  lockPath: string;
  /** 释放锁；幂等，可安全放在 finally */
  release: () => Promise<void>;
};

export type AcquireProfileLockOptions = {
  profileDir: string;
  /** 等待超时（ms） */
  timeoutMs: number;
  /** 轮询间隔（ms），默认 50 */
  pollIntervalMs?: number;
  /** 可注入 fs */
  fs?: ProfileLockFs;
};

const defaultFs: ProfileLockFs = {
  async openExclusive(lockPath: string): Promise<void> {
    // wx: 排他创建，已存在则 EEXIST
    const handle = await fs.open(lockPath, "wx");
    await handle.close();
  },
  async remove(lockPath: string): Promise<void> {
    try {
      await fs.unlink(lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw err;
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "EAGAIN" || code === "EBUSY";
}

/**
 * 在 profile 目录内获取 flock 风格排他锁（文件存在即占用）。
 * 超时抛 ProfileLockTimeoutError；调用方应在 finally 中 release。
 */
export async function acquireProfileLock(
  options: AcquireProfileLockOptions,
): Promise<ProfileLockHandle> {
  const {
    profileDir,
    timeoutMs,
    pollIntervalMs = 50,
    fs: lockFs = defaultFs,
  } = options;
  const lockPath = path.join(profileDir, PROFILE_LOCK_FILENAME);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await lockFs.openExclusive(lockPath);
      let released = false;
      return {
        lockPath,
        async release() {
          if (released) return;
          released = true;
          await lockFs.remove(lockPath);
        },
      };
    } catch (err) {
      if (!isBusyError(err)) throw err;
      if (Date.now() >= deadline) {
        throw new ProfileLockTimeoutError(lockPath, timeoutMs);
      }
      const remaining = deadline - Date.now();
      await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
    }
  }
}
