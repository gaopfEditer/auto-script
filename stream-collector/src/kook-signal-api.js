/**
 * Kook 发车信号标记 + 结果核验 REST。
 * @param {import("express").Express} app
 * @param {import("./store.js").openStore extends (...args: any) => Promise<infer S> ? S : never} store
 */

/** @param {unknown} v */
function triBool(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v === true || v === 1 || v === "1" || v === "true" || v === "yes") return 1;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "no") return 0;
  return null;
}

const ENTRY_TYPES = new Set([
  "precise",
  "near_miss",
  "near_stop_loss",
  "bad_entry_no_sl",
  "none",
]);

/** @param {unknown} v */
function parseEntryType(v) {
  const s = String(v ?? "").trim();
  return ENTRY_TYPES.has(s) ? s : null;
}

export function registerKookSignalRoutes(app, store) {
  /** 标为有效信号（发车） */
  app.post("/api/kook/signals/mark", async (req, res) => {
    const messageId = String(req.body?.messageId ?? "").trim();
    const guildId = String(req.body?.guildId ?? "").trim();
    const channelId = String(req.body?.channelId ?? "").trim();
    if (!messageId || !guildId) {
      res.status(400).json({ ok: false, error: "缺少 messageId 或 guildId" });
      return;
    }
    try {
      await store.upsertSignalMark({ messageId, guildId, channelId, note: req.body?.note ?? null });
      res.json({ ok: true, messageId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.delete("/api/kook/signals/mark/:messageId", async (req, res) => {
    const messageId = String(req.params.messageId ?? "").trim();
    if (!messageId) {
      res.status(400).json({ ok: false, error: "缺少 messageId" });
      return;
    }
    try {
      await store.deleteSignalMark(messageId);
      res.json({ ok: true, messageId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 保存 / 更新单条核验（UPSERT） */
  app.put("/api/kook/signals/review", async (req, res) => {
    const messageId = String(req.body?.messageId ?? "").trim();
    const guildId = String(req.body?.guildId ?? "").trim();
    const channelId = String(req.body?.channelId ?? "").trim();
    if (!messageId || !guildId) {
      res.status(400).json({ ok: false, error: "缺少 messageId 或 guildId" });
      return;
    }
    const entryType = parseEntryType(req.body?.entryType);
    let entryOffset = req.body?.entryOffset;
    if (entryOffset === "" || entryOffset === undefined) entryOffset = null;
    else if (entryOffset != null) entryOffset = Number(entryOffset);

    try {
      const row = await store.upsertSignalReview({
        messageId,
        guildId,
        channelId,
        hitTakeProfit: triBool(req.body?.hitTakeProfit),
        hitStopLoss: triBool(req.body?.hitStopLoss),
        entryType,
        entryOffset: entryType === "near_miss" && entryOffset != null && !Number.isNaN(entryOffset) ? entryOffset : null,
        reviewNote: req.body?.reviewNote ?? null,
      });
      res.json({ ok: true, review: row });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 列表：某群组/频道在时间范围内的信号 + 核验 */
  app.get("/api/kook/signals", async (req, res) => {
    const guildId = String(req.query.guildId ?? req.query.guild_id ?? "").trim();
    const channelId = String(req.query.channelId ?? req.query.channel_id ?? "").trim() || undefined;
    const fromMs = req.query.fromMs != null ? Number(req.query.fromMs) : undefined;
    const toMs = req.query.toMs != null ? Number(req.query.toMs) : undefined;
    const messageIdsRaw = String(req.query.messageIds ?? "").trim();

    try {
      if (messageIdsRaw) {
        const ids = messageIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
        const rows = await store.getSignalsWithReviewsByMessageIds(ids);
        res.json({ ok: true, rows });
        return;
      }
      if (!guildId) {
        res.status(400).json({ ok: false, error: "缺少 guildId 或 messageIds" });
        return;
      }
      const rows = await store.listSignalsWithReviews({
        guildId,
        channelId,
        fromMs: Number.isFinite(fromMs) ? fromMs : undefined,
        toMs: Number.isFinite(toMs) ? toMs : undefined,
      });
      res.json({ ok: true, guildId, rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 按群组分别汇总（不合并）；可选 guildId 仅返回该群组 */
  app.get("/api/kook/signals/summary", async (req, res) => {
    const guildId = String(req.query.guildId ?? req.query.guild_id ?? "").trim() || undefined;
    const fromMs = req.query.fromMs != null ? Number(req.query.fromMs) : undefined;
    const toMs = req.query.toMs != null ? Number(req.query.toMs) : undefined;
    try {
      const summaries = await store.listSignalSummariesByGuild({
        guildId,
        fromMs: Number.isFinite(fromMs) ? fromMs : undefined,
        toMs: Number.isFinite(toMs) ? toMs : undefined,
      });
      res.json({ ok: true, summaries });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}
