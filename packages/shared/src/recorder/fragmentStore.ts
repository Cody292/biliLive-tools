import fs from "node:fs";

import type { AppConfig as AppConfigType } from "@biliLive-tools/types";

import type { FragmentFinalizeResult, FragmentOpenMeta } from "./fragmentPostProcess.js";

export function isAutoFragmentMergeEnabled(
  webhook: AppConfigType["webhook"] | undefined,
  channelId: string | number | undefined,
): boolean {
  const globalEnabled = webhook?.autoFragmentMerge ?? false;
  if (channelId === undefined) {
    return globalEnabled;
  }
  const room = webhook?.rooms?.[String(channelId)];
  if (!room) {
    return globalEnabled;
  }
  if (room.noGlobal?.includes("autoFragmentMerge")) {
    return room.autoFragmentMerge ?? false;
  }
  return globalEnabled;
}

export function isFragmentDanmuEnabled(
  webhook: AppConfigType["webhook"] | undefined,
  channelId: string | number | undefined,
): boolean {
  const globalEnabled = webhook?.danmu ?? false;
  if (channelId === undefined) {
    return globalEnabled;
  }
  const room = webhook?.rooms?.[String(channelId)];
  if (!room || !room.noGlobal?.includes("danmu")) {
    return globalEnabled;
  }
  return room.danmu ?? false;
}

export function shouldKeepFragmentSource(
  webhook: AppConfigType["webhook"] | undefined,
  channelId: string | number | undefined,
): boolean {
  return isAutoFragmentMergeEnabled(webhook, channelId);
}

export const FRAGMENT_TOMBSTONE_TTL_MS = 60 * 60 * 1000;
export const FRAGMENT_TOMBSTONE_MAX = 1024;

export type FragmentSession = {
  readonly files: string[];
  readonly flights: Promise<void>[];
  finalized: boolean;
  finalizePromise?: Promise<FragmentFinalizeResult | undefined>;
  openMeta?: FragmentOpenMeta;
};

type FragmentTombstone = {
  readonly at: number;
  readonly promise: Promise<FragmentFinalizeResult | undefined>;
};

const sessions = new Map<string, FragmentSession>();
const tombstones = new Map<string, FragmentTombstone>();

export function resetFragmentSessionsForTests(): void {
  sessions.clear();
  tombstones.clear();
}

export function pruneTombstones(now: number): void {
  for (const [id, stone] of tombstones) {
    if (now - stone.at >= FRAGMENT_TOMBSTONE_TTL_MS) {
      tombstones.delete(id);
    }
  }
  while (tombstones.size > FRAGMENT_TOMBSTONE_MAX) {
    const oldest = tombstones.keys().next().value;
    if (oldest === undefined) break;
    tombstones.delete(oldest);
  }
}

export function isRemembered(recordHandleId: string, now: number = Date.now()): boolean {
  pruneTombstones(now);
  return tombstones.has(recordHandleId);
}

export function rememberTombstone(
  recordHandleId: string,
  promise: Promise<FragmentFinalizeResult | undefined>,
  now: number,
): void {
  pruneTombstones(now);
  tombstones.delete(recordHandleId);
  tombstones.set(recordHandleId, { at: now, promise });
  pruneTombstones(now);
}

export function getTombstone(
  recordHandleId: string,
): Promise<FragmentFinalizeResult | undefined> | undefined {
  return tombstones.get(recordHandleId)?.promise;
}

export function getOrCreateSession(recordHandleId: string): FragmentSession {
  const existing = sessions.get(recordHandleId);
  if (existing) return existing;
  const created: FragmentSession = {
    files: [],
    flights: [],
    finalized: false,
  };
  sessions.set(recordHandleId, created);
  return created;
}

export function deleteSession(recordHandleId: string): void {
  sessions.delete(recordHandleId);
}

export function collectCompletedFragment(input: {
  readonly recordHandleId?: string;
  readonly filename: string;
  readonly channelId: string | number | undefined;
  readonly webhook: AppConfigType["webhook"] | undefined;
}): boolean {
  const recordHandleId = input.recordHandleId;
  if (!recordHandleId) return false;
  if (isRemembered(recordHandleId)) return false;
  if (!isAutoFragmentMergeEnabled(input.webhook, input.channelId)) return false;
  if (!fs.existsSync(input.filename)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.filename);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) return false;
  const session = getOrCreateSession(recordHandleId);
  if (session.finalized) return false;
  if (!session.files.includes(input.filename)) {
    session.files.push(input.filename);
  }
  return true;
}

export function beginFragmentFlight(recordHandleId: string | undefined): () => void {
  if (!recordHandleId || isRemembered(recordHandleId)) {
    return () => {};
  }
  const session = getOrCreateSession(recordHandleId);
  if (session.finalized) {
    return () => {};
  }
  let released = false;
  let resolveFlight: () => void = () => {};
  const flight = new Promise<void>((resolve) => {
    resolveFlight = resolve;
  });
  session.flights.push(flight);
  return () => {
    if (released) return;
    released = true;
    resolveFlight();
  };
}

export function peekFragmentFiles(recordHandleId: string): readonly string[] {
  return sessions.get(recordHandleId)?.files ?? [];
}

export function rememberFragmentOpen(input: {
  readonly recordHandleId?: string;
  readonly roomId: string | number | undefined;
  readonly title: string | undefined;
  readonly username: string | undefined;
  readonly platform: string | undefined;
  readonly time: string;
  readonly sendToWebhook: boolean;
  readonly requiresDanmuXml?: boolean;
}): void {
  const recordHandleId = input.recordHandleId;
  if (!recordHandleId || isRemembered(recordHandleId)) return;
  const session = getOrCreateSession(recordHandleId);
  if (session.finalized || session.openMeta) return;
  session.openMeta = {
    roomId: String(input.roomId ?? ""),
    title: input.title ?? "",
    username: input.username ?? "",
    platform: input.platform ?? "custom",
    time: input.time,
    sendToWebhook: input.sendToWebhook,
    ...(input.requiresDanmuXml === undefined
      ? {}
      : { requiresDanmuXml: input.requiresDanmuXml }),
  };
}

export function peekFragmentOpenMeta(
  recordHandleId: string | undefined,
): FragmentOpenMeta | undefined {
  if (!recordHandleId) return undefined;
  return sessions.get(recordHandleId)?.openMeta;
}
