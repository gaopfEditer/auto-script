/**
 * 信号卡入库 source / source_type / source_ref（Gateway、巨鲸 API 等）。
 */
import { parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

/**
 * @param {Record<string, unknown>} row ingest 行（含 channelId、source、rawJson）
 */
export function resolveSignalCardInsertSource(row) {
  const channelId = String(row.channelId ?? row.channel_id ?? "").trim();
  const source = String(row.source ?? "").trim() || "auto";
  let sourceType = String(row.sourceType ?? row.source_type ?? "").trim();
  if (!sourceType) {
    if (source.startsWith("kolvip") || parseKolvipScanVirtualChannelId(channelId)) {
      sourceType = "kolvip";
    } else {
      sourceType = "discord";
    }
  }
  let sourceRef = String(row.sourceRef ?? row.source_ref ?? "").trim();
  if (!sourceRef) {
    if (source.startsWith("kolvip")) {
      const raw = row.rawJson ?? row.raw_json;
      const kolvip =
        raw && typeof raw === "object" && raw.kolvip && typeof raw.kolvip === "object"
          ? /** @type {{ channelId?: string }} */ (raw.kolvip)
          : null;
      const kid = String(kolvip?.channelId ?? "").trim();
      sourceRef = kid || parseKolvipScanVirtualChannelId(channelId) || channelId;
    } else {
      sourceRef = channelId;
    }
  }
  return { source, sourceType, sourceRef };
}
