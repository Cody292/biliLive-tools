const COOKIE_CACHE_TTL = 6 * 60 * 60 * 1000;
const RETRY_URLS = ["https://live.douyin.com/", "https://www.douyin.com/"];
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

let cookieCache:
  | {
      startTimestamp: number;
      cookies: string;
    }
  | undefined;

function getSetCookieList(headers: Headers): string[] {
  const headerBag = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };

  if (typeof headerBag.getSetCookie === "function") {
    return headerBag.getSetCookie();
  }

  if (typeof headerBag.raw === "function") {
    return headerBag.raw()["set-cookie"] ?? [];
  }

  const merged = headers.get("set-cookie");
  if (!merged) {
    return [];
  }

  return merged
    .split(/,\s*(?=[^;]+?=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function toCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function requestCookie(url: string): Promise<string> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: "https://live.douyin.com/",
    },
  });

  const setCookies = getSetCookieList(res.headers);
  if (setCookies.length === 0) {
    throw new Error(`No cookie in response from ${url}`);
  }

  return toCookieHeader(setCookies);
}

export const getCookie = async () => {
  const now = Date.now();
  if (cookieCache && now - cookieCache.startTimestamp < COOKIE_CACHE_TTL) {
    return cookieCache.cookies;
  }

  let lastError: unknown;
  for (const url of RETRY_URLS) {
    try {
      const cookies = await requestCookie(url);
      if (!cookies.includes("ttwid")) {
        if (cookieCache?.cookies.includes("ttwid")) {
          cookieCache.startTimestamp = now;
          return cookieCache.cookies;
        }
        lastError = new Error(`Response from ${url} does not include ttwid`);
        continue;
      }

      cookieCache = {
        startTimestamp: now,
        cookies,
      };
      return cookies;
    } catch (error) {
      lastError = error;
    }
  }

  if (cookieCache?.cookies.includes("ttwid")) {
    cookieCache.startTimestamp = now;
    return cookieCache.cookies;
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to get douyin cookie");
};
