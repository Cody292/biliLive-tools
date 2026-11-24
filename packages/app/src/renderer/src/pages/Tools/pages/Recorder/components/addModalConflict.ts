import { isSegmentActive } from "@biliLive-tools/shared/recorder/segmentPolicy.js";

export interface SegmentMergeStateInput {
  globalSegment: unknown;
  ownSegment: unknown;
  isGlobalInherited: boolean;
  autoFragmentMerge: boolean;
}

export interface SegmentMergeExclusionDecision {
  isGlobalSegmentActive: boolean;
  isEffectiveSegmentActive: boolean;
  isAutoFragmentMergeActive: boolean;
  hasConflict: boolean;
  autoFragmentMergeDisabled: boolean;
  segmentSwitchDisabled: boolean;
  globalSegmentDisabled: boolean;
  mergeFeedback?: string;
  mergeValidationStatus?: "warning";
  segmentFeedback?: string;
  segmentValidationStatus?: "warning";
}

export function resolveSegmentMergeExclusion(
  input: SegmentMergeStateInput,
): SegmentMergeExclusionDecision {
  const isGlobalSegmentActive = isSegmentActive(input.globalSegment);
  const isOwnSegmentActive = isSegmentActive(input.ownSegment);
  const isEffectiveSegmentActive = input.isGlobalInherited
    ? isGlobalSegmentActive
    : isOwnSegmentActive;
  const isAutoFragmentMergeActive = input.autoFragmentMerge === true;

  // 既有双开脏配置冲突
  const hasConflict = isEffectiveSegmentActive && isAutoFragmentMergeActive;

  // 1. 合并开关禁用条件：有效分段开启且合并未开启时，不能再打开合并；
  //    若已开启合并（双开冲突），允许关闭合并以解除冲突。
  const autoFragmentMergeDisabled = isEffectiveSegmentActive && !isAutoFragmentMergeActive;

  // 2. 本地分段开关禁用条件：
  //    - 继承全局时，本地开关自然禁用；
  //    - 本地模式下，若合并已开启且本地分段未开启，不能再打开本地分段；
  //    - 若本地分段已开启（双开冲突），允许关闭分段以解除冲突。
  const segmentSwitchDisabled =
    input.isGlobalInherited || (isAutoFragmentMergeActive && !isOwnSegmentActive);

  // 3. 全局复选框禁用条件：
  //    - 当合并开启且当前未继承全局时，若全局分段处于启用状态，禁止改为继承启用的全局分段；
  //    - 若全局分段未启用，继承它不产生冲突，完全合法允许；
  //    - 若当前已继承全局（处于冲突或非冲突），允许取消勾选全局（停用继承切换本地覆盖）以解除冲突。
  const globalSegmentDisabled =
    isAutoFragmentMergeActive && !input.isGlobalInherited && isGlobalSegmentActive;

  let mergeFeedback: string | undefined;
  let mergeValidationStatus: "warning" | undefined;
  if (hasConflict) {
    mergeValidationStatus = "warning";
    mergeFeedback = "分段与碎片自动合并不能同时开启，请关闭其中一方解除冲突";
  } else if (autoFragmentMergeDisabled) {
    mergeFeedback = "分段录制已开启，如需合并碎片请先关闭分段";
  }

  let segmentFeedback: string | undefined;
  let segmentValidationStatus: "warning" | undefined;
  if (hasConflict) {
    segmentValidationStatus = "warning";
    if (input.isGlobalInherited) {
      segmentFeedback =
        "继承的全局分段与碎片合并冲突，可取消勾选“全局”切换本地关闭分段，或关闭碎片合并";
    } else {
      segmentFeedback = "本地分段与碎片合并冲突，可关闭分段或关闭碎片合并";
    }
  } else if (isAutoFragmentMergeActive) {
    if (!input.isGlobalInherited) {
      if (isGlobalSegmentActive) {
        segmentFeedback = "碎片合并已开启，不可开启本地分段或继承已启用的全局分段";
      } else {
        segmentFeedback = "碎片合并已开启，不可开启本地分段";
      }
    }
  }

  return {
    isGlobalSegmentActive,
    isEffectiveSegmentActive,
    isAutoFragmentMergeActive,
    hasConflict,
    autoFragmentMergeDisabled,
    segmentSwitchDisabled,
    globalSegmentDisabled,
    mergeFeedback,
    mergeValidationStatus,
    segmentFeedback,
    segmentValidationStatus,
  };
}
