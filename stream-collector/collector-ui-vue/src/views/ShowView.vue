<script setup>
import { ref, computed, onMounted, nextTick } from "vue";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import { extractChatDisplay } from "../lib/chatExtract.js";

/** @typedef {{ id: string, ts: number, author: string, typeLabel: string, text: string, badges: { db?: boolean, decode?: string }, raw?: unknown }} Line */

const tab = ref("live");
const lines = ref(/** @type {Line[]} */ ([]));
const scrollEl = ref(/** @type {HTMLElement | null} */ (null));
let seq = 0;

function pushFromWire(msg) {
  if (msg.channel !== "frame" || msg.kind !== "ws_frame") return;
  const body = msg.body;
  const j = body && typeof body === "object" && "json" in body ? body.json : null;
  const display = j != null ? extractChatDisplay(j) : extractChatDisplay(null);
  seq += 1;
  lines.value.push({
    id: `live-${msg.seq ?? seq}-${msg.ts}`,
    ts: /** @type {number} */ (msg.ts),
    author: display.author,
    typeLabel: display.typeLabel,
    text: display.text,
    badges: {
      db: Boolean(msg.dbParseOk),
      decode: String(msg.decodeFormat ?? ""),
    },
    raw: j ?? body,
  });
  void nextTick(() => {
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: "smooth" });
  });
}

useCollectorSocket(pushFromWire);

onMounted(async () => {
  try {
    const r = await fetch("/api/frames?limit=80");
    const data = await r.json();
    if (!data.ok || !Array.isArray(data.rows)) return;
    const historical = [];
    for (const row of [...data.rows].reverse()) {
      let parsed = null;
      if (row.parsed_json) {
        try {
          parsed = typeof row.parsed_json === "string" ? JSON.parse(row.parsed_json) : row.parsed_json;
        } catch {
          parsed = null;
        }
      }
      const display = parsed != null ? extractChatDisplay(parsed) : { author: "db", typeLabel: "row", text: row.parse_error || "(无 parsed_json)", extraJson: null };
      historical.push({
        id: `db-${row.id}`,
        ts: new Date(row.received_at).getTime() || Date.now(),
        author: display.author,
        typeLabel: display.typeLabel,
        text: display.text,
        badges: { db: !row.parse_error, decode: `op${row.opcode}` },
        raw: parsed,
      });
    }
    lines.value = [...historical, ...lines.value];
  } catch {
    /* ignore */
  }
});

const visibleLines = computed(() => {
  if (tab.value === "history") {
    return lines.value.filter((l) => l.id.startsWith("db-"));
  }
  if (tab.value === "live") {
    return lines.value.filter((l) => l.id.startsWith("live-"));
  }
  return lines.value;
});

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="show-app">
    <aside class="guild-rail">
      <div class="guild-icon" title="CDP">CDP</div>
    </aside>
    <aside class="channel-panel">
      <div class="channel-head">频道</div>
      <div class="channel-list">
        <div :class="['channel-item', { active: tab === 'live' }]" @click="tab = 'live'"># live-feed</div>
        <div :class="['channel-item', { active: tab === 'history' }]" @click="tab = 'history'"># mysql 历史</div>
        <div :class="['channel-item', { active: tab === 'all' }]" @click="tab = 'all'"># 全部合并</div>
      </div>
    </aside>
    <section class="main">
      <header class="main-header">
        # {{ tab === "live" ? "live-feed" : tab === "history" ? "mysql-历史" : "全部" }}
        <span>WS 帧摘要 · 点击左侧切换</span>
      </header>
      <div ref="scrollEl" class="msg-scroll">
        <div v-for="line in visibleLines" :key="line.id" class="msg-row">
          <div class="msg-av" aria-hidden="true" />
          <div class="msg-body">
            <div class="msg-meta">
              <span class="msg-author">{{ line.author }}</span>
              <span class="msg-time">{{ fmtTime(line.ts) }}</span>
              <span class="msg-type">{{ line.typeLabel }}</span>
              <span v-if="line.badges.db !== undefined" :class="['badge', line.badges.db ? 'ok' : 'err']">
                MySQL {{ line.badges.db ? "ok" : "fail" }}
              </span>
              <span v-if="line.badges.decode" class="badge muted">{{ line.badges.decode }}</span>
            </div>
            <div class="msg-text">{{ line.text }}</div>
            <pre v-if="line.raw != null" class="msg-json">{{ JSON.stringify(line.raw, null, 2) }}</pre>
          </div>
        </div>
        <p v-if="visibleLines.length === 0" style="color: var(--muted); padding: 1rem">暂无消息</p>
      </div>
    </section>
  </div>
</template>
