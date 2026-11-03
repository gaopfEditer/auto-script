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
export function isKolvipIngestSource(source) {
  return String(source ?? "").trim().startsWith("kolvip");
}

/** 巨鲸精选频道 API 周回溯入库 source */
export function isKolvipApiBackfillSource(source) {
  return String(source ?? "").trim() === "kolvip_api_backfill";
}

/**
 * 规则解析失败后是否调用 Ollama（live 默认开；回溯默认关，见 OLLAMA_BACKFILL_ENABLED）。
 * @param {Record<string, unknown>} row
 * @param {{ skipAiFallback?: boolean; debugSimulate?: boolean }} [opts]
 * @param {{ ollamaEnabled: boolean; ollamaBackfillEnabled: boolean }} cfg
 */
export function shouldRunOllamaIngestFallback(row, opts = {}, cfg) {
  if (!cfg.ollamaEnabled) return false;
  if (opts.debugSimulate) return false;
  if (cfg.ollamaBackfillEnabled) return true;
  if (opts.skipAiFallback) return false;
  if (isKolvipApiBackfillSource(row.source)) return false;
  return true;
}

/**
 * 旧卡 source=auto/gateway 或较早 kolvip 值 → 允许写入回溯/扫描 source。
 * @param {unknown} existingSource
 * @param {unknown} desiredSource
 */
export function legacySignalSourceNeedsKolvipUpgrade(existingSource, desiredSource) {
  const prev = String(existingSource ?? "auto").trim() || "auto";
  const next = String(desiredSource ?? "").trim();
  if (!next.startsWith("kolvip")) return false;
  if (prev === next) return false;
  if (prev === "auto" || prev === "gateway_ws" || prev === "rest") return true;
  if (prev.startsWith("kolvip") && prev !== next) return true;
  return false;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {Record<string, unknown>} row
 * @param {{ info?: (msg: string) => void } | null} [log]
 */
export async function upgradeKolvipSignalCardSourceFromRow(store, row, log = null) {
  const messageId = String(row.messageId ?? row.message_id ?? "").trim();
  if (!messageId || !store.getSignalCardByMessageId || !store.updateSignalCard) {
    return { upgraded: false };
  }
  const desired = resolveSignalCardInsertSource(row);
  if (!isKolvipIngestSource(desired.source)) {
    return { upgraded: false };
  }
  assertSignalCardSourceLength(desired.source);

  const existing = await store.getSignalCardByMessageId(messageId);
  if (!existing) return { upgraded: false };

  const prevSource = String(existing.source ?? "auto");
  if (!legacySignalSourceNeedsKolvipUpgrade(prevSource, desired.source)) {
    return { upgraded: false, reason: "no_upgrade_needed" };
  }

  const id = Number(existing.id ?? existing.ID);
  if (!Number.isFinite(id) || id <= 0) return { upgraded: false };

  const channelId = String(row.channelId ?? row.channel_id ?? "").trim();
  const prevChannel = String(existing.channel_id ?? existing.channelId ?? "").trim();
  /** @type {{ source: string, sourceType: string, sourceRef: string, channelId?: string }} */
  const patch = {
    source: desired.source,
    sourceType: desired.sourceType,
    sourceRef: desired.sourceRef,
  };
  if (channelId && channelId !== prevChannel) {
    patch.channelId = channelId;
  }

  await store.updateSignalCard(id, patch);
  log?.info?.(
    `信号卡升级 source #${id} message=${messageId} ${prevSource} → ${desired.source}` +
      (patch.channelId ? ` channel=${prevChannel}→${channelId}` : "")
  );
  const updated = (await store.getSignalCardById?.(id)) ?? existing;
  return { upgraded: true, source: desired.source, cardId: id, card: updated };
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
