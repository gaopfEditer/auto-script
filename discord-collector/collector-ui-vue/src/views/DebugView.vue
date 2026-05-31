<script setup>
import { ref, computed, onMounted } from "vue";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import { useDebugMode } from "../composables/useDebugMode.js";
import { extractDiscordDisplay } from "../lib/discordExtract.js";
import { isBlockedWsFrame } from "../lib/wsNoiseFilter.js";
import {
  useDebugNetwork,
  nameFromUrl,
  displayStatus,
  statusPillClass,
} from "../lib/useDebugNetwork.js";

defineOptions({ name: "DebugView" });

const tab = ref(/** @type {"network" | "frames"} */ ("network"));
const { netRows, miscEvents, ingest } = useDebugNetwork();
const selected = ref(/** @type {Record<string, unknown> | null} */ (null));
const frameLines = ref(
  /** @type {Array<{ id: string, ts: number, author: string, typeLabel: string, text: string, guildLabel: string, channelLabel: string }>} */ ([])
);
const filterText = ref("");
const { debugMode, applyConfigFromSocket } = useDebugMode();

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  applyConfigFromSocket(msg);
  ingest(msg);
  if (msg.channel === "frame" && msg.kind === "ws_frame") {
    const body = msg.body;
    const j = body && typeof body === "object" && "json" in body ? body.json : null;
    if (isBlockedWsFrame(j)) return;
    const display = extractDiscordDisplay(j, debugMode.value);
    frameLines.value.unshift({
      id: `f-${msg.seq}-${msg.ts}`,
      ts: Number(msg.ts),
      author: display.author,
      typeLabel: display.typeLabel,
      text: display.text,
      guildLabel: display.guildLabel,
      channelLabel: display.channelLabel,
    });
    if (frameLines.value.length > 300) frameLines.value.length = 300;
  }
}

useCollectorSocket(onSocketMsg);

const filteredNet = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return netRows.value;
  return netRows.value.filter((r) => {
    const hay = `${r.name ?? ""} ${r.url ?? ""} ${r.method ?? ""}`.toLowerCase();
    return hay.includes(q) || (q.includes("discord") && String(r.url ?? "").includes("discord"));
  });
});

onMounted(async () => {
  try {
    const res = await fetch("/api/frames?limit=80");
    const data = await res.json();
    if (data.ok && Array.isArray(data.rows)) {
      for (const row of data.rows.slice().reverse()) {
        let j = row.parsed_json;
        if (typeof j === "string") {
          try {
            j = JSON.parse(j);
          } catch {
            j = null;
          }
        }
        if (!j) continue;
        if (isBlockedWsFrame(j)) continue;
        const display = extractDiscordDisplay(j, debugMode.value);
        frameLines.value.push({
          id: `h-${row.id}`,
          ts: new Date(row.received_at).getTime(),
          author: display.author,
          typeLabel: display.typeLabel,
          text: display.text,
          guildLabel: display.guildLabel,
          channelLabel: display.channelLabel,
        });
      }
    }
  } catch {
    /* ignore */
  }
});

function isDiscordRow(row) {
  const u = String(row.url ?? "").toLowerCase();
  return u.includes("discord.com") || u.includes("gateway.discord");
}
</script>

<template>
  <div class="debug-root">
    <aside class="sidebar">
      <div class="tabs">
        <button :class="{ active: tab === 'network' }" @click="tab = 'network'">Network</button>
        <button :class="{ active: tab === 'frames' }" @click="tab = 'frames'">WS 帧</button>
      </div>
      <input v-model="filterText" class="filter" placeholder="过滤 URL…" />
      <p class="mode-line">{{ debugMode ? "Debug：WS/API 全量 JSON" : "精简：仅摘要" }}</p>

      <div v-show="tab === 'network'" class="list">
        <div
          v-for="row in filteredNet"
          :key="String(row.requestId)"
          class="row"
          :class="{ discord: isDiscordRow(row), selected: selected === row }"
          @click="selected = row"
        >
          <span class="pill" :class="statusPillClass(displayStatus(row))">{{ displayStatus(row) }}</span>
          <span class="name">{{ row.name || nameFromUrl(String(row.url ?? '')) }}</span>
        </div>
      </div>

      <div v-show="tab === 'frames'" class="list frames">
        <div v-for="line in frameLines" :key="line.id" class="frame-line">
          <span class="tag">{{ line.typeLabel }}</span>
          <span v-if="line.guildLabel" class="loc">{{ line.guildLabel }}</span>
          <span v-if="line.channelLabel" class="loc">{{ line.channelLabel }}</span>
          <strong>{{ line.author }}</strong>
          <pre v-if="debugMode" class="text full">{{ line.text || "—" }}</pre>
          <span v-else class="text">{{ line.text || "—" }}</span>
        </div>
      </div>
    </aside>

    <section class="detail">
      <template v-if="selected">
        <h3>{{ selected.method }} {{ selected.name }}</h3>
        <pre>{{ JSON.stringify(selected, null, debugMode ? 2 : 0) }}</pre>
      </template>
      <template v-else>
        <p class="hint">左侧选择网络请求；Discord 行高亮。Debug 模式下右侧/WS 帧显示完整 JSON。</p>
        <p class="hint">杂项事件：{{ miscEvents.length }} 条</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.debug-root {
  display: flex;
  height: 100%;
  min-height: 0;
}
.sidebar {
  width: 42%;
  min-width: 280px;
  border-right: 1px solid #1e1f22;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tabs {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
}
.tabs button {
  flex: 1;
  padding: 0.4rem;
  border: none;
  border-radius: 6px;
  background: #2b2d31;
  color: #b5bac1;
  cursor: pointer;
}
.tabs button.active {
  background: #5865f2;
  color: #fff;
}
.filter {
  margin: 0 0.5rem 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
}
.mode-line {
  margin: 0 0.5rem 0.5rem;
  font-size: 0.72rem;
  color: #949ba4;
}
.list {
  flex: 1;
  overflow: auto;
  font-size: 0.82rem;
}
.row {
  padding: 0.35rem 0.6rem;
  cursor: pointer;
  border-bottom: 1px solid #2b2d31;
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.row.discord {
  background: rgba(88, 101, 242, 0.12);
}
.row.selected {
  background: #404249;
}
.pill {
  font-size: 0.7rem;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: #3f4147;
  flex-shrink: 0;
}
.st-2 {
  background: #248046;
}
.st-fail {
  background: #da373c;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.frames .frame-line {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #2b2d31;
  line-height: 1.35;
}
.tag {
  font-size: 0.68rem;
  background: #5865f2;
  color: #fff;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  margin-right: 0.35rem;
}
.loc {
  font-size: 0.68rem;
  color: #949ba4;
  margin-right: 0.35rem;
}
.text {
  color: #949ba4;
  display: block;
  margin-top: 0.15rem;
  word-break: break-word;
}
.text.full {
  font-size: 0.68rem;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
  background: #1e1f22;
  padding: 0.35rem;
  border-radius: 4px;
}
.detail {
  flex: 1;
  overflow: auto;
  padding: 1rem;
}
.detail pre {
  font-size: 0.75rem;
  background: #1e1f22;
  padding: 0.75rem;
  border-radius: 8px;
  overflow: auto;
  max-height: calc(100vh - 120px);
}
.hint {
  color: #949ba4;
}
</style>
