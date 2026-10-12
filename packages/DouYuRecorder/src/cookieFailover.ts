type DouyuFailoverCandidate = {
  uid: number;
  cookie: string;
  weight?: number;
  label?: string;
};

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
  },
  request: (auth: string) => Promise<T>,
): Promise<T> {
  const { mode, auth = "", candidates, onResolved } = opts;

  if (mode !== "always" || !candidates || candidates.length === 0) {
    const cookie = mode === "always" ? auth : "";
    const result = await request(cookie);
    if (mode === "always" && cookie) {
      onResolved?.({ cookie });
    }
    return result;
  }

  const ordered = orderCandidatesForFailover(candidates, auth);
  const failedUids = new Set<number>();
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
      failedUids.add(candidate.uid);
    }
  }

  throw lastError;
}
