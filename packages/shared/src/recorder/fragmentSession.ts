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
  rememberSessionTombstone,
  resolveFragmentSessionKey,
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
  resolveFragmentSessionKey,
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
  readonly sessionId?: string;
  readonly recordHandleId?: string;
  readonly autoFragmentMerge?: boolean;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly run?: CommandRunner;
  readonly openMeta?: FragmentOpenMeta;
}): Promise<FragmentFinalizeResult | undefined> {
  const sessionKey = resolveFragmentSessionKey(input);
  if (!sessionKey) return Promise.resolve(undefined);
  const now = Date.now();
  pruneTombstones(now);
  const existingTombstone =
    getTombstone(sessionKey) ??
    (input.recordHandleId ? getTombstone(input.recordHandleId) : undefined);
  if (existingTombstone) {
    return existingTombstone;
  }
  const session = getOrCreateSession(sessionKey);
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
          sessionId: sessionKey,
          pending: session.flights.length,
        });
        return rejectedResult("timeout", openMeta);
      }
      if (!resolveAutoFragmentMerge(input.autoFragmentMerge)) {
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
            sessionId: sessionKey,
            reason: paired.reason,
            files,
          });
          break;
        case "merged":
        case "remuxed":
          logger.info("autoFragmentMerge output", {
            sessionId: sessionKey,
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
          sessionId: sessionKey,
          files,
        });
      }
      return paired;
    } catch (error) {
      if (error instanceof CommandTimeoutError) {
        logger.error("autoFragmentMerge finalize timeout", { sessionId: sessionKey, error });
        return rejectedResult("timeout", openMeta, files);
      }
      if (error instanceof Error) {
        logger.error("autoFragmentMerge finalize failed", { sessionId: sessionKey, error });
        return rejectedResult("ffmpeg", openMeta, files);
      }
      logger.error("autoFragmentMerge finalize failed", {
        sessionId: sessionKey,
        error: String(error),
      });
      return rejectedResult("ffmpeg", openMeta, files);
    } finally {
      session.files.length = 0;
      session.flights.length = 0;
      deleteSession(sessionKey);
    }
  })();
  session.finalizePromise = finalizePromise;
  rememberSessionTombstone(sessionKey, finalizePromise, now);
  return finalizePromise;
}
