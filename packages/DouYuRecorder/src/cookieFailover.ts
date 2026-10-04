export async function requestStreamWithDouyuFailover<T>(
  opts: {
    mode?: string;
    auth?: string;
    candidates?: Array<{ uid: number; cookie: string }>;
  },
  request: (auth: string) => Promise<T>,
): Promise<T> {
  const { mode, auth = "", candidates } = opts;

  if (mode !== "always" || !candidates || candidates.length === 0) {
    return await request(auth);
  }

  const failedUids = new Set<number>();
  let lastError: unknown;

  const matchedIndex = auth ? candidates.findIndex((c) => c.cookie === auth) : -1;
  if (matchedIndex !== -1) {
    const matched = candidates[matchedIndex];
    try {
      return await request(matched.cookie);
    } catch (err) {
      lastError = err;
      failedUids.add(matched.uid);
    }
  }

  for (const candidate of candidates) {
    if (failedUids.has(candidate.uid)) {
      continue;
    }
    try {
      return await request(candidate.cookie);
    } catch (err) {
      lastError = err;
      failedUids.add(candidate.uid);
    }
  }

  throw lastError;
}
