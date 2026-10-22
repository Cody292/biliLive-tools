/**
 * 共享 FFmpeg 进程槽位。
 * 只计数真正占用 ffmpeg 进程的调用；与 TaskQueue 的 running 计数互斥使用。
 */
export type FFmpegMaxNumReader = () => number;

export type FFmpegSlot = {
  readonly release: () => void;
};

export type FfmpegCommandRunOptions = {
  readonly timeoutMs?: number;
};

export type FfmpegCommandRunner = (
  bin: string,
  args: readonly string[],
  options?: FfmpegCommandRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

type Waiter = {
  readonly resolve: (slot: FFmpegSlot) => void;
};

export function parseFfmpegMaxNum(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }
  return Math.trunc(value);
}

export class FFmpegProcessGate {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly readMaxNum: FFmpegMaxNumReader;
  onAvailable?: () => void;

  constructor(readMaxNum: FFmpegMaxNumReader) {
    this.readMaxNum = readMaxNum;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  /**
   * 非阻塞预约。已有 FIFO 等待者时不插队，避免饿死 acquire()。
   */
  tryAcquire(): FFmpegSlot | undefined {
    if (this.waiters.length > 0) {
      return undefined;
    }
    return this.grantIfCapacity();
  }

  acquire(): Promise<FFmpegSlot> {
    const immediate = this.waiters.length === 0 ? this.grantIfCapacity() : undefined;
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  release(slot: FFmpegSlot): void {
    slot.release();
  }

  notifyConfigChanged(): void {
    this.flushWaiters();
    if (this.hasCapacity()) {
      this.onAvailable?.();
    }
  }

  private grantIfCapacity(): FFmpegSlot | undefined {
    if (!this.hasCapacity()) {
      return undefined;
    }
    return this.takeSlot();
  }

  private hasCapacity(): boolean {
    const max = this.readMaxNum();
    if (max < 0) {
      return true;
    }
    return this.active < max;
  }

  private takeSlot(): FFmpegSlot {
    this.active += 1;
    let open = true;
    const slot: FFmpegSlot = {
      release: () => {
        if (!open) {
          return;
        }
        open = false;
        this.active -= 1;
        this.flushWaiters();
        if (this.hasCapacity()) {
          this.onAvailable?.();
        }
      },
    };
    return slot;
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0 && this.hasCapacity()) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        break;
      }
      waiter.resolve(this.takeSlot());
    }
  }
}

export function bindFfmpegCommandRunner(
  gate: Pick<FFmpegProcessGate, "acquire">,
  ffmpegPath: string,
  run: FfmpegCommandRunner,
): FfmpegCommandRunner {
  return async (bin, args, options) => {
    if (bin !== ffmpegPath) {
      return run(bin, args, options);
    }
    const slot = await gate.acquire();
    try {
      return await run(bin, args, options);
    } finally {
      slot.release();
    }
  };
}
