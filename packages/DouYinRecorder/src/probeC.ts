/**
 * 探针 C 公共入口：升级阶梯 + 层2 空闲巡检 re-export。
 * 实现分文件：probeCCore（纯函数）、probeCIdlePatrol（调度）。
 */
export {
  PROBE_C_ACCOUNT_GAP_MS,
  PROBE_C_AUTH_INVALID_THRESHOLD,
  PROBE_C_AUTH_RELOGIN_THRESHOLD,
  PROBE_C_IDLE_INTERVAL_MS,
  clearDefaultProbeCAuthCounter,
  createProbeCAuthCounter,
  getDefaultProbeCAuthCounter,
  mapProbeCResultToHealthPatch,
} from './probeCCore.js';
export type {
  DouyinAccountHealthPatch,
  DouyinAccountHealthStatus,
  DouyinProbeOnceFn,
  ProbeCAuthCountState,
  ProbeCAuthCounter,
  ProbeCEscalation,
  ProbeCMapResult,
  ProbeFailureClass,
  ProbeOnceFail,
  ProbeOnceOk,
  ProbeOnceResult,
} from './probeCCore.js';

export {
  CHECK_WINDOW_MS,
  getProbeCAccountsGetter,
  isProbeCIdlePatrolEnabled,
  isProbeCIdlePatrolRunning,
  resetProbeCStateForTests,
  runProbeCIdleRound,
  setDouyinProbeCOnce,
  setProbeCAccountsGetter,
  setProbeCIdlePatrolEnabled,
  shouldProbeCIdleAccount,
  startProbeCIdlePatrol,
  stopProbeCIdlePatrol,
  wireProbeCHost,
} from './probeCIdlePatrol.js';
export type {
  ProbeCIdleRoundItem,
  ProbeCIdleSkipReason,
  ProbeCSleepFn,
  ResetProbeCStateOptions,
  RunProbeCIdleRoundOpts,
  StartProbeCIdlePatrolOpts,
  WireProbeCHostOpts,
} from './probeCIdlePatrol.js';
