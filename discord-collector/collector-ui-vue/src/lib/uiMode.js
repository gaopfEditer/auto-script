/**
 * 前端界面模式：
 * - local：本地开发，显示全部页面
 * - deploy：打包部署版，仅保留配置的页面（默认 show + cards）
 *
 * 环境变量（discord-collector/.env*）：
 *   VITE_UI_MODE=local|deploy
 *   VITE_UI_PAGES=show,cards          # deploy 模式白名单（路径名，逗号分隔）
 *
 * 未设置 VITE_UI_MODE 时：开发 → local，生产构建 → deploy
 */

/** @typedef {{ path: string, name: string, label: string, nav?: boolean }} UiPageDef */

/** @type {UiPageDef[]} */
export const ALL_UI_PAGES = [
  { path: "/", name: "home", label: "首页", nav: false },
  { path: "/show", name: "show", label: "Show", nav: true },
  { path: "/cards", name: "cards", label: "卡片", nav: true },
  { path: "/fetch", name: "fetch", label: "拉取", nav: true },
  { path: "/archives", name: "archives", label: "文稿", nav: true },
  { path: "/trade", name: "trade", label: "下单", nav: true },
  { path: "/signals", name: "signals", label: "信号", nav: false },
  { path: "/debug", name: "debug", label: "Debug", nav: true },
];

const DEFAULT_DEPLOY_PAGES = ["show", "cards"];

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

/** 顶栏导航项（仅 nav:true 且已启用） */
export function getNavPages() {
  const enabled = getEnabledPageNames();
  return ALL_UI_PAGES.filter((p) => p.nav && enabled.has(p.name));
}

/** 部署版默认落地页 */
export function getDefaultDeployPath() {
  const enabled = getEnabledPageNames();
  if (enabled.has("show")) return "/show";
  if (enabled.has("cards")) return "/cards";
  const first = ALL_UI_PAGES.find((p) => enabled.has(p.name) && p.path !== "/");
  return first?.path ?? "/show";
}
