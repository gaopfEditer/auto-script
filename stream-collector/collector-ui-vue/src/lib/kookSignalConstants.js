/** 入场核验选项（与 DB entry_type 一致） */
export const KOOK_ENTRY_TYPE_OPTIONS = [
  { value: "precise", label: "精准入场" },
  { value: "near_miss", label: "差一点入场" },
  { value: "near_stop_loss", label: "差点打损" },
  { value: "bad_entry_no_sl", label: "进场位不好，但未打损" },
  { value: "none", label: "未入场" },
];

/** @param {string | null | undefined} entryType */
export function entryTypeLabel(entryType) {
  const s = String(entryType ?? "").trim();
  const hit = KOOK_ENTRY_TYPE_OPTIONS.find((o) => o.value === s);
  return hit?.label ?? "";
}
