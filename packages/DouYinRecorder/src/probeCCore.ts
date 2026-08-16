/**
 * 探针 C：升级阶梯纯函数（§5.3.1）。
 * 与 probeB.mapProbeResultToHealthPatch 分离；本层无定时器/写盘。
 * 不静态依赖 http/shared（包环）；健康枚举与 cookieAccountSelection 对齐。
 */

export const PROBE_C_AUTH_INVALID_THRESHOLD = 2;
export const PROBE_C_AUTH_RELOGIN_THRESHOLD = 3;
export const PROBE_C_IDLE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PROBE_C_ACCOUNT_GAP_MS = 30_000;

export type DouyinAccountHealthStatus =
  | "healthy"
  | "expiring"
  | "invalid"
  | "relogin_required"
  | "unknown";

export type ProbeFailureClass =
  | "auth_failed"
  | "http_error"
  | "timeout"
  | "parse_error"
  | "network"
  | "unknown";

export type ProbeOnceOk = {
  readonly ok: true;
  readonly identity?: {
    readonly nickname?: string;
    readonly uid?: string;
    readonly sec_user_id?: string;
  };
};

export type ProbeOnceFail = {
  readonly ok: false;
  readonly class: ProbeFailureClass;
  readonly httpStatus?: number;
  readonly reason?: string;
};

export type ProbeOnceResult = ProbeOnceOk | ProbeOnceFail;

export type DouyinProbeOnceFn = (cookie: string) => Promise<ProbeOnceResult>;

export type DouyinAccountHealthPatch = {
  readonly healthStatus?: DouyinAccountHealthStatus;
  readonly healthCheckedAt?: number;
  readonly healthReason?: string;
  readonly cookie?: string;
};

export type ProbeCAuthCountState = {
  readonly consecutiveAuthFails: number;
};

export type ProbeCEscalation = "invalid" | "relogin_required";

export type ProbeCMapResult = {
  readonly patch: DouyinAccountHealthPatch;
  readonly nextCount: ProbeCAuthCountState;
  readonly escalated?: ProbeCEscalation;
};

export type ProbeCAuthCounter = {
  readonly getState: (accountId: string) => ProbeCAuthCountState;
  readonly setState: (accountId: string, state: ProbeCAuthCountState) => void;
  readonly reset: (accountId: string) => void;
  readonly clearAll?: () => void;
};

function isProbeOnceFail(result: ProbeOnceResult): result is ProbeOnceFail {
  return result.ok === false;
}

function assertNever(value: never): never {
  throw new Error(`unexpected probe class: ${String(value)}`);
}

/**
 * §5.3.1 升级阶梯：
 * - ok → healthy + 重置计数
 * - auth_failed：计数+1；≥2 → invalid；≥3 → relogin_required
 * - timeout/network/http_error/parse_error/unknown → 仅 healthReason，不改 status/计数
 * - patch 永不含 enabled
 */
export function mapProbeCResultToHealthPatch(
  result: ProbeOnceResult,
  countState: ProbeCAuthCountState,
  now: number,
): ProbeCMapResult {
  if (!isProbeOnceFail(result)) {
    return {
      patch: {
        healthStatus: "healthy",
        healthCheckedAt: now,
        healthReason: "probe ok",
      },
      nextCount: { consecutiveAuthFails: 0 },
    };
  }

  switch (result.class) {
    case "auth_failed": {
      const next = countState.consecutiveAuthFails + 1;
      const nextCount: ProbeCAuthCountState = { consecutiveAuthFails: next };
      const reason = result.reason ?? "auth_failed";

      if (next >= PROBE_C_AUTH_RELOGIN_THRESHOLD) {
        return {
          patch: {
            healthStatus: "relogin_required",
            healthCheckedAt: now,
            healthReason: reason,
          },
          nextCount,
          escalated: "relogin_required",
        };
      }
      if (next >= PROBE_C_AUTH_INVALID_THRESHOLD) {
        return {
          patch: {
            healthStatus: "invalid",
            healthCheckedAt: now,
            healthReason: reason,
          },
          nextCount,
          escalated: "invalid",
        };
      }
      return {
        patch: { healthReason: reason },
        nextCount,
      };
    }
    case "timeout":
    case "network":
    case "http_error":
    case "parse_error":
    case "unknown":
      return {
        patch: { healthReason: result.reason ?? result.class },
        nextCount: countState,
      };
    default:
      return assertNever(result.class);
  }
}

export function createProbeCAuthCounter(): ProbeCAuthCounter {
  const counts = new Map<string, number>();

  return {
    getState(accountId: string): ProbeCAuthCountState {
      return { consecutiveAuthFails: counts.get(accountId) ?? 0 };
    },
    setState(accountId: string, state: ProbeCAuthCountState): void {
      if (state.consecutiveAuthFails <= 0) {
        counts.delete(accountId);
        return;
      }
      counts.set(accountId, state.consecutiveAuthFails);
    },
    reset(accountId: string): void {
      counts.delete(accountId);
    },
    clearAll(): void {
      counts.clear();
    },
  };
}

const defaultProbeCAuthCounter = createProbeCAuthCounter();

export function getDefaultProbeCAuthCounter(): ProbeCAuthCounter {
  return defaultProbeCAuthCounter;
}

export function clearDefaultProbeCAuthCounter(): void {
  defaultProbeCAuthCounter.clearAll?.();
}
