/**
 * 前端界面模式：
 * - local：本地开发，显示全部页面（含 Local 模块工具页）
 * - deploy：打包部署版，仅保留配置的页面（默认 show + cards + eval + community + oi）
 *
 * 顶层模块：
 * - discord：Show / 卡片 / 评估 / 社区
 * - oi：OI Monitor（可切换；运行时探测 oi_mornitor 后嵌入）
 * - local：本机工具（Telegram / 拉取 / 文稿 / Debug）——仅开发态，不进部署包
 *
 * 环境变量（discord-collector/.env*）：
 *   VITE_UI_MODE=local|deploy
 *   VITE_UI_PAGES=show,cards,eval,community,oi   # deploy 模式白名单（路径名，逗号分隔）
 *   VITE_OI_EMBED_URL=http://127.0.0.1:5173  # 可选，oi:dev 时指向 Vite
 *
 * 未设置 VITE_UI_MODE 时：开发 → local，生产构建 → deploy
 */

/** @typedef {{ path: string, name: string, label: string, nav?: boolean, module?: "discord" | "oi" | "local" | "content" }} UiPageDef */

/** 仅本机 Local 模块；deploy 构建一律剔除（即使误写进 VITE_UI_PAGES） */
export const LOCAL_ONLY_PAGE_NAMES = Object.freeze([
  "manual-stats",
  "telegram",
  "fetch",
  "archives",
  "debug",
]);

/** @type {UiPageDef[]} */
export const ALL_UI_PAGES = [
  { path: "/", name: "home", label: "首页", nav: false, module: "discord" },
  { path: "/show", name: "show", label: "Show", nav: true, module: "discord" },
  { path: "/cards", name: "cards", label: "卡片", nav: true, module: "discord" },
  { path: "/eval", name: "eval", label: "评估", nav: true, module: "discord" },
  { path: "/community", name: "community", label: "社区", nav: true, module: "discord" },
  { path: "/local/manual-stats", name: "manual-stats", label: "手动统计", nav: true, module: "local" },
  { path: "/telegram", name: "telegram", label: "Telegram", nav: true, module: "local" },
  { path: "/fetch", name: "fetch", label: "拉取", nav: true, module: "local" },
  { path: "/archives", name: "archives", label: "文稿", nav: true, module: "local" },
  { path: "/debug", name: "debug", label: "Debug", nav: true, module: "local" },
  /** 独立页：不进 Discord/OI/Local 顶栏，全屏自管 */
  { path: "/content", name: "content", label: "内容", nav: false, module: "content" },
  { path: "/oi", name: "oi", label: "OI", nav: false, module: "oi" },
];

/** @type {{ id: "discord" | "oi" | "local", label: string, to: string }[]} */
export const UI_MODULES = [
  { id: "discord", label: "Discord", to: "/show" },
  { id: "oi", label: "OI Monitor", to: "/oi" },
  { id: "local", label: "Local", to: "/local/manual-stats" },
];

const DEFAULT_DEPLOY_PAGES = ["show", "cards", "eval", "community", "oi"];

/**
 * @returns {"local" | "deploy"}
 */
export function getUiMode() {
  const raw = String(import.meta.env.VITE_UI_MODE ?? "").trim().toLowerCase();
  if (raw === "local" || raw === "dev" || raw === "full") return "local";
  if (raw === "deploy" || raw === "prod" || raw === "production") return "deploy";
  // 未配置：开发服全开，打包默认精简
  return import.meta.env.DEV ? "local" : "deploy";
}

export function isDeployUi() {
  return getUiMode() === "deploy";
}

/**
 * @returns {Set<string>} page names（如 show、cards）
 */
export function getEnabledPageNames() {
  if (!isDeployUi()) {
    return new Set(ALL_UI_PAGES.map((p) => p.name));
  }
  const raw = String(import.meta.env.VITE_UI_PAGES ?? "").trim();
  const list = raw
    ? raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_DEPLOY_PAGES;
  // 允许用路径别名
  const normalized = list.map((s) => s.replace(/^\//, "").replace(/-/g, "_"));
  const set = new Set(normalized.length ? normalized : DEFAULT_DEPLOY_PAGES);
  // 本机工具页永不进入部署白名单
  for (const name of LOCAL_ONLY_PAGE_NAMES) set.delete(name);
  return set;
}

/**
 * @param {string} name
 */
export function isPageEnabled(name) {
  return getEnabledPageNames().has(String(name));
}

/**
 * 顶栏二级导航。
 * @param {"discord" | "local"} [moduleId="discord"]
 */
export function getNavPages(moduleId = "discord") {
  const enabled = getEnabledPageNames();
  const mod = moduleId === "local" ? "local" : "discord";
  return ALL_UI_PAGES.filter((p) => (p.module ?? "discord") === mod && p.nav && enabled.has(p.name));
}

/** Local 模块是否显示（仅非 deploy） */
export function isLocalModuleEnabled() {
  return !isDeployUi();
}

/**
 * @param {string} path
 * @returns {"discord" | "oi" | "local" | "content"}
 */
export function getModuleFromPath(path) {
  const p = String(path ?? "");
  if (p === "/content" || p.startsWith("/content/")) return "content";
  if (p === "/oi" || p.startsWith("/oi/")) return "oi";
  if (
    p === "/local" ||
    p.startsWith("/local/") ||
    p === "/telegram" ||
    p.startsWith("/telegram/") ||
    p === "/fetch" ||
    p.startsWith("/fetch/") ||
    p === "/archives" ||
    p.startsWith("/archives/") ||
    p === "/debug" ||
    p.startsWith("/debug/")
  ) {
    return "local";
  }
  return "discord";
}

/** OI 模块是否在当前 UI 模式启用 */
export function isOiModuleEnabled() {
  return isPageEnabled("oi");
}

/** 部署版默认落地页 */
export function getDefaultDeployPath() {
  const enabled = getEnabledPageNames();
  const prefer = ["show", "cards", "eval", "community", "oi"];
  for (const name of prefer) {
    if (enabled.has(name)) {
      const page = ALL_UI_PAGES.find((p) => p.name === name);
      if (page?.path) return page.path;
    }
  }
  const first = ALL_UI_PAGES.find(
    (p) => enabled.has(p.name) && p.path !== "/" && (p.module ?? "discord") === "discord"
  );
  return first?.path ?? "/show";
}
