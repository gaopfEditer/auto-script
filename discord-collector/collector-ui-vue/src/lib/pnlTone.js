/**
 * 收益率 / R 数值着色（正=绿，负=红）。
 * @param {unknown} v
 */
export function pnlToneClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return {};
  return { gain: n > 0, loss: n < 0 };
}