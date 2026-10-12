/**
 * 抖音弹幕恢复门闩：候选耗尽后允许新一轮；error/close 去重；旧客户端事件忽略。
 * 不负责选号/host 本身，也不把 TLS/网络错误当成鉴权失败。
 */

export const DOUYIN_DANMA_RECOVERY_ROUND_DELAY_MS = 10_000;

export type DouyinDanmaRecoveryAdmitReason =
  | "stopped"
  | "stale"
  | "in-flight"
  | "unmanaged";

export type DouyinDanmaRecoveryAdmitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DouyinDanmaRecoveryAdmitReason };

export type DouyinDanmaRecoveryLookupPlan<T> =
  | { readonly kind: "switch"; readonly candidate: T }
  | { readonly kind: "new-round"; readonly delayMs: number };

export type DouyinDanmaRecoveryGate = {
  readonly nextGeneration: () => number;
  readonly beginRecovery: (input: {
    readonly stopped: boolean;
    readonly unmanaged: boolean;
    readonly clientGeneration: number;
  }) => DouyinDanmaRecoveryAdmitResult;
  readonly endRecovery: () => void;
  readonly isCurrentGeneration: (generation: number) => boolean;
};

export function planDouyinDanmaRecoveryAfterCandidateLookup<T>(
  candidate: T | undefined,
): DouyinDanmaRecoveryLookupPlan<T> {
  if (candidate != null) {
    return { kind: "switch", candidate };
  }
  return {
    kind: "new-round",
    delayMs: DOUYIN_DANMA_RECOVERY_ROUND_DELAY_MS,
  };
}

export function resetDouyinDanmaRecoveryAttempts(attemptedKeys: Set<string>): void {
  attemptedKeys.clear();
}

export function isLiveDouyinDanmaEvent(input: {
  readonly client: object;
  readonly activeClient: object | undefined;
  readonly generation: number;
  readonly isCurrentGeneration: (generation: number) => boolean;
}): boolean {
  return (
    input.client === input.activeClient && input.isCurrentGeneration(input.generation)
  );
}

export function createDouyinDanmaRecoveryGate(): DouyinDanmaRecoveryGate {
  let inFlight = false;
  let activeGeneration = 0;

  return {
    nextGeneration() {
      activeGeneration += 1;
      return activeGeneration;
    },
    beginRecovery(input) {
      if (input.stopped) return { ok: false, reason: "stopped" };
      if (input.unmanaged) return { ok: false, reason: "unmanaged" };
      if (input.clientGeneration !== activeGeneration) {
        return { ok: false, reason: "stale" };
      }
      if (inFlight) return { ok: false, reason: "in-flight" };
      inFlight = true;
      return { ok: true };
    },
    endRecovery() {
      inFlight = false;
    },
    isCurrentGeneration(generation) {
      return generation === activeGeneration;
    },
  };
}
