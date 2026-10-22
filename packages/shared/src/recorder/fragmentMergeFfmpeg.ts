import { spawn } from "node:child_process";
import path from "node:path";

export const DURATION_TOLERANCE_RATIO = 0.05;
export const DURATION_TOLERANCE_MIN_SEC = 0.3;
export const COMMAND_TIMEOUT_MS = 30_000;
export const MEDIA_VALIDATE_TIMEOUT_MAX_MS = 8 * 60 * 60 * 1000;
const FORMAL_MERGE_UNIT_BYTES = 4 * 1024 * 1024 * 1024;
const FORMAL_MERGE_TIMEOUT_MIN_MS = 2 * 60 * 1000;
const FORMAL_MERGE_TIMEOUT_MAX_MS = 30 * 60 * 1000;

export type StreamFingerprint = {
  readonly formatName: string;
  readonly duration: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly sampleRate?: string;
};

export type CommandRunOptions = {
  readonly timeoutMs?: number;
};

export function mediaValidateTimeoutMs(durationSec: number): number {
  const durationMs = Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : 0;
  return Math.min(
    MEDIA_VALIDATE_TIMEOUT_MAX_MS,
    Math.max(COMMAND_TIMEOUT_MS, durationMs + COMMAND_TIMEOUT_MS),
  );
}

export function formalMergeTimeoutMs(totalBytes: number): number {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const units = Math.ceil(bytes / FORMAL_MERGE_UNIT_BYTES);
  return Math.min(
    FORMAL_MERGE_TIMEOUT_MAX_MS,
    Math.max(FORMAL_MERGE_TIMEOUT_MIN_MS, units * FORMAL_MERGE_TIMEOUT_MIN_MS),
  );
}

export function mediaValidateOptions(durationSec: number): CommandRunOptions {
  return { timeoutMs: mediaValidateTimeoutMs(durationSec) };
}

export function resolveCommandTimeoutMs(options: CommandRunOptions = {}): number {
  const requested = options.timeoutMs;
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    return requested;
  }
  return COMMAND_TIMEOUT_MS;
}

export type CommandRunner = (
  bin: string,
  args: readonly string[],
  options?: CommandRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export class CommandTimeoutError extends Error {
  readonly name = "CommandTimeoutError";
  constructor(
    readonly bin: string,
    readonly timeoutMs: number,
  ) {
    super(`command timeout (${timeoutMs}): ${bin}`);
  }
}

export function durationTolerance(expectedSec: number): number {
  return Math.max(DURATION_TOLERANCE_MIN_SEC, expectedSec * DURATION_TOLERANCE_RATIO);
}

export function fingerprintsMatch(left: StreamFingerprint, right: StreamFingerprint): boolean {
  return (
    left.formatName === right.formatName &&
    left.videoCodec === right.videoCodec &&
    left.audioCodec === right.audioCodec &&
    left.width === right.width &&
    left.height === right.height &&
    left.sampleRate === right.sampleRate
  );
}

export function runCommand(
  bin: string,
  args: readonly string[],
  options: CommandRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = resolveCommandTimeoutMs(options);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      action();
    };

    const timeoutId = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => {
        reject(new CommandTimeoutError(bin, timeoutMs));
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (code === 0) {
          resolve(result);
          return;
        }
        reject(new Error(`command failed (${code}): ${bin} ${args.join(" ")}`));
      });
    });
  });
}

export async function probe(
  run: CommandRunner,
  ffprobePath: string,
  file: string,
  options: CommandRunOptions = {},
): Promise<StreamFingerprint> {
  const { stdout } = await run(
    ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: resolveCommandTimeoutMs(options) },
  );
  let parsed: {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      sample_rate?: string;
    }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`ffprobe json parse failed: ${file}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    formatName: parsed.format?.format_name ?? "",
    duration: Number(parsed.format?.duration ?? 0),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    width: video?.width,
    height: video?.height,
    sampleRate: audio?.sample_rate,
  };
}

export async function decodeAll(
  run: CommandRunner,
  ffmpegPath: string,
  file: string,
  options: CommandRunOptions = {},
): Promise<void> {
  await run(
    ffmpegPath,
    ["-v", "error", "-xerror", "-i", file, "-map", "0", "-f", "null", "-"],
    { timeoutMs: resolveCommandTimeoutMs(options) },
  );
}

function muxerForExt(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".mp4":
    case ".m4s":
      return "mp4";
    case ".ts":
      return "mpegts";
    case ".flv":
      return "flv";
    default:
      return undefined;
  }
}

export async function copyRemux(
  run: CommandRunner,
  ffmpegPath: string,
  argsPrefix: readonly string[],
  output: string,
  options?: CommandRunOptions,
): Promise<void> {
  const muxer = muxerForExt(path.extname(output));
  const args = ["-y", "-xerror", ...argsPrefix, "-c", "copy"];
  if (muxer !== undefined) {
    args.push("-f", muxer);
  }
  args.push(output);
  await run(ffmpegPath, args, options);
}
