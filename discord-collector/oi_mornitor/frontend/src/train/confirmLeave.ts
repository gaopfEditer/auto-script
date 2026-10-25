import { getActiveSessionId, getSession } from "./storage";

export const TRAIN_LEAVE_CONFIRM_MSG =
  "当前对局进行中，确定退出吗？进度已自动保存，稍后可继续。";

/** 是否存在未结束的进行中对局 */
export function hasRunningTrainSession(): boolean {
  const id = getActiveSessionId();
  if (!id) return false;
  return getSession(id)?.status === "running";
}

/** 无进行中局，或用户确认离开 */
export function confirmLeaveRunningTrain(): boolean {
  if (!hasRunningTrainSession()) return true;
  return window.confirm(TRAIN_LEAVE_CONFIRM_MSG);
}
