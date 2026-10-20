export const SEGMENT_MERGE_CONFLICT_CODE = "SEGMENT_MERGE_CONFLICT" as const;

export class SegmentMergeConflictError extends Error {
  readonly code = SEGMENT_MERGE_CONFLICT_CODE;

  constructor(message = "分段录制 (segment) 与自动分段合并 (autoFragmentMerge) 不能同时开启") {
    super(message);
    this.name = "SegmentMergeConflictError";
  }
}

/**
 * 判定 segment 是否处于激活状态。
 * 复制 liveManager parseSizeToBytes 语义但不依赖 liveManager：
 * - undefined/null/""/空白/0/"0"/负数/NaN/无效字符串/"0MB" => false
 * - 正有限数字或数字字符串 => true
 * - 正数且后缀 B/KB/MB/GB（大小写不敏感，无内部空格）=> true
 * - "100 MB"、"100M" 等当前 parser 判为 0 的值 => false
 */
export function isSegmentActive(segment: unknown): boolean {
  if (segment === undefined || segment === null) {
    return false;
  }

  if (typeof segment === "number") {
    return Number.isFinite(segment) && segment > 0;
  }

  if (typeof segment === "string") {
    const trimmed = segment.trim();
    if (!trimmed) {
      return false;
    }

    const num = Number(trimmed);
    if (!Number.isNaN(num)) {
      return Number.isFinite(num) && num > 0;
    }

    const sizePattern = /^(\d+(?:\.\d+)?)(B|KB|MB|GB)$/i;
    const match = trimmed.match(sizePattern);
    if (!match) {
      return false;
    }

    const size = parseFloat(match[1]);
    return Number.isFinite(size) && size > 0;
  }

  return false;
}

export interface SegmentMergeExclusiveInput {
  segment?: unknown;
  autoFragmentMerge?: unknown;
  [key: string]: unknown;
}

/**
 * 断言分段录制与分段自动合并互斥。
 * 当 segment active 且 autoFragmentMerge 严格为 true 时，
 * 抛出携带稳定 code="SEGMENT_MERGE_CONFLICT" 的 SegmentMergeConflictError。
 */
export function assertSegmentMergeExclusive(
  input?: SegmentMergeExclusiveInput | null,
): void {
  const segmentActive = isSegmentActive(input?.segment);
  const autoFragmentMergeActive = input?.autoFragmentMerge === true;

  if (segmentActive && autoFragmentMergeActive) {
    throw new SegmentMergeConflictError();
  }
}

export type GlobalSegmentMergeConflictInput = {
  readonly newGlobalSegment: unknown;
  readonly currentRecorders: unknown;
  readonly incomingRecorders?: unknown;
};

function recorderId(recorder: unknown): string | undefined {
  if (typeof recorder !== "object" || recorder === null || !("id" in recorder)) {
    return undefined;
  }
  const id = recorder.id;
  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }
  return undefined;
}

/**
 * 按 id 合并 current 与 incoming：incoming 同 id 覆盖 current，
 * current 未出现在 incoming 的仍保留；incoming 为非数组时仅保留 current。
 */
function mergeRecordersById(
  currentRecorders: unknown,
  incomingRecorders: unknown,
): unknown[] {
  const current = Array.isArray(currentRecorders) ? currentRecorders : [];
  if (!Array.isArray(incomingRecorders)) {
    return current;
  }
  const incomingIds = new Set<string>();
  for (const recorder of incomingRecorders) {
    const id = recorderId(recorder);
    if (id !== undefined) {
      incomingIds.add(id);
    }
  }
  const keptCurrent = current.filter((recorder) => {
    const id = recorderId(recorder);
    return id === undefined || !incomingIds.has(id);
  });
  return [...keptCurrent, ...incomingRecorders];
}

/**
 * 全局 segment 与房间 autoFragmentMerge 是否冲突：
 * 仅当 newGlobalSegment active，且房间未把 segment 列入 noGlobalFollowFields，
 * 且 autoFragmentMerge 严格为 true。
 */
export function hasGlobalSegmentMergeConflict(
  input: GlobalSegmentMergeConflictInput,
): boolean {
  if (!isSegmentActive(input.newGlobalSegment)) {
    return false;
  }
  const recorders = mergeRecordersById(
    input.currentRecorders,
    input.incomingRecorders,
  );
  for (const recorder of recorders) {
    if (typeof recorder !== "object" || recorder === null) {
      continue;
    }
    const noGlobalFollowFields =
      "noGlobalFollowFields" in recorder && Array.isArray(recorder.noGlobalFollowFields)
        ? recorder.noGlobalFollowFields
        : [];
    const autoFragmentMerge =
      "autoFragmentMerge" in recorder ? recorder.autoFragmentMerge : undefined;
    if (!noGlobalFollowFields.includes("segment") && autoFragmentMerge === true) {
      return true;
    }
  }
  return false;
}

export function assertGlobalSegmentMergeConflict(
  input: GlobalSegmentMergeConflictInput,
): void {
  if (hasGlobalSegmentMergeConflict(input)) {
    throw new SegmentMergeConflictError();
  }
}
