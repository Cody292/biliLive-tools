import fs from "node:fs";

import { replaceExtName } from "../utils/index.js";
import type { FragmentProcessResult } from "./fragmentMerge.js";
import { pairFragmentXml, type FragmentXmlPairResult } from "./fragmentXml.js";

export type FragmentOpenMeta = {
  readonly roomId: string;
  readonly title: string;
  readonly username: string;
  readonly platform: string;
  readonly time: string;
  readonly sendToWebhook: boolean;
  readonly requiresDanmuXml?: boolean;
};

export type FragmentFinalizeResult = FragmentProcessResult & {
  readonly output?: string;
  readonly xmlPath?: string;
  readonly xmlIncomplete?: boolean;
  readonly openMeta?: FragmentOpenMeta;
  readonly sources?: readonly string[];
};

export type FragmentWebhookEvent = {
  readonly event: "FileOpening" | "FileClosed";
  readonly filePath: string;
  readonly roomId: string;
  readonly time: string;
  readonly title: string;
  readonly username: string;
  readonly platform: string;
  readonly software: "biliLive-tools";
  readonly danmuPath?: string;
};

function attachXml(
  result: FragmentProcessResult,
  output: string,
  xml: FragmentXmlPairResult,
  openMeta: FragmentOpenMeta | undefined,
): FragmentFinalizeResult {
  const xmlIncomplete =
    (xml.kind === "incomplete" && openMeta?.requiresDanmuXml !== false) ||
    (xml.kind === "none" && openMeta?.requiresDanmuXml === true);
  return {
    ...result,
    output,
    ...(xml.kind === "ok" ? { xmlPath: xml.xmlPath } : {}),
    ...(xmlIncomplete ? { xmlIncomplete: true } : {}),
    ...(openMeta ? { openMeta } : {}),
  };
}

function withMeta(
  result: FragmentProcessResult,
  openMeta: FragmentOpenMeta | undefined,
): FragmentFinalizeResult {
  return openMeta ? { ...result, openMeta } : result;
}

function withSources(
  result: FragmentFinalizeResult,
  files: readonly string[],
): FragmentFinalizeResult {
  if (result.output !== undefined || files.length === 0) {
    return result;
  }
  return { ...result, sources: [...files] };
}

export function getFragmentPostProcessFiles(
  result: FragmentFinalizeResult | undefined,
): { readonly videoPath: string; readonly xmlPath?: string } | undefined {
  if (!result) return undefined;
  if (result.xmlIncomplete && result.openMeta?.requiresDanmuXml !== false) {
    return undefined;
  }
  switch (result.kind) {
    case "rejected":
      return undefined;
    case "noop":
      if (result.reason === "single-keep" && result.output) {
        return { videoPath: result.output, xmlPath: result.xmlPath };
      }
      return undefined;
    case "merged":
    case "remuxed":
      return { videoPath: result.output, xmlPath: result.xmlPath };
    default: {
      const unreachable: never = result;
      throw new Error(`unhandled fragment result: ${JSON.stringify(unreachable)}`);
    }
  }
}

type FragmentWebhookPair = {
  readonly open: FragmentWebhookEvent;
  readonly close: FragmentWebhookEvent;
};

function pairForFile(input: {
  readonly meta: FragmentOpenMeta;
  readonly filePath: string;
  readonly endTime: string;
  readonly danmuPath?: string;
}): FragmentWebhookPair {
  const shared = {
    filePath: input.filePath,
    roomId: input.meta.roomId,
    title: input.meta.title,
    username: input.meta.username,
    platform: input.meta.platform,
    software: "biliLive-tools" as const,
    ...(input.danmuPath ? { danmuPath: input.danmuPath } : {}),
  };
  return {
    open: { event: "FileOpening", time: input.meta.time, ...shared },
    close: { event: "FileClosed", time: input.endTime, ...shared },
  };
}

function sourcesXmlComplete(sources: readonly string[]): boolean {
  return sources.every((file) => fs.existsSync(replaceExtName(file, ".xml")));
}

export function buildFragmentWebhookEvents(input: {
  readonly result: FragmentFinalizeResult | undefined;
  readonly endTime: string;
  readonly videoPath?: string;
}): FragmentWebhookPair | undefined {
  const files = getFragmentPostProcessFiles(input.result);
  const meta = input.result?.openMeta;
  if (!files || !meta?.sendToWebhook) return undefined;
  return pairForFile({
    meta,
    filePath: input.videoPath ?? files.videoPath,
    endTime: input.endTime,
    ...(files.xmlPath ? { danmuPath: files.xmlPath } : {}),
  });
}

function canFallbackToSources(result: FragmentFinalizeResult): boolean {
  switch (result.kind) {
    case "rejected":
      return true;
    case "noop":
      return result.reason === "capability-skip";
    case "merged":
    case "remuxed":
      return false;
    default: {
      const unreachable: never = result;
      throw new Error(`unhandled fragment result: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function buildFragmentSourceWebhookEvents(input: {
  readonly result: FragmentFinalizeResult | undefined;
  readonly endTime: string;
}): readonly FragmentWebhookPair[] | undefined {
  const result = input.result;
  const meta = result?.openMeta;
  const sources = result?.sources;
  if (!result || !meta?.sendToWebhook || !sources || sources.length === 0) {
    return undefined;
  }
  if (!canFallbackToSources(result)) {
    return undefined;
  }
  if (result.xmlIncomplete && meta.requiresDanmuXml !== false) {
    return undefined;
  }
  if (meta.requiresDanmuXml === true && !sourcesXmlComplete(sources)) {
    return undefined;
  }
  return sources.map((filePath) => pairForFile({ meta, filePath, endTime: input.endTime }));
}

export async function attachFragmentPairing(
  result: FragmentProcessResult,
  files: readonly string[],
  openMeta: FragmentOpenMeta | undefined,
): Promise<FragmentFinalizeResult> {
  switch (result.kind) {
    case "rejected":
      return withSources(withMeta(result, openMeta), files);
    case "noop": {
      const source = files[0];
      if (result.reason !== "single-keep" || !source) {
        return withSources(withMeta(result, openMeta), files);
      }
      const xml = await pairFragmentXml({
        videos: files,
        durations: [],
        outputVideo: source,
      });
      return attachXml(result, source, xml, openMeta);
    }
    case "merged": {
      const xml = await pairFragmentXml({
        videos: result.archivedSources,
        durations: result.durations,
        outputVideo: result.output,
      });
      return attachXml(result, result.output, xml, openMeta);
    }
    case "remuxed": {
      const xml = await pairFragmentXml({
        videos: files,
        durations: result.durations,
        outputVideo: result.output,
      });
      return attachXml(result, result.output, xml, openMeta);
    }
    default: {
      const unreachable: never = result;
      throw new Error(`unhandled fragment result: ${JSON.stringify(unreachable)}`);
    }
  }
}
