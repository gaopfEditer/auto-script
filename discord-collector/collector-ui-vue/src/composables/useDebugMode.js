import { ref, onMounted } from "vue";

const STORAGE_KEY = "discord-collector.debugMode";

/** @type {import('vue').Ref<boolean>} */
const debugMode = ref(true);

let loaded = false;

async function syncFromServer() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    if (typeof data.debugMode === "boolean") {
      debugMode.value = data.debugMode;
      localStorage.setItem(STORAGE_KEY, data.debugMode ? "1" : "0");
    }
  } catch {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved != null) debugMode.value = saved !== "0";
  }
  loaded = true;
}

/** @param {boolean} on */
async function setDebugMode(on) {
  debugMode.value = on;
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  try {
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: on }),
    });
  } catch {
    /* 离线时仅本地 */
  }
}

export function useDebugMode() {
  if (!loaded) {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved != null) debugMode.value = saved !== "0";
    void syncFromServer();
  }

  onMounted(() => {
    if (!loaded) void syncFromServer();
  });

  /** @param {Record<string, unknown>} msg */
  function applyConfigFromSocket(msg) {
    if (msg.channel === "config" && typeof msg.debugMode === "boolean") {
      debugMode.value = msg.debugMode;
      localStorage.setItem(STORAGE_KEY, msg.debugMode ? "1" : "0");
    }
  }

  return { debugMode, setDebugMode, applyConfigFromSocket };
}
