/**
 * 社区数据独立 SQLite（本地文件，不依赖 MySQL）。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** @param {string} iso */
function isoToDatetime3(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return isoToDatetime3(new Date().toISOString());
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** @param {unknown} v */
function jsonCol(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

/** @param {import("node:sqlite").DatabaseSync} db */
function ensureCommunitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE,
      google_sub TEXT UNIQUE,
      password_hash TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'local',
      points INTEGER NOT NULL DEFAULT 0,
      tip_balance INTEGER NOT NULL DEFAULT 0,
      checkin_streak INTEGER NOT NULL DEFAULT 0,
      last_checkin_day TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_community_points ON community_members(points DESC);

    CREATE TABLE IF NOT EXISTS community_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      like_count INTEGER NOT NULL DEFAULT 0,
      comment_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_community_posts_time ON community_posts(id DESC);

    CREATE TABLE IF NOT EXISTS community_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id, id);

    CREATE TABLE IF NOT EXISTS community_likes (
      post_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS community_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      points_earned INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE(member_id, day)
    );

    CREATE TABLE IF NOT EXISTS community_tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_member_id INTEGER NOT NULL,
      to_member_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      zone TEXT NOT NULL DEFAULT 'plaza',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS community_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text',
      content TEXT NOT NULL,
      media_url TEXT NOT NULL DEFAULT '',
      meta_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS community_feed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_type TEXT NOT NULL,
      channel_id TEXT,
      channel_name TEXT,
      card_id INTEGER,
      tweet_id TEXT,
      author_key TEXT,
      author_handle TEXT,
      author_name TEXT,
      author_avatar TEXT,
      content TEXT NOT NULL,
      raw_content TEXT,
      parsed_json TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_community_feed_type_time ON community_feed_messages(feed_type, id DESC);

    CREATE TABLE IF NOT EXISTS community_twitter_authors (
      author_key TEXT PRIMARY KEY,
      handle TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * @param {string} dbPath
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function openCommunitySqliteStore(dbPath, log) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureCommunitySchema(db);
  log.info(`社区 SQLite 就绪: ${dbPath}`);

  async function communityEnsureSchema() {}

  async function communityGetMemberByToken(token) {
    return db.prepare(`SELECT * FROM community_members WHERE token = ? LIMIT 1`).get(String(token)) ?? null;
  }

  async function communityGetMemberByHandle(handle) {
    return (
      db.prepare(`SELECT * FROM community_members WHERE handle = ? LIMIT 1`).get(String(handle).toLowerCase()) ??
      null
    );
  }

  async function communityGetMemberByEmail(email) {
    const e = String(email || "")
      .trim()
      .toLowerCase();
    if (!e) return null;
    return db.prepare(`SELECT * FROM community_members WHERE email = ? LIMIT 1`).get(e) ?? null;
  }

  async function communityGetMemberByGoogleSub(sub) {
    const s = String(sub || "").trim();
    if (!s) return null;
    return db.prepare(`SELECT * FROM community_members WHERE google_sub = ? LIMIT 1`).get(s) ?? null;
  }

  async function communityGetMemberById(id) {
    return db.prepare(`SELECT * FROM community_members WHERE id = ? LIMIT 1`).get(id) ?? null;
  }

  async function communityInsertMember(p) {
    const now = isoToDatetime3(new Date().toISOString());
    const r = db
      .prepare(
        `INSERT INTO community_members (
          token, handle, display_name, avatar_url, bio,
          email, google_sub, password_hash, auth_provider,
          points, tip_balance, checkin_streak, last_checkin_day, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      )
      .run(
        p.token,
        p.handle,
        p.displayName,
        p.avatarUrl || "",
        p.bio || "",
        p.email ? String(p.email).toLowerCase().slice(0, 255) : null,
        p.googleSub ? String(p.googleSub).slice(0, 64) : null,
        p.passwordHash ? String(p.passwordHash).slice(0, 255) : null,
        String(p.authProvider || "local").slice(0, 16),
        Number(p.points) || 0,
        Number(p.tipBalance) || 0,
        now,
        now
      );
    return communityGetMemberById(Number(r.lastInsertRowid));
  }

  async function communityUpdateMember(id, patch) {
    const sets = ["updated_at = ?"];
    const params = [isoToDatetime3(new Date().toISOString())];
    if (patch.displayName != null && String(patch.displayName).trim()) {
      sets.push("display_name = ?");
      params.push(String(patch.displayName).trim());
    }
    if (patch.avatarUrl != null) {
      sets.push("avatar_url = ?");
      params.push(String(patch.avatarUrl));
    }
    if (patch.bio != null) {
      sets.push("bio = ?");
      params.push(String(patch.bio));
    }
    if (patch.token != null) {
      sets.push("token = ?");
      params.push(String(patch.token));
    }
    if (patch.email !== undefined) {
      sets.push("email = ?");
      params.push(patch.email ? String(patch.email).toLowerCase().slice(0, 255) : null);
    }
    if (patch.googleSub !== undefined) {
      sets.push("google_sub = ?");
      params.push(patch.googleSub ? String(patch.googleSub).slice(0, 64) : null);
    }
    if (patch.passwordHash !== undefined) {
      sets.push("password_hash = ?");
      params.push(patch.passwordHash ? String(patch.passwordHash).slice(0, 255) : null);
    }
    if (patch.authProvider != null) {
      sets.push("auth_provider = ?");
      params.push(String(patch.authProvider).slice(0, 16));
    }
    params.push(id);
    db.prepare(`UPDATE community_members SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return communityGetMemberById(id);
  }

  async function communityAddPoints(id, delta, extra = {}) {
    const now = isoToDatetime3(new Date().toISOString());
    const sets = ["points = points + ?", "updated_at = ?"];
    const params = [Number(delta) || 0, now];
    if (extra.checkinStreak != null) {
      sets.push("checkin_streak = ?");
      params.push(Number(extra.checkinStreak) || 0);
    }
    if (extra.lastCheckinDay != null) {
      sets.push("last_checkin_day = ?");
      params.push(String(extra.lastCheckinDay));
    }
    params.push(id);
    db.prepare(`UPDATE community_members SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return communityGetMemberById(id);
  }

  async function communityListMembersByPoints(limit = 20) {
    return db
      .prepare(`SELECT * FROM community_members ORDER BY points DESC, id ASC LIMIT ?`)
      .all(Math.min(200, Math.max(1, limit)));
  }

  async function communityInsertCheckin(p) {
    const now = isoToDatetime3(new Date().toISOString());
    db.prepare(
      `INSERT INTO community_checkins (member_id, day, points_earned, streak, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(p.memberId, p.day, p.pointsEarned, p.streak, now);
  }

  async function communityListCheckins(memberId, limit = 30) {
    return db
      .prepare(`SELECT * FROM community_checkins WHERE member_id = ? ORDER BY day DESC LIMIT ?`)
      .all(memberId, limit);
  }

  async function communityInsertPost(p) {
    const now = isoToDatetime3(new Date().toISOString());
    const r = db
      .prepare(
        `INSERT INTO community_posts (member_id, content, like_count, comment_count, created_at) VALUES (?, ?, 0, 0, ?)`
      )
      .run(p.memberId, p.content, now);
    return { id: Number(r.lastInsertRowid) };
  }

  async function communityGetPost(id) {
    return db.prepare(`SELECT * FROM community_posts WHERE id = ? LIMIT 1`).get(id) ?? null;
  }

  async function communityListPosts(opts = {}) {
    const lim = Math.min(50, Math.max(1, Number(opts.limit) || 30));
    if (opts.beforeId) {
      return db
        .prepare(`SELECT * FROM community_posts WHERE id < ? ORDER BY id DESC LIMIT ?`)
        .all(opts.beforeId, lim);
    }
    return db.prepare(`SELECT * FROM community_posts ORDER BY id DESC LIMIT ?`).all(lim);
  }

  async function communityInsertComment(p) {
    const now = isoToDatetime3(new Date().toISOString());
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO community_comments (post_id, member_id, content, created_at) VALUES (?, ?, ?, ?)`
      ).run(p.postId, p.memberId, p.content, now);
      db.prepare(`UPDATE community_posts SET comment_count = comment_count + 1 WHERE id = ?`).run(p.postId);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  async function communityListComments(postId, limit = 50) {
    return db
      .prepare(`SELECT * FROM community_comments WHERE post_id = ? ORDER BY id ASC LIMIT ?`)
      .all(postId, limit);
  }

  async function communityHasLiked(postId, memberId) {
    const row = db
      .prepare(`SELECT 1 AS n FROM community_likes WHERE post_id = ? AND member_id = ? LIMIT 1`)
      .get(postId, memberId);
    return Boolean(row);
  }

  async function communityAddLike(postId, memberId) {
    const now = isoToDatetime3(new Date().toISOString());
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT OR IGNORE INTO community_likes (post_id, member_id, created_at) VALUES (?, ?, ?)`).run(
        postId,
        memberId,
        now
      );
      db.prepare(`UPDATE community_posts SET like_count = like_count + 1 WHERE id = ?`).run(postId);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  async function communityRemoveLike(postId, memberId) {
    db.exec("BEGIN");
    try {
      const r = db
        .prepare(`DELETE FROM community_likes WHERE post_id = ? AND member_id = ?`)
        .run(postId, memberId);
      if (Number(r.changes) > 0) {
        db.prepare(
          `UPDATE community_posts SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?`
        ).run(postId);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  async function communityTransferTip(p) {
    const now = isoToDatetime3(new Date().toISOString());
    db.exec("BEGIN");
    try {
      const from = db.prepare(`SELECT tip_balance FROM community_members WHERE id = ?`).get(p.fromId);
      const bal = Number(from?.tip_balance) || 0;
      if (bal < p.amount) {
        const err = new Error("打赏币不足");
        err.code = "INSUFFICIENT";
        throw err;
      }
      db.prepare(`UPDATE community_members SET tip_balance = tip_balance - ?, updated_at = ? WHERE id = ?`).run(
        p.amount,
        now,
        p.fromId
      );
      db.prepare(`UPDATE community_members SET tip_balance = tip_balance + ?, updated_at = ? WHERE id = ?`).run(
        p.amount,
        now,
        p.toId
      );
      db.prepare(
        `INSERT INTO community_tips (from_member_id, to_member_id, amount, message, zone, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(p.fromId, p.toId, p.amount, p.message || "", p.zone || "plaza", now);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  async function communityListTips(limit = 40) {
    return db
      .prepare(`SELECT * FROM community_tips ORDER BY id DESC LIMIT ?`)
      .all(Math.min(100, Math.max(1, limit)));
  }

  async function communityLatestTip(fromId, toId) {
    return (
      db
        .prepare(
          `SELECT * FROM community_tips WHERE from_member_id = ? AND to_member_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(fromId, toId) ?? null
    );
  }

  async function communityInsertChatMessage(p) {
    const now = isoToDatetime3(new Date().toISOString());
    const r = db
      .prepare(
        `INSERT INTO community_chat_messages (member_id, msg_type, content, media_url, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        p.memberId,
        String(p.msgType || "text").slice(0, 16),
        String(p.content ?? ""),
        String(p.mediaUrl ?? "").slice(0, 512),
        jsonCol(p.metaJson ?? null),
        now
      );
    return (
      db.prepare(`SELECT * FROM community_chat_messages WHERE id = ? LIMIT 1`).get(Number(r.lastInsertRowid)) ?? null
    );
  }

  async function communityListChatMessages(opts = {}) {
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 50));
    const beforeId = opts.beforeId != null ? Number(opts.beforeId) : null;
    if (Number.isFinite(beforeId) && beforeId > 0) {
      return db
        .prepare(`SELECT * FROM community_chat_messages WHERE id < ? ORDER BY id DESC LIMIT ?`)
        .all(beforeId, limit);
    }
    return db.prepare(`SELECT * FROM community_chat_messages ORDER BY id DESC LIMIT ?`).all(limit);
  }

  async function communityGetChatMessage(id) {
    return db.prepare(`SELECT * FROM community_chat_messages WHERE id = ? LIMIT 1`).get(id) ?? null;
  }

  async function insertCommunityFeedMessage(p) {
    const now = isoToDatetime3(p.createdAt || new Date().toISOString());
    const r = db
      .prepare(
        `INSERT INTO community_feed_messages (
          feed_type, channel_id, channel_name, card_id, tweet_id,
          author_key, author_handle, author_name, author_avatar,
          content, raw_content, parsed_json, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(p.feedType || "card").slice(0, 16),
        p.channelId ? String(p.channelId).slice(0, 64) : null,
        p.channelName ? String(p.channelName).slice(0, 128) : null,
        p.cardId != null && Number.isFinite(Number(p.cardId)) ? Number(p.cardId) : null,
        p.tweetId ? String(p.tweetId).slice(0, 32) : null,
        p.authorKey ? String(p.authorKey).slice(0, 64) : null,
        p.authorHandle ? String(p.authorHandle).slice(0, 64) : null,
        p.authorName ? String(p.authorName).slice(0, 128) : null,
        p.authorAvatar ? String(p.authorAvatar).slice(0, 512) : null,
        String(p.content ?? ""),
        p.rawContent != null ? String(p.rawContent) : null,
        jsonCol(p.parsedJson ?? null),
        jsonCol(p.metaJson ?? null),
        now
      );
    return communityGetFeedMessage(Number(r.lastInsertRowid));
  }

  async function communityGetFeedMessage(id) {
    return db.prepare(`SELECT * FROM community_feed_messages WHERE id = ? LIMIT 1`).get(id) ?? null;
  }

  async function listCommunityFeedMessages(opts = {}) {
    const lim = Math.min(100, Math.max(1, Number(opts.limit) || 40));
    const feedType = String(opts.feedType ?? "").trim();
    const beforeId = Number(opts.beforeId);
    if (feedType && Number.isFinite(beforeId) && beforeId > 0) {
      return db
        .prepare(
          `SELECT * FROM community_feed_messages WHERE feed_type = ? AND id < ? ORDER BY id DESC LIMIT ?`
        )
        .all(feedType, beforeId, lim);
    }
    if (feedType) {
      return db
        .prepare(`SELECT * FROM community_feed_messages WHERE feed_type = ? ORDER BY id DESC LIMIT ?`)
        .all(feedType, lim);
    }
    if (Number.isFinite(beforeId) && beforeId > 0) {
      return db
        .prepare(`SELECT * FROM community_feed_messages WHERE id < ? ORDER BY id DESC LIMIT ?`)
        .all(beforeId, lim);
    }
    return db.prepare(`SELECT * FROM community_feed_messages ORDER BY id DESC LIMIT ?`).all(lim);
  }

  async function findCommunityFeedByCardId(cardId) {
    const id = Number(cardId);
    if (!Number.isFinite(id) || id <= 0) return null;
    return (
      db
        .prepare(
          `SELECT * FROM community_feed_messages WHERE feed_type = 'card' AND card_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(id) ?? null
    );
  }

  async function findCommunityFeedByTweetId(tweetId) {
    const tid = String(tweetId ?? "").trim();
    if (!tid) return null;
    return (
      db
        .prepare(
          `SELECT * FROM community_feed_messages WHERE feed_type = 'twitter' AND tweet_id = ? LIMIT 1`
        )
        .get(tid) ?? null
    );
  }

  async function updateCommunityFeedParsed(id, parsedJson, content = null) {
    if (content != null) {
      db.prepare(`UPDATE community_feed_messages SET parsed_json = ?, content = ? WHERE id = ?`).run(
        jsonCol(parsedJson),
        String(content),
        id
      );
    } else {
      db.prepare(`UPDATE community_feed_messages SET parsed_json = ? WHERE id = ?`).run(jsonCol(parsedJson), id);
    }
    return communityGetFeedMessage(id);
  }

  async function updateCommunityFeedMessage(id, p) {
    const fid = Number(id);
    if (!Number.isFinite(fid) || fid <= 0) return null;
    const sets = [];
    const params = [];
    if (p.content != null) {
      sets.push("content = ?");
      params.push(String(p.content));
    }
    if (p.rawContent !== undefined) {
      sets.push("raw_content = ?");
      params.push(p.rawContent != null ? String(p.rawContent) : null);
    }
    if (p.channelId !== undefined) {
      sets.push("channel_id = ?");
      params.push(p.channelId ? String(p.channelId).slice(0, 64) : null);
    }
    if (p.channelName !== undefined) {
      sets.push("channel_name = ?");
      params.push(p.channelName ? String(p.channelName).slice(0, 128) : null);
    }
    if (p.metaJson !== undefined) {
      sets.push("meta_json = ?");
      params.push(jsonCol(p.metaJson));
    }
    if (!sets.length) return communityGetFeedMessage(fid);
    params.push(fid);
    db.prepare(`UPDATE community_feed_messages SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return communityGetFeedMessage(fid);
  }

  async function upsertCommunityTwitterAuthor(p) {
    const key = String(p.authorKey ?? "").trim();
    if (!key) return null;
    const now = isoToDatetime3(new Date().toISOString());
    const handle = String(p.handle ?? "").replace(/^@/, "").trim().slice(0, 64);
    const displayName = String(p.displayName ?? "").trim().slice(0, 128);
    const avatarUrl = String(p.avatarUrl ?? "").trim().slice(0, 512);
    const note = String(p.note ?? "").trim().slice(0, 255);
    db.prepare(
      `INSERT INTO community_twitter_authors (author_key, handle, display_name, avatar_url, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(author_key) DO UPDATE SET
         handle = CASE WHEN excluded.handle != '' THEN excluded.handle ELSE community_twitter_authors.handle END,
         display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE community_twitter_authors.display_name END,
         avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE community_twitter_authors.avatar_url END,
         note = CASE WHEN excluded.note != '' THEN excluded.note ELSE community_twitter_authors.note END,
         updated_at = excluded.updated_at`
    ).run(key, handle, displayName, avatarUrl, note, now, now);
    return getCommunityTwitterAuthor(key);
  }

  async function listCommunityTwitterAuthors() {
    return db.prepare(`SELECT * FROM community_twitter_authors ORDER BY updated_at DESC`).all();
  }

  async function getCommunityTwitterAuthor(key) {
    return db.prepare(`SELECT * FROM community_twitter_authors WHERE author_key = ? LIMIT 1`).get(key) ?? null;
  }

  async function deleteCommunityFeedByCardId(cardId) {
    const id = Number(cardId);
    if (!Number.isFinite(id) || id <= 0) return 0;
    const r = db
      .prepare(`DELETE FROM community_feed_messages WHERE feed_type = 'card' AND card_id = ?`)
      .run(id);
    return Number(r.changes) || 0;
  }

  async function closeCommunitySqlite() {
    db.close();
  }

  return {
    communityEnsureSchema,
    communityGetMemberByToken,
    communityGetMemberByHandle,
    communityGetMemberByEmail,
    communityGetMemberByGoogleSub,
    communityGetMemberById,
    communityInsertMember,
    communityUpdateMember,
    communityAddPoints,
    communityListMembersByPoints,
    communityInsertCheckin,
    communityListCheckins,
    communityInsertPost,
    communityGetPost,
    communityListPosts,
    communityInsertComment,
    communityListComments,
    communityHasLiked,
    communityAddLike,
    communityRemoveLike,
    communityTransferTip,
    communityListTips,
    communityLatestTip,
    communityInsertChatMessage,
    communityListChatMessages,
    communityGetChatMessage,
    insertCommunityFeedMessage,
    communityGetFeedMessage,
    listCommunityFeedMessages,
    findCommunityFeedByCardId,
    findCommunityFeedByTweetId,
    updateCommunityFeedParsed,
    updateCommunityFeedMessage,
    upsertCommunityTwitterAuthor,
    listCommunityTwitterAuthors,
    getCommunityTwitterAuthor,
    deleteCommunityFeedByCardId,
    closeCommunitySqlite,
  };
}

/** @type {readonly string[]} */
export const COMMUNITY_SQLITE_METHODS = [
  "communityEnsureSchema",
  "communityGetMemberByToken",
  "communityGetMemberByHandle",
  "communityGetMemberByEmail",
  "communityGetMemberByGoogleSub",
  "communityGetMemberById",
  "communityInsertMember",
  "communityUpdateMember",
  "communityAddPoints",
  "communityListMembersByPoints",
  "communityInsertCheckin",
  "communityListCheckins",
  "communityInsertPost",
  "communityGetPost",
  "communityListPosts",
  "communityInsertComment",
  "communityListComments",
  "communityHasLiked",
  "communityAddLike",
  "communityRemoveLike",
  "communityTransferTip",
  "communityListTips",
  "communityLatestTip",
  "communityInsertChatMessage",
  "communityListChatMessages",
  "communityGetChatMessage",
  "insertCommunityFeedMessage",
  "communityGetFeedMessage",
  "listCommunityFeedMessages",
  "findCommunityFeedByCardId",
  "findCommunityFeedByTweetId",
  "updateCommunityFeedParsed",
  "updateCommunityFeedMessage",
  "upsertCommunityTwitterAuthor",
  "listCommunityTwitterAuthors",
  "getCommunityTwitterAuthor",
  "deleteCommunityFeedByCardId",
];

/**
 * @param {Record<string, unknown>} store
 * @param {ReturnType<typeof openCommunitySqliteStore>} communityStore
 */
export function bindCommunitySqliteToStore(store, communityStore) {
  for (const key of COMMUNITY_SQLITE_METHODS) {
    store[key] = communityStore[key];
  }
  store.communityDbActive = true;
  store.closeCommunitySqlite = communityStore.closeCommunitySqlite;
}
