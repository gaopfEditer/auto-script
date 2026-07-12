/**
 * 扫描配置目录 *.txt → Ollama 解析 → 写入本地 JSON（同名已存在则跳过）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parsePasteTextToResult, splitPasteText } from "./youtube-paste-parse.js";

/** @typedef {{ running: boolean, currentFile: string | null, lastFinishedAt: string | null, lastStats: Record<string, number> | null }} ScanState */

/** @type {ScanState} */
const scanState = {
  running: false,
  currentFile: null,
  lastFinishedAt: null,
  lastStats: null,
};

/** @param {string} txtName */
function outputJsonName(txtName) {
  const base = path.basename(txtName);
  if (!base.toLowerCase().endsWith(".txt")) return `${base}.json`;
  return `${base.slice(0, -4)}.json`;
}

/**
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} txtName
 */
export function outputPathForTxt(inputDir, outputDir, txtName) {
  return path.join(outputDir, outputJsonName(txtName));
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listTxtFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".txt"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} txtName
 */
async function outputExists(inputDir, outputDir, txtName) {
  try {
    await fs.access(outputPathForTxt(inputDir, outputDir, txtName));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ inputDir: string, outputDir: string, txtName: string, log: ReturnType<typeof import('./logger.js').createLogger>, force?: boolean }} opts
 */
export async function parseTxtFileAndSave({ inputDir, outputDir, txtName, log, force = false }) {
  const srcPath = path.join(inputDir, txtName);
  const outPath = outputPathForTxt(inputDir, outputDir, txtName);

  if (!force && (await outputExists(inputDir, outputDir, txtName))) {
    return { ok: true, skipped: true, txtName, outPath };
  }

  const raw = await fs.readFile(srcPath, "utf8");
  const { title, content } = splitPasteText(raw);
  if (!title || !content) {
    throw new Error(`${txtName}: 第一行标题或正文为空`);
  }

  const result = await parsePasteTextToResult({ title, content, log });
  const stat = await fs.stat(srcPath);

  const payload = {
    sourceFile: txtName,
    sourcePath: srcPath,
    sourceMtimeMs: stat.mtimeMs,
    parsedAt: new Date().toISOString(),
    ...result,
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  log.info(`paste-batch: 已解析 ${txtName} → ${path.basename(outPath)}`);

  return {
    ok: true,
    skipped: false,
    txtName,
    outPath,
    title: result.title,
    content: result.content,
    coinActions: result.coinActions,
    preview: result.preview,
  };
}

/**
 * @param {{ inputDir: string, outputDir: string, log: ReturnType<typeof import('./logger.js').createLogger>, force?: boolean }} opts
 */
export async function scanAndParseTxtFiles({ inputDir, outputDir, log, force = false }) {
  if (scanState.running) {
    return { ok: false, error: "扫描正在进行中", state: { ...scanState } };
  }

  scanState.running = true;
  scanState.currentFile = null;
  const stats = { total: 0, parsed: 0, skipped: 0, failed: 0 };

  try {
    await fs.mkdir(outputDir, { recursive: true });
    const files = await listTxtFiles(inputDir);
    stats.total = files.length;

    for (const txtName of files) {
      scanState.currentFile = txtName;
      try {
        const row = await parseTxtFileAndSave({ inputDir, outputDir, txtName, log, force });
        if (row.skipped) stats.skipped += 1;
        else {
          stats.parsed += 1;
          if (row.coinActions?.length) {
            await syncCoinActionWatches(archiveService, txtName, row, log);
          }
        }
      } catch (e) {
        stats.failed += 1;
        log.warn(`paste-batch: ${txtName} 失败: ${/** @type {Error} */ (e).message}`);
      }
    }

    scanState.lastStats = stats;
    scanState.lastFinishedAt = new Date().toISOString();
    return { ok: true, stats, state: { ...scanState, currentFile: null } };
  } finally {
    scanState.running = false;
    scanState.currentFile = null;
  }
}

/**
 * @param {{ inputDir: string, outputDir: string }} dirs
 */
export async function listPasteFileItems({ inputDir, outputDir }) {
  const files = await listTxtFiles(inputDir);
  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const name of files) {
    const outPath = outputPathForTxt(inputDir, outputDir, name);
    const srcPath = path.join(inputDir, name);
    let srcStat = null;
    try {
      srcStat = await fs.stat(srcPath);
    } catch {
      /* ignore */
    }

    /** @type {Record<string, unknown>} */
    let saved = null;
    try {
      const raw = await fs.readFile(outPath, "utf8");
      saved = JSON.parse(raw);
    } catch {
      /* no output yet */
    }

    const isParsing = scanState.running && scanState.currentFile === name;
    let status = "pending";
    if (isParsing) status = "parsing";
    else if (saved) status = "done";

    items.push({
      name,
      status,
      title: saved?.title ?? saved?.preview?.title ?? null,
      coinActionCount: Array.isArray(saved?.coinActions) ? saved.coinActions.length : 0,
      parsedAt: saved?.parsedAt ?? null,
      hasOutput: Boolean(saved),
      sourceMtimeMs: srcStat?.mtimeMs ?? null,
    });
  }

  return items;
}

/**
 * @param {ReturnType<typeof import('./card-archive-service.js').createCardArchiveService>} [archiveService]
 * @param {string} txtName
 * @param {{ title?: string, content?: string, coinActions?: unknown[] }} result
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
async function syncCoinActionWatches(archiveService, txtName, result, log) {
  if (!archiveService?.registerCoinActionWatches) return;
  const list = Array.isArray(result.coinActions) ? result.coinActions : [];
  if (!list.length) return;
  try {
    await archiveService.registerCoinActionWatches({
      sourceRef: txtName,
      title: result.title,
      rawContent: result.content,
      coinActions: /** @type {Array<Record<string, unknown>>} */ (list),
    });
  } catch (e) {
    log.warn(`coin-action watch ${txtName}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ pasteParseInputDir: string, pasteParseOutputDir: string }} config
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 * @param {{ archiveService?: ReturnType<typeof import('./card-archive-service.js').createCardArchiveService> }} [opts]
 */
export function registerYoutubePasteBatchRoutes(app, config, log, opts = {}) {
  const archiveService = opts.archiveService;
  const dirs = () => ({
    inputDir: config.pasteParseInputDir,
    outputDir: config.pasteParseOutputDir,
  });

  app.get("/api/youtube-fetch/paste-files", async (_req, res) => {
    try {
      const { inputDir, outputDir } = dirs();
      const items = await listPasteFileItems({ inputDir, outputDir });
      res.json({
        ok: true,
        inputDir,
        outputDir,
        scan: { ...scanState },
        items,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/youtube-fetch/paste-files/:name", async (req, res) => {
    try {
      const name = path.basename(String(req.params.name ?? ""));
      if (!name.toLowerCase().endsWith(".txt")) {
        res.status(400).json({ ok: false, error: "无效文件名" });
        return;
      }
      const { inputDir, outputDir } = dirs();
      const outPath = outputPathForTxt(inputDir, outputDir, name);
      const raw = await fs.readFile(outPath, "utf8");
      res.json({ ok: true, data: JSON.parse(raw) });
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ENOENT") {
        res.status(404).json({ ok: false, error: "尚未生成解析结果" });
        return;
      }
      res.status(500).json({ ok: false, error: String(err.message ?? e) });
    }
  });

  app.post("/api/youtube-fetch/paste-files/scan", async (req, res) => {
    try {
      if (scanState.running) {
        res.json({ ok: true, started: false, message: "扫描已在进行", scan: { ...scanState } });
        return;
      }
      const force = Boolean(req.body?.force);
      const { inputDir, outputDir } = dirs();
      void scanAndParseTxtFiles({ inputDir, outputDir, log, force }).catch((e) => {
        log.warn(`paste-batch scan: ${/** @type {Error} */ (e).message}`);
      });
      res.json({ ok: true, started: true, scan: { ...scanState } });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/youtube-fetch/paste-files/:name/parse", async (req, res) => {
    try {
      const name = path.basename(String(req.params.name ?? ""));
      if (!name.toLowerCase().endsWith(".txt")) {
        res.status(400).json({ ok: false, error: "无效文件名" });
        return;
      }
      const force = req.body?.force !== false;
      const { inputDir, outputDir } = dirs();
      const row = await parseTxtFileAndSave({ inputDir, outputDir, txtName: name, log, force });
      if (!row.skipped && row.coinActions?.length) {
        await syncCoinActionWatches(archiveService, name, row, log);
      }
      res.json({ ok: true, ...row });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}

/**
 * @param {{ pasteParseInputDir: string, pasteParseOutputDir: string, pasteParseStartupDelayMs: number }} config
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
export function startPasteBatchService(config, log) {
  const delay = Math.max(0, Number(config.pasteParseStartupDelayMs) || 15_000);
  log.info(
    `paste-batch: ${Math.round(delay / 1000)}s 后扫描 ${config.pasteParseInputDir} → ${config.pasteParseOutputDir}`
  );
  setTimeout(() => {
    void scanAndParseTxtFiles({
      inputDir: config.pasteParseInputDir,
      outputDir: config.pasteParseOutputDir,
      log,
    }).then((r) => {
      if (r.ok && r.stats) {
        log.info(
          `paste-batch: 启动扫描完成 共 ${r.stats.total} · 新解析 ${r.stats.parsed} · 跳过 ${r.stats.skipped} · 失败 ${r.stats.failed}`
        );
      }
    });
  }, delay);
}
