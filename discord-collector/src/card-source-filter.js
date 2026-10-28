/**
 * 卡片 source_type 列表筛选（开放 API、store、列表缓存、前端逻辑共用）。
 */
import {
  MAX_CARD_SOURCE_TYPE_LEN,
  normalizeCardSourceType,
  resolveSourcePlatform,
  resolveSourceProject,
} from "./card-archive-service.js";

export const CARDS_SOURCE_APP = "python-ai-operate";

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseArchiveSourceTypesList(raw) {
  /** @type {string[]} */
  const out = [];
  const add = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s) out.push(s);
  };
  if (Array.isArray(raw)) {
    for (const x of raw) add(x);
  } else {
    const s = String(raw ?? "").trim();
    if (s) {
      for (const part of s.split(/[,;\s]+/)) add(part);
    }
  }
  return [...new Set(out)];
}

/**
 * @param {import("express").Request | { query?: Record<string, unknown> }} req
 */
export function resolveArchiveListSourceTypes(req) {
  const fromSources = parseArchiveSourceTypesList(req.query?.sources);
  if (fromSources.length) return fromSources;
  const single = String(
    req.query?.source ?? req.query?.source_type ?? req.query?.sourceType ?? ""
  ).trim().toLowerCase();
  return single ? [single] : [];
}

/**
 * @param {Record<string, unknown>} body
 */
export function resolveArchiveBodySourceTypes(body) {
  const fromSources = parseArchiveSourceTypesList(body.sources);
  if (fromSources.length) return fromSources;
  const single = String(body.source ?? body.sourceType ?? body.source_type ?? "")
    .trim()
    .toLowerCase();
  return single ? [single] : [];
}

/**
 * 复合 source_type 写入 VARCHAR(32) 时保留 `:platform` 后缀。
 * @param {string} project
 * @param {string} platform
 */
export function fitCompositeSourceType(project, platform) {
  const out = `${project}:${platform}`;
  if (out.length <= MAX_CARD_SOURCE_TYPE_LEN) return out;
  const suffix = `:${platform}`;
  const maxProjectLen = MAX_CARD_SOURCE_TYPE_LEN - suffix.length;
  if (maxProjectLen < 1) return out.slice(0, MAX_CARD_SOURCE_TYPE_LEN);
  return `${project.slice(0, maxProjectLen)}${suffix}`;
}

/**
 * @param {unknown} cardSourceType
 * @param {string} filterToken
 */
export function cardSourceTypeMatchesFilterToken(cardSourceType, filterToken) {
  const want = String(filterToken ?? "").trim().toLowerCase();
  if (!want) return true;
  const st = normalizeCardSourceType(cardSourceType);
  if (!st) return false;
  if (st === want) return true;

  const wantProject = resolveSourceProject(want);
  const wantPlatform = resolveSourcePlatform(want);
  const cardPlatform = resolveSourcePlatform(st);
  const cardProject = resolveSourceProject(st);

  if (wantProject && wantPlatform) {
    return st === `${wantProject}:${wantPlatform}`;
  }

  if (want === CARDS_SOURCE_APP || wantProject === CARDS_SOURCE_APP) {
    return cardProject === CARDS_SOURCE_APP || st.startsWith(`${CARDS_SOURCE_APP}:`);
  }

  if (wantPlatform && wantPlatform === want) {
    return cardPlatform === wantPlatform;
  }

  return cardPlatform === want;
}

/**
 * @param {unknown} cardSourceType
 * @param {string[] | undefined} filterTokens
 */
export function cardSourceTypeMatchesAnyFilter(cardSourceType, filterTokens) {
  const list = Array.isArray(filterTokens)
    ? filterTokens.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!list.length) return true;
  return list.some((token) => cardSourceTypeMatchesFilterToken(cardSourceType, token));
}

/**
 * 生成单条来源筛选项的 SQL 片段（小写比较）。
 * @param {string} filterToken
 * @returns {{ sql: string, params: unknown[] } | null}
 */
export function buildSourceTypeFilterSql(filterToken) {
  const want = String(filterToken ?? "").trim().toLowerCase();
  if (!want) return null;

  const normalized = normalizeCardSourceType(want);
  const wantProject = resolveSourceProject(want);
  const wantPlatform = resolveSourcePlatform(want);

  if (wantProject && wantPlatform && `${wantProject}:${wantPlatform}` === normalized) {
    return { sql: "LOWER(sc.source_type) = ?", params: [normalized] };
  }

  if (want === CARDS_SOURCE_APP) {
    return {
      sql: "(LOWER(sc.source_type) = ? OR LOWER(sc.source_type) LIKE ?)",
      params: [CARDS_SOURCE_APP, `${CARDS_SOURCE_APP}:%`],
    };
  }

  const platform = wantPlatform || want;
  return {
    sql: "(LOWER(sc.source_type) = ? OR LOWER(sc.source_type) LIKE ?)",
    params: [platform, `%:${platform}`],
  };
}

/**
 * @param {string[] | undefined} filterTokens
 * @returns {{ whereParts: string[], params: unknown[] }}
 */
export function buildSourceTypesWhereClause(filterTokens) {
  const list = Array.isArray(filterTokens)
    ? filterTokens.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  /** @type {string[]} */
  const whereParts = [];
  /** @type {unknown[]} */
  const params = [];
  for (const token of list) {
    const part = buildSourceTypeFilterSql(token);
    if (part) {
      whereParts.push(part.sql);
      params.push(...part.params);
    }
  }
  return { whereParts, params };
}
