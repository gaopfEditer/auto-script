/**
 * Promat 频道消息结构化解析（写死配置，不读 .env）。
 * 参考话术见项目根目录 promat.txt。
 */
export const PROMAT_ANALYSIS = {
  ollama: {
    enabled: true,
    baseUrl: "http://localhost:11434",
    model: "gemma4:26b",
    timeoutSec: 120,
  },
  /** Promat 结构化发车 → 本机 8000（url/strategy 运行时读 config.js / .env） */
  publish: {
    enabled: true,
    timeoutSec: 30,
  },
};

/** @typedef {typeof PROMAT_ANALYSIS.ollama} PromatOllamaConfig */
/** @typedef {typeof PROMAT_ANALYSIS.publish} PromatPublishConfig */
