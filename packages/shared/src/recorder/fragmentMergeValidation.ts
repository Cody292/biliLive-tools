import fs from "node:fs/promises";

import {
  durationTolerance,
  mediaValidateOptions,
  probe,
  type CommandRunner,
  type StreamFingerprint,
} from "./fragmentMergeFfmpeg.js";

const BOUNDARY_SAMPLE_SECONDS = 10;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function decodeBoundaries(input: {
  readonly run: CommandRunner;
  readonly ffmpegPath: string;
  readonly file: string;
  readonly durationSec: number;
}): Promise<boolean> {
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) return false;
  const sampleDuration = Math.min(BOUNDARY_SAMPLE_SECONDS, input.durationSec / 2);
  const timeout = mediaValidateOptions(input.durationSec);
  for (const [seekArgs, streamMap] of [
    [["-i", input.file], "0"],
    [["-sseof", `-${sampleDuration}`, "-i", input.file], "0"],
    [["-sseof", `-${sampleDuration}`, "-i", input.file], "0:v:0"],
  ] as const) {
    const { stdout } = await input.run(
      input.ffmpegPath,
      [
        "-v",
        "error",
        "-xerror",
        "-progress",
        "pipe:1",
        ...seekArgs,
        "-map",
        streamMap,
        "-t",
        String(sampleDuration),
        "-f",
        "null",
        "-",
      ],
      timeout,
    );
    const frames = [...stdout.matchAll(/^frame=(\d+)$/gm)].map((match) => Number(match[1]));
    const outputTimes = [...stdout.matchAll(/^out_time_us=(-?\d+)$/gm)].map((match) =>
      Number(match[1]),
    );
    const hasOutput = frames.some((count) => count > 0) || outputTimes.some((time) => time > 0);
    const reachesEnd =
      !seekArgs.includes("-sseof") ||
      (streamMap === "0"
        ? outputTimes.some((time) => time >= sampleDuration * 900_000)
        : outputTimes.some(
            (time) =>
              time >=
              Math.max(0, sampleDuration - durationTolerance(input.durationSec)) * 1_000_000,
          )) ||
      (sampleDuration < durationTolerance(input.durationSec) && frames.some((count) => count > 0));
    if (!hasOutput || !reachesEnd) return false;
  }
  return true;
}

export async function validateOutput(input: {
  readonly run: CommandRunner;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly output: string;
  readonly expectedDuration: number;
  readonly expectedFingerprint: StreamFingerprint;
}): Promise<boolean> {
  if (!(await pathExists(input.output))) return false;
  const stat = await fs.stat(input.output);
  if (!stat.isFile() || stat.size <= 0) return false;
  const meta = await probe(
    input.run,
    input.ffprobePath,
    input.output,
    mediaValidateOptions(input.expectedDuration),
  );
  if (!Number.isFinite(meta.duration) || meta.duration <= 0) return false;
  if (meta.videoCodec !== input.expectedFingerprint.videoCodec) return false;
  if (meta.audioCodec !== input.expectedFingerprint.audioCodec) return false;
  if (
    meta.width !== input.expectedFingerprint.width ||
    meta.height !== input.expectedFingerprint.height
  ) {
    return false;
  }
  if (meta.sampleRate !== input.expectedFingerprint.sampleRate) return false;
  if (
    Math.abs(meta.duration - input.expectedDuration) > durationTolerance(input.expectedDuration)
  ) {
    return false;
  }

  return decodeBoundaries({
    run: input.run,
    ffmpegPath: input.ffmpegPath,
    file: input.output,
    durationSec: Math.max(input.expectedDuration, meta.duration),
  });
}
