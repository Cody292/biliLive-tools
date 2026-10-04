export function normalizeAccountWeight(weight: unknown): number {
  const parsedWeight = Number(weight);
  return Number.isFinite(parsedWeight) && parsedWeight > 0 ? parsedWeight : 1;
}

export type DouyuPoolEntry = {
  uid?: number;
  enabled?: boolean;
  weight?: number | null;
};

export type SelectableDouyuAccount = {
  uid: number;
  weight: number;
  cookie: string;
};

export function deriveSelectableDouyuCookieAccounts(
  accounts: readonly DouyuPoolEntry[] | null | undefined,
  readUser: (uid: number) => { loginCookies?: { main?: string } } | undefined,
): SelectableDouyuAccount[] {
  if (!accounts || !Array.isArray(accounts)) {
    return [];
  }

  const result: SelectableDouyuAccount[] = [];

  for (const item of accounts) {
    if (item.enabled === false) {
      continue;
    }
    const uid = item.uid;
    if (typeof uid !== "number" || !Number.isFinite(uid) || uid <= 0) {
      continue;
    }
    const user = readUser(uid);
    if (!user) {
      continue;
    }
    const mainCookie = user.loginCookies?.main?.trim();
    if (!mainCookie) {
      continue;
    }
    result.push({
      uid,
      weight: normalizeAccountWeight(item.weight),
      cookie: mainCookie,
    });
  }

  return result;
}

export function pickWeightedAccount<T extends { weight: number }>(
  accounts: readonly T[],
): T | undefined {
  if (accounts.length === 0) {
    return undefined;
  }

  const totalWeight = accounts.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;

  for (const account of accounts) {
    random -= account.weight;
    if (random <= 0) {
      return account;
    }
  }

  return accounts[accounts.length - 1];
}

export function nextDouyuFailoverAccount(
  selectable: readonly SelectableDouyuAccount[],
  failedUids: ReadonlySet<number>,
): SelectableDouyuAccount | undefined {
  return selectable.find((account) => !failedUids.has(account.uid));
}

export type DouyinCookieAccountEntry = {
  remark?: string;
  cookie?: string;
  enabled?: boolean;
  weight?: number;
};

export function pickWeightedDouyinAccount<T extends DouyinCookieAccountEntry>(
  accounts: readonly T[],
): (T & { cookie: string; weight: number }) | undefined {
  const enabledAccounts = accounts.filter(
    (item): item is T & { cookie: string } =>
      item.enabled !== false && typeof item.cookie === "string" && item.cookie.trim().length > 0,
  );
  if (enabledAccounts.length === 0) {
    return undefined;
  }

  const normalizedAccounts = enabledAccounts.map((item) => ({
    ...item,
    cookie: item.cookie.trim(),
    weight: normalizeAccountWeight(item.weight),
  }));

  return pickWeightedAccount(normalizedAccounts);
}
