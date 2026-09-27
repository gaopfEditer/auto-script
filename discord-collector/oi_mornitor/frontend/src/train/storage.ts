import type { CapitalConfig, TrainConfig, TrainSession } from "./types";
import { DEFAULT_CAPITAL, DEFAULT_TRAIN_CONFIG } from "./defaults";

const SESSIONS_KEY = "train_sessions_v1";
const RUNNING_KEY = "train_running_session_v1";
const CONFIG_KEY = "train_config_v1";
const CAPITAL_KEY = "train_capital_v1";
const ACTIVE_KEY = "train_active_session_id";

const MAX_ENDED_SESSIONS = 24;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeRaw(key: string, raw: string): boolean {
  try {
    localStorage.setItem(key, raw);
    return localStorage.getItem(key) === raw;
  } catch {
    return false;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    return writeRaw(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

/** 归档局去掉高周期全量 K，减小体积；复盘仍可用 15m */
function compactSessionForArchive(session: TrainSession): TrainSession {
  const candles = session.candles;
  return {
    ...session,
    candlesByTf: session.candlesByTf
      ? {
          "15m": candles,
          "1h": session.candlesByTf["1h"]?.slice(-160),
          "4h": session.candlesByTf["4h"]?.slice(-120),
        }
      : undefined,
  };
}

function stripArchiveHeavy(session: TrainSession): TrainSession {
  return {
    ...session,
    candlesByTf: undefined,
  };
}

function readRunningSession(): TrainSession | null {
  return readJson<TrainSession | null>(RUNNING_KEY, null);
}

function readEndedSessions(): TrainSession[] {
  return readJson<TrainSession[]>(SESSIONS_KEY, []);
}

function migrateLegacyRunningIntoSplitStore() {
  if (localStorage.getItem(RUNNING_KEY)) return;
  const all = readEndedSessions();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  let running =
    (activeId ? all.find((s) => s.id === activeId && s.status === "running") : undefined) ??
    all.find((s) => s.status === "running");
  if (!running) return;
  writeJson(RUNNING_KEY, running);
  writeJson(
    SESSIONS_KEY,
    all.filter((s) => s.id !== running!.id),
  );
}

function persistEndedList(sessions: TrainSession[]): boolean {
  let list = sessions.slice(0, MAX_ENDED_SESSIONS);

  for (let attempt = 0; attempt < 8; attempt++) {
    if (writeJson(SESSIONS_KEY, list)) return true;

    if (list.length > 1) {
      list = list.slice(0, list.length - 1);
      continue;
    }
    if (list.length === 1) {
      const compact = compactSessionForArchive(list[0]!);
      if (writeJson(SESSIONS_KEY, [compact])) return true;
      const stripped = stripArchiveHeavy(compact);
      if (writeJson(SESSIONS_KEY, [stripped])) return true;
      list = [];
      continue;
    }
    localStorage.removeItem(SESSIONS_KEY);
    return true;
  }
  return false;
}

function persistRunningSession(session: TrainSession): boolean {
  const attempts: TrainSession[] = [
    session,
    compactSessionForArchive(session),
    {
      ...session,
      candlesByTf: session.candlesByTf
        ? { "15m": session.candles, "1h": session.candlesByTf["1h"]?.slice(-120) }
        : undefined,
    },
    { ...session, candlesByTf: { "15m": session.candles } },
  ];

  for (const variant of attempts) {
    if (writeJson(RUNNING_KEY, variant)) return true;
  }

  // 仍失败：清空已结束对局再给进行中腾地方
  localStorage.removeItem(SESSIONS_KEY);
  for (const variant of attempts) {
    if (writeJson(RUNNING_KEY, variant)) return true;
  }
  return false;
}

export function loadTrainConfig(): TrainConfig {
  const raw = readJson<Partial<TrainConfig>>(CONFIG_KEY, {});
  return {
    ...DEFAULT_TRAIN_CONFIG,
    ...raw,
    capital: { ...DEFAULT_CAPITAL, ...raw.capital },
    indicators: { ...DEFAULT_TRAIN_CONFIG.indicators, ...raw.indicators },
  };
}

export function saveTrainConfig(config: TrainConfig) {
  writeJson(CONFIG_KEY, config);
}

export function loadCapitalDefaults(): CapitalConfig {
  return {
    ...DEFAULT_CAPITAL,
    ...readJson<Partial<CapitalConfig>>(CAPITAL_KEY, {}),
    requireStopLoss: false,
    leverage: 20,
  };
}

export function saveCapitalDefaults(capital: CapitalConfig) {
  writeJson(CAPITAL_KEY, capital);
}

export function listSessions(): TrainSession[] {
  migrateLegacyRunningIntoSplitStore();
  const ended = readEndedSessions();
  const running = readRunningSession();
  if (!running) return ended;
  return [running, ...ended.filter((s) => s.id !== running.id)];
}

export function getSession(id: string): TrainSession | undefined {
  migrateLegacyRunningIntoSplitStore();
  const running = readRunningSession();
  if (running?.id === id) return running;
  return readEndedSessions().find((s) => s.id === id);
}

/** @returns 是否已成功持久化（可读回） */
export function upsertSession(session: TrainSession): boolean {
  migrateLegacyRunningIntoSplitStore();

  if (session.status === "running") {
    const ok = persistRunningSession(session);
    if (ok) localStorage.setItem(ACTIVE_KEY, session.id);
    return ok && getSession(session.id) != null;
  }

  const running = readRunningSession();
  if (running?.id === session.id) {
    localStorage.removeItem(RUNNING_KEY);
    if (localStorage.getItem(ACTIVE_KEY) === session.id) {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }

  const ended = readEndedSessions().filter((s) => s.id !== session.id);
  ended.unshift(compactSessionForArchive(session));
  const ok = persistEndedList(ended);
  return ok && getSession(session.id) != null;
}

export function getActiveSessionId(): string | null {
  migrateLegacyRunningIntoSplitStore();
  const id = localStorage.getItem(ACTIVE_KEY);
  if (!id) return null;
  const session = getSession(id);
  if (!session || session.status !== "running") {
    localStorage.removeItem(ACTIVE_KEY);
    return null;
  }
  return id;
}

export function clearActiveSessionId() {
  localStorage.removeItem(ACTIVE_KEY);
  localStorage.removeItem(RUNNING_KEY);
}

/** 释放空间：去掉 demo，只保留最近 keepEnded 局已结束记录 */
export function reclaimTrainStorage(keepEnded = 8): number {
  migrateLegacyRunningIntoSplitStore();
  let ended = readEndedSessions().filter((s) => !s.id.startsWith("demo-"));
  ended.sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
  if (keepEnded <= 0) ended = [];
  else ended = ended.slice(0, keepEnded);
  persistEndedList(ended);
  return readEndedSessions().length;
}

export function exportSessionsJson(): string {
  return JSON.stringify({ sessions: listSessions(), exportedAt: Date.now() }, null, 2);
}
