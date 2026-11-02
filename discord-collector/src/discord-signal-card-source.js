/**
 * 信号卡入库 source / source_type / source_ref（Gateway、巨鲸 API 等）。
 */
import { parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

/** 与 discord_signal_cards.source VARCHAR(64) 对齐（最长 kolvip_api_backfill=19） */
export const SIGNAL_CARD_SOURCE_MAX_LENGTH = 64;

/** @type {readonly string[]} */
export const KOLVIP_SIGNAL_CARD_SOURCES = Object.freeze([
  "kolvip_api",
  "kolvip_api_scan",
  "kolvip_api_backfill",
  "kolvip_cdp",
]);

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

/**
 * @param {string} source
 */
export function assertSignalCardSourceLength(source) {
  const s = String(source ?? "");
  if (s.length > SIGNAL_CARD_SOURCE_MAX_LENGTH) {
    throw new Error(
      `signal card source 过长 (${s.length} > ${SIGNAL_CARD_SOURCE_MAX_LENGTH}): ${s.slice(0, 48)}`
    );
  }
}
