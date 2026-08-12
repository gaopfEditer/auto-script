/**
 * 前端界面模式：
 * - local：本地开发，显示全部页面
 * - deploy：打包部署版，仅保留配置的页面（默认 show + cards）
 *
 * 顶层模块：
 * - discord：采集 / 卡片 / 下单等（主体）
 * - oi：OI Monitor（可切换；运行时探测 oi_mornitor 后嵌入）
 *
 * 环境变量（discord-collector/.env*）：
 *   VITE_UI_MODE=local|deploy
 *   VITE_UI_PAGES=show,fetch,oi       # deploy 模式白名单（路径名，逗号分隔）
 *   VITE_OI_EMBED_URL=http://127.0.0.1:5173  # 可选，oi:dev 时指向 Vite
 *
 * 未设置 VITE_UI_MODE 时：开发 → local，生产构建 → deploy
 */

/** @typedef {{ path: string, name: string, label: string, nav?: boolean, module?: "discord" | "oi" | "content" }} UiPageDef */

/** @type {UiPageDef[]} */
export const ALL_UI_PAGES = [
  { path: "/", name: "home", label: "首页", nav: false, module: "discord" },
  { path: "/show", name: "show", label: "Show", nav: true, module: "discord" },
  { path: "/cards", name: "cards", label: "卡片", nav: true, module: "discord" },
  { path: "/fetch", name: "fetch", label: "拉取", nav: true, module: "discord" },
  { path: "/archives", name: "archives", label: "文稿", nav: true, module: "discord" },
  { path: "/trade", name: "trade", label: "下单", nav: true, module: "discord" },
  { path: "/community", name: "community", label: "社区", nav: true, module: "discord" },
  { path: "/signals", name: "signals", label: "信号", nav: false, module: "discord" },
  { path: "/debug", name: "debug", label: "Debug", nav: true, module: "discord" },
  /** 独立页：不进 Discord/OI 顶栏，全屏自管 */
  { path: "/content", name: "content", label: "内容", nav: false, module: "content" },
  { path: "/oi", name: "oi", label: "OI", nav: false, module: "oi" },
];

/** @type {{ id: "discord" | "oi", label: string, to: string }[]} */
export const UI_MODULES = [
  { id: "discord", label: "Discord", to: "/show" },
  { id: "oi", label: "OI Monitor", to: "/oi" },
];

const DEFAULT_DEPLOY_PAGES = ["show", "fetch", "oi"];

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
  return new Set(normalized.length ? normalized : DEFAULT_DEPLOY_PAGES);
}

/**
 * @param {string} name
 */
export function isPageEnabled(name) {
  return getEnabledPageNames().has(String(name));
}

/** 顶栏导航项（仅 Discord 模块、nav:true 且已启用） */
export function getNavPages() {
  const enabled = getEnabledPageNames();
  return ALL_UI_PAGES.filter((p) => (p.module ?? "discord") === "discord" && p.nav && enabled.has(p.name));
}

/**
 * @param {string} path
 * @returns {"discord" | "oi" | "content"}
 */
export function getModuleFromPath(path) {
  const p = String(path ?? "");
  if (p === "/content" || p.startsWith("/content/")) return "content";
  if (p === "/oi" || p.startsWith("/oi/")) return "oi";
  return "discord";
}

/** OI 模块是否在当前 UI 模式启用 */
export function isOiModuleEnabled() {
  return isPageEnabled("oi");
}

/** 部署版默认落地页 */
export function getDefaultDeployPath() {
  const enabled = getEnabledPageNames();
  if (enabled.has("show")) return "/show";
  if (enabled.has("fetch")) return "/fetch";
  if (enabled.has("oi")) return "/oi";
  const first = ALL_UI_PAGES.find(
    (p) => enabled.has(p.name) && p.path !== "/" && (p.module ?? "discord") === "discord"
  );
  return first?.path ?? "/show";
}
