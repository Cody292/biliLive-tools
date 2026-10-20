import fs from "node:fs";

import type { AppConfig as AppConfigType } from "@biliLive-tools/types";

import type { FragmentFinalizeResult, FragmentOpenMeta } from "./fragmentPostProcess.js";

export function isAutoFragmentMergeEnabled(autoFragmentMerge?: boolean): boolean {
  return autoFragmentMerge === true;
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

export function shouldKeepFragmentSource(autoFragmentMerge?: boolean): boolean {
  return isAutoFragmentMergeEnabled(autoFragmentMerge);
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
const handleToSession = new Map<string, string>();

export function resetFragmentSessionsForTests(): void {
  sessions.clear();
  tombstones.clear();
  handleToSession.clear();
}

export function resolveFragmentSessionKey(input: {
  readonly sessionId?: string;
  readonly recordHandleId?: string;
}): string | undefined {
  if (input.sessionId) return input.sessionId;
  if (!input.recordHandleId) return undefined;
  return handleToSession.get(input.recordHandleId) ?? input.recordHandleId;
}

function associateHandle(sessionKey: string, recordHandleId: string | undefined): void {
  if (!recordHandleId) return;
  handleToSession.set(recordHandleId, sessionKey);
}

function mappedHandles(sessionKey: string): string[] {
  const handles: string[] = [];
  for (const [handleId, mapped] of handleToSession) {
    if (mapped === sessionKey) handles.push(handleId);
  }
  return handles;
}

function forgetHandles(sessionKey: string): void {
  for (const handleId of mappedHandles(sessionKey)) {
    handleToSession.delete(handleId);
  }
}

export function rememberSessionTombstone(
  sessionKey: string,
  promise: Promise<FragmentFinalizeResult | undefined>,
  now: number,
): void {
  rememberTombstone(sessionKey, promise, now);
  for (const handleId of mappedHandles(sessionKey)) {
    rememberTombstone(handleId, promise, now);
  }
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

export function deleteSession(sessionKey: string): void {
  sessions.delete(sessionKey);
  forgetHandles(sessionKey);
}

export function collectCompletedFragment(input: {
  readonly sessionId?: string;
  readonly recordHandleId?: string;
  readonly filename: string;
  readonly autoFragmentMerge?: boolean;
}): boolean {
  const sessionKey = resolveFragmentSessionKey(input);
  if (!sessionKey) return false;
  if (isRemembered(sessionKey)) return false;
  if (input.recordHandleId && isRemembered(input.recordHandleId)) return false;
  if (!isAutoFragmentMergeEnabled(input.autoFragmentMerge)) return false;
  if (!fs.existsSync(input.filename)) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.filename);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0) return false;
  const session = getOrCreateSession(sessionKey);
  if (session.finalized) return false;
  associateHandle(sessionKey, input.recordHandleId);
  if (!session.files.includes(input.filename)) {
    session.files.push(input.filename);
  }
  return true;
}

export function beginFragmentFlight(
  input:
    | {
        readonly sessionId?: string;
        readonly recordHandleId?: string;
      }
    | string
    | undefined,
): () => void {
  const resolved = typeof input === "string" ? { recordHandleId: input } : (input ?? {});
  const sessionKey = resolveFragmentSessionKey(resolved);
  if (!sessionKey || isRemembered(sessionKey)) {
    return () => {};
  }
  if (resolved.recordHandleId && isRemembered(resolved.recordHandleId)) {
    return () => {};
  }
  const session = getOrCreateSession(sessionKey);
  if (session.finalized) {
    return () => {};
  }
  associateHandle(sessionKey, resolved.recordHandleId);
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

export function peekFragmentFiles(key: string): readonly string[] {
  const sessionKey = handleToSession.get(key) ?? key;
  return sessions.get(sessionKey)?.files ?? [];
}

export function rememberFragmentOpen(input: {
  readonly sessionId?: string;
  readonly recordHandleId?: string;
  readonly roomId: string | number | undefined;
  readonly title: string | undefined;
  readonly username: string | undefined;
  readonly platform: string | undefined;
  readonly time: string;
  readonly sendToWebhook: boolean;
  readonly requiresDanmuXml?: boolean;
}): void {
  const sessionKey = resolveFragmentSessionKey(input);
  if (!sessionKey || isRemembered(sessionKey)) return;
  if (input.recordHandleId && isRemembered(input.recordHandleId)) return;
  const session = getOrCreateSession(sessionKey);
  if (session.finalized) return;
  associateHandle(sessionKey, input.recordHandleId);
  if (session.openMeta) return;
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

export function peekFragmentOpenMeta(key: string | undefined): FragmentOpenMeta | undefined {
  if (!key) return undefined;
  const sessionKey = handleToSession.get(key) ?? key;
  return sessions.get(sessionKey)?.openMeta;
}
