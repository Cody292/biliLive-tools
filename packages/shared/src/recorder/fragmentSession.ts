import type { AppConfig as AppConfigType } from "@biliLive-tools/types";

import { CommandTimeoutError, processFragments, type CommandRunner } from "./fragmentMerge.js";
import {
  attachFragmentPairing,
  type FragmentFinalizeResult,
  type FragmentOpenMeta,
} from "./fragmentPostProcess.js";
import logger from "../utils/log.js";
import {
  deleteSession,
  getOrCreateSession,
  getTombstone,
  isAutoFragmentMergeEnabled as resolveAutoFragmentMerge,
  pruneTombstones,
  rememberTombstone,
  type FragmentSession,
} from "./fragmentStore.js";

export const FRAGMENT_DRAIN_TIMEOUT_MS = 30_000;
export {
  FRAGMENT_TOMBSTONE_MAX,
  FRAGMENT_TOMBSTONE_TTL_MS,
  beginFragmentFlight,
  collectCompletedFragment,
  isAutoFragmentMergeEnabled,
  isFragmentDanmuEnabled,
  peekFragmentFiles,
  peekFragmentOpenMeta,
  rememberFragmentOpen,
  resetFragmentSessionsForTests,
  shouldKeepFragmentSource,
} from "./fragmentStore.js";

export type {
  FragmentFinalizeResult,
  FragmentOpenMeta,
  FragmentWebhookEvent,
} from "./fragmentPostProcess.js";
export {
  buildFragmentSourceWebhookEvents,
  buildFragmentWebhookEvents,
  getFragmentPostProcessFiles,
} from "./fragmentPostProcess.js";

function rejectedResult(
  reason: "timeout" | "ffmpeg",
  openMeta: FragmentOpenMeta | undefined,
  sources: readonly string[] = [],
): FragmentFinalizeResult {
  return {
    kind: "rejected",
    reason,
    ...(openMeta ? { openMeta } : {}),
    ...(sources.length > 0 ? { sources: [...sources] } : {}),
  };
}

function emptyResult(openMeta: FragmentOpenMeta | undefined): FragmentFinalizeResult {
  if (openMeta) {
    return { kind: "noop", reason: "empty", openMeta };
  }
  return { kind: "noop", reason: "empty" };
}

async function drainFlights(session: FragmentSession): Promise<"drained" | "timeout"> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), FRAGMENT_DRAIN_TIMEOUT_MS);
  });
  const drained = Promise.allSettled(session.flights).then(() => "drained" as const);
  const winner = await Promise.race([drained, timeout]);
  if (timeoutId) clearTimeout(timeoutId);
  return winner;
}

export function finalizeFragmentSession(input: {
  readonly recordHandleId?: string;
  readonly channelId: string | number | undefined;
  readonly webhook: AppConfigType["webhook"] | undefined;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly run?: CommandRunner;
  readonly openMeta?: FragmentOpenMeta;
}): Promise<FragmentFinalizeResult | undefined> {
  const recordHandleId = input.recordHandleId;
  if (!recordHandleId) return Promise.resolve(undefined);
  const now = Date.now();
  pruneTombstones(now);
  const existingTombstone = getTombstone(recordHandleId);
  if (existingTombstone) {
    return existingTombstone;
  }
  const session = getOrCreateSession(recordHandleId);
  if (session.finalizePromise) {
    return session.finalizePromise;
  }
  session.finalized = true;
  const openMeta = session.openMeta ?? input.openMeta;
  const finalizePromise: Promise<FragmentFinalizeResult> = (async () => {
    let files: readonly string[] = [];
    try {
      const drain = await drainFlights(session);
      if (drain === "timeout") {
        logger.error("autoFragmentMerge drain timeout", {
          recordHandleId,
          pending: session.flights.length,
        });
        return rejectedResult("timeout", openMeta);
      }
      if (!resolveAutoFragmentMerge(input.webhook, input.channelId)) {
        return emptyResult(openMeta);
      }
      files = [...session.files];
      const paired = await attachFragmentPairing(
        await processFragments({
          files,
          ffmpegPath: input.ffmpegPath,
          ffprobePath: input.ffprobePath,
          run: input.run,
        }),
        files,
        openMeta,
      );
      switch (paired.kind) {
        case "rejected":
          logger.error("autoFragmentMerge rejected", {
            recordHandleId,
            reason: paired.reason,
            files,
          });
          break;
        case "merged":
        case "remuxed":
          logger.info("autoFragmentMerge output", {
            recordHandleId,
            output: paired.output,
            files,
          });
          break;
        case "noop":
          break;
        default: {
          const unreachable: never = paired;
          throw new Error(`unhandled fragment result: ${JSON.stringify(unreachable)}`);
        }
      }
      if (paired.xmlIncomplete) {
        logger.error("autoFragmentMerge xml incomplete", {
          recordHandleId,
          files,
        });
      }
      return paired;
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        logger.error("autoFragmentMerge finalize timeout", { recordHandleId, error });
        return rejectedResult("timeout", openMeta, files);
      }
      if (error instanceof Error) {
        logger.error("autoFragmentMerge finalize failed", { recordHandleId, error });
        return rejectedResult("ffmpeg", openMeta, files);
      }
      logger.error("autoFragmentMerge finalize failed", {
        recordHandleId,
        error: String(error),
      });
      return rejectedResult("ffmpeg", openMeta, files);
    } finally {
      session.files.length = 0;
      session.flights.length = 0;
      deleteSession(recordHandleId);
    }
  })();
  session.finalizePromise = finalizePromise;
  rememberTombstone(recordHandleId, finalizePromise, now);
  return finalizePromise;
}
