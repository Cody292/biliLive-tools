import { NetworkError } from "@bililive-tools/stream-get";

type DouyuFailoverCandidate = {
  uid: number;
  cookie: string;
  weight?: number;
  label?: string;
};

export type DouyuStreamCookieHooks = {
  readonly refresh?: (uid: number) => Promise<void>;
  readonly reloadCookie?: (uid: number) => string | undefined | Promise<string | undefined>;
};

let defaultHooks: DouyuStreamCookieHooks = {};

export function setDouyuStreamCookieHooks(hooks: DouyuStreamCookieHooks | null): void {
  defaultHooks = hooks ?? {};
}

export function getDouyuStreamCookieHooks(): DouyuStreamCookieHooks {
  return defaultHooks;
}

const AUTH_FAILURE_RE =
  /(?:^|[^\d])401(?:[^\d]|$)|(?:^|[^\d])403(?:[^\d]|$)|unauthorized|auth[_\s-]?fail|login[_\s-]?required|cookie.*(invalid|expired|失效)|鉴权|未登录|请重新登录|relogin|登录失效|登录过期|session.*(invalid|expired)/;

const MISSING_ERROR_SIGNAL_RE = /unexpected error code:\s*(?:undefined|null|missing)\b/;

const NON_AUTH_RE =
  /timeout|timed?\s*out|etimedout|econnreset|enotfound|econnrefused|network|socket hang up|网络错误|strictquality|expect quality|source list is empty|must be called getstream when living/;

function readNumericField(target: object, key: string): number {
  if (!Object.hasOwn(target, key)) return Number.NaN;
  return Number(Reflect.get(target, key));
}

function readHttpStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return Number.NaN;
  const statusCode = readNumericField(error, "statusCode");
  if (Number.isFinite(statusCode)) return statusCode;
  const status = readNumericField(error, "status");
  if (Number.isFinite(status)) return status;
  return readNumericField(error, "httpStatus");
}

export function isDouyuStreamAuthFailure(error: unknown): boolean {
  if (error == null) return false;
  if (error instanceof NetworkError) return false;
  if (typeof error === "object" && "name" in error && error.name === "NetworkError") {
    return false;
  }

  const status = readHttpStatus(error);
  if (status === 401 || status === 403) return true;

  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (NON_AUTH_RE.test(msg)) return false;
  if (MISSING_ERROR_SIGNAL_RE.test(msg)) return true;
  return AUTH_FAILURE_RE.test(msg);
}

function normalizeWeight(weight: unknown): number {
  const parsed = Number(weight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function pickWeightedCandidate(
  candidates: readonly DouyuFailoverCandidate[],
): DouyuFailoverCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const totalWeight = candidates.reduce((sum, item) => sum + normalizeWeight(item.weight), 0);
  let random = Math.random() * totalWeight;
  for (const candidate of candidates) {
    random -= normalizeWeight(candidate.weight);
    if (random <= 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

function orderCandidatesForFailover(
  candidates: readonly DouyuFailoverCandidate[],
  auth: string,
): DouyuFailoverCandidate[] {
  if (candidates.length === 0) return [];

  const matchedIndex = auth ? candidates.findIndex((c) => c.cookie === auth) : -1;
  if (matchedIndex !== -1) {
    const matched = candidates[matchedIndex];
    return [matched, ...candidates.filter((_, index) => index !== matchedIndex)];
  }

  const selected = pickWeightedCandidate(candidates);
  if (!selected) return [...candidates];
  return [selected, ...candidates.filter((c) => c.uid !== selected.uid)];
}

async function tryRefreshAndRetry<T>(
  candidate: DouyuFailoverCandidate,
  request: (auth: string) => Promise<T>,
  hooks: DouyuStreamCookieHooks,
): Promise<{ ok: true; value: T; cookie: string } | { ok: false; error: unknown }> {
  const { refresh, reloadCookie } = hooks;
  if (!refresh || !reloadCookie) {
    return { ok: false, error: undefined };
  }

  try {
    await refresh(candidate.uid);
  } catch (refreshError) {
    return { ok: false, error: refreshError };
  }

  const nextCookie = (await reloadCookie(candidate.uid))?.trim();
  if (!nextCookie) {
    return { ok: false, error: undefined };
  }

  try {
    const value = await request(nextCookie);
    return { ok: true, value, cookie: nextCookie };
  } catch (retryError) {
    return { ok: false, error: retryError };
  }
}

export async function requestStreamWithDouyuFailover<T>(
  opts: {
    mode?: string;
    auth?: string;
    candidates?: DouyuFailoverCandidate[];
    onResolved?: (info: {
      cookie: string;
      uid?: number;
      label?: string;
    }) => void;
    refresh?: DouyuStreamCookieHooks["refresh"];
    reloadCookie?: DouyuStreamCookieHooks["reloadCookie"];
  },
  request: (auth: string) => Promise<T>,
): Promise<T> {
  const { mode, auth = "", candidates, onResolved } = opts;

  if (mode !== "always") {
    return request("");
  }

  if (!candidates || candidates.length === 0) {
    const trimmedAuth = auth.trim();
    if (!trimmedAuth) {
      throw new Error("斗鱼未配置可用 Cookie");
    }
    const result = await request(auth);
    onResolved?.({ cookie: auth });
    return result;
  }

  const hooks: DouyuStreamCookieHooks = {
    refresh: opts.refresh ?? defaultHooks.refresh,
    reloadCookie: opts.reloadCookie ?? defaultHooks.reloadCookie,
  };

  const ordered = orderCandidatesForFailover(candidates, auth);
  const failedUids = new Set<number>();
  const refreshedUids = new Set<number>();
  let lastError: unknown;

  for (const candidate of ordered) {
    if (failedUids.has(candidate.uid)) continue;
    try {
      const result = await request(candidate.cookie);
      onResolved?.({
        cookie: candidate.cookie,
        uid: candidate.uid,
        label: candidate.label,
      });
      return result;
    } catch (err) {
      lastError = err;
      if (!isDouyuStreamAuthFailure(err) || refreshedUids.has(candidate.uid)) {
        failedUids.add(candidate.uid);
        continue;
      }

      refreshedUids.add(candidate.uid);
      const retried = await tryRefreshAndRetry(candidate, request, hooks);
      if (retried.ok) {
        onResolved?.({
          cookie: retried.cookie,
          uid: candidate.uid,
          label: candidate.label,
        });
        return retried.value;
      }
      if (retried.error !== undefined) {
        lastError = retried.error;
      }
      failedUids.add(candidate.uid);
    }
  }

  throw lastError;
}
