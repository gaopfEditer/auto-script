import { humanBaseAsset } from "./symbol";

/** CDN 图标源（按优先级）；失败后依次回退，最后显示字母。 */
const ICON_URL_BUILDERS: Array<(base: string) => string> = [
  (base) => `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${base}.svg`,
  (base) => `https://cdn.jsdelivr.net/gh/prasangapokharel/crypto-icons@v1.0.0/crypto/${base}.svg`,
  (base) => `https://assets.coincap.io/assets/icons/${base}@2x.png`,
];

const STORAGE_KEY = "oi-coin-icon-cache-v1";

/** base → 已解析 URL；null 表示确认无图标（用字母） */
const memoryCache = new Map<string, string | null>();
let storageHydrated = false;

function hydrateFromStorage(): void {
  if (storageHydrated || typeof localStorage === "undefined") {
    storageHydrated = true;
    return;
  }
  storageHydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string | null>;
    for (const [base, url] of Object.entries(parsed)) {
      if (!base) continue;
      if (url === null || typeof url === "string") memoryCache.set(base, url);
    }
  } catch {
    /* ignore corrupt cache */
  }
}

function persistCache(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const obj: Record<string, string | null> = {};
    for (const [base, url] of memoryCache) obj[base] = url;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / private mode */
  }
}

export function coinIconBase(symbol: string): string {
  return humanBaseAsset(symbol).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function coinIconSourceCount(): number {
  return ICON_URL_BUILDERS.length;
}

export function coinIconUrl(symbol: string, sourceIndex = 0): string | null {
  const base = coinIconBase(symbol);
  if (!base) return null;
  const builder = ICON_URL_BUILDERS[sourceIndex];
  if (!builder) return null;
  return builder(base);
}

/** 读缓存：undefined=未试过；null=确认无图；string=可用 URL */
export function getCachedCoinIconUrl(symbol: string): string | null | undefined {
  hydrateFromStorage();
  const base = coinIconBase(symbol);
  if (!base) return null;
  if (!memoryCache.has(base)) return undefined;
  return memoryCache.get(base);
}

export function rememberCoinIconUrl(symbol: string, url: string | null): void {
  hydrateFromStorage();
  const base = coinIconBase(symbol);
  if (!base) return;
  const prev = memoryCache.get(base);
  if (memoryCache.has(base) && prev === url) return;
  memoryCache.set(base, url);
  persistCache();
}

/** 缓存 URL 失效时清除，便于重新探测 */
export function forgetCoinIconUrl(symbol: string): void {
  hydrateFromStorage();
  const base = coinIconBase(symbol);
  if (!base || !memoryCache.has(base)) return;
  memoryCache.delete(base);
  persistCache();
}

/** 组件首屏：有缓存直接用；否则从源 0 开始试 */
export function resolveCoinIconSrc(symbol: string): {
  src: string | null;
  sourceIndex: number;
  fromCache: boolean;
} {
  const cached = getCachedCoinIconUrl(symbol);
  if (cached === null) {
    return { src: null, sourceIndex: coinIconSourceCount(), fromCache: true };
  }
  if (typeof cached === "string") {
    return { src: cached, sourceIndex: -1, fromCache: true };
  }
  return { src: coinIconUrl(symbol, 0), sourceIndex: 0, fromCache: false };
}
