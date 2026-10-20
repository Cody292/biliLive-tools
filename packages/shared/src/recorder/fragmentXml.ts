import fs from "node:fs";

import { mergeXmlWithDurations, type XmlMergeSegment } from "../task/danmu.js";
import { replaceExtName } from "../utils/index.js";
import logger from "../utils/log.js";

export type FragmentXmlPairResult =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly xmlPath: string }
  | { readonly kind: "incomplete"; readonly reason: "missing" | "duration" | "error" };

function siblingXml(videoPath: string): string {
  return replaceExtName(videoPath, ".xml");
}

export async function pairFragmentXml(input: {
  readonly videos: readonly string[];
  readonly durations: readonly number[];
  readonly outputVideo: string;
}): Promise<FragmentXmlPairResult> {
  const xmls = input.videos.map(siblingXml);
  const existing = xmls.filter((xml) => fs.existsSync(xml));
  if (existing.length === 0) {
    return { kind: "none" };
  }
  if (existing.length !== input.videos.length) {
    return { kind: "incomplete", reason: "missing" };
  }
  const firstXml = existing[0];
  if (input.videos.length === 1 && firstXml) {
    return { kind: "ok", xmlPath: firstXml };
  }
  if (input.durations.length !== input.videos.length || input.durations.some((item) => !(item > 0))) {
    return { kind: "incomplete", reason: "duration" };
  }

  const segments: XmlMergeSegment[] = [];
  for (let index = 0; index < input.videos.length; index += 1) {
    const videoPath = input.videos[index];
    const danmakuPath = xmls[index];
    const durationSec = input.durations[index];
    if (!videoPath || !danmakuPath || !(durationSec > 0)) {
      return { kind: "incomplete", reason: "duration" };
    }
    segments.push({ videoPath, danmakuPath, durationSec });
  }

  try {
    const output = siblingXml(input.outputVideo);
    const xmlPath = await mergeXmlWithDurations(segments, { output, saveMeta: true });
    return { kind: "ok", xmlPath };
  } catch (error) {
    if (error instanceof Error) {
      logger.error("autoFragmentMerge xml merge failed", {
        error,
        videos: input.videos,
      });
      return { kind: "incomplete", reason: "error" };
    }
    throw error;
  }
}
