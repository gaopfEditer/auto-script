/**
 * 社区业务：会员 / 动态广场 / 签到 / 打赏 / 聊天室。
 */
import { randomBytes } from "node:crypto";
import {
  COMMENT_POINTS,
  COMMUNITY_TITLES,
  LIKE_POINTS,
  POST_POINTS,
  WELCOME_TIP_BALANCE,
  checkinPointsForStreak,
  titleForPoints,
  titleProgress,
} from "./community-titles.js";
import { allowedAvatarUrls, COMMUNITY_AVATAR_PACKS } from "./community-avatar-packs.js";

/** @param {Date | string} d */
function toDayKey(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {string} dayKey YYYY-MM-DD */
function yesterdayKey(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return toDayKey(dt);
}

function newToken() {
  return randomBytes(24).toString("hex");
}

/**
 * @param {Record<string, unknown>} row
 */
function memberPublic(row) {
  if (!row) return null;
  const points = Number(row.points) || 0;
  const title = titleForPoints(points);
  const progress = titleProgress(points);
  return {
    id: Number(row.id),
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || "",
    bio: row.bio || "",
    points,
    tipBalance: Number(row.tip_balance) || 0,
    checkinStreak: Number(row.checkin_streak) || 0,
    lastCheckinDay: row.last_checkin_day || null,
    title: {
      key: title.key,
      label: title.label,
      color: title.color,
      desc: title.desc,
    },
    titleProgress: {
      pct: progress.progressPct,
      nextLabel: progress.next?.label ?? null,
      nextMinPoints: progress.next?.minPoints ?? null,
    },
    createdAt: row.created_at,
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createCommunityService(store, log, broadcast) {
  function assertDb() {
    if (store?.offline || !store?.communityEnsureSchema) {
      const err = new Error("community_db_offline");
      err.code = "COMMUNITY_OFFLINE";
      throw err;
    }
  }

  async function ensureReady() {
    assertDb();
    await store.communityEnsureSchema();
  }

  /**
   * @param {string | undefined} token
   */
  async function requireMember(token) {
    assertDb();
    const t = String(token ?? "").trim();
    if (!t) {
      const err = new Error("需要登录社区（缺少 X-Community-Token）");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    const row = await store.communityGetMemberByToken(t);
    if (!row) {
      const err = new Error("社区身份无效，请重新加入");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    return row;
  }

  /**
   * @param {{ displayName: string, handle?: string, avatarUrl?: string, bio?: string }} body
   */
  async function register(body) {
    await ensureReady();
    const displayName = String(body.displayName ?? "").trim().slice(0, 32);
    if (!displayName) {
      const err = new Error("请填写昵称");
      err.code = "BAD_REQUEST";
      throw err;
    }
    let handle = String(body.handle ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 24);
    if (!handle) {
      handle = `u${Date.now().toString(36)}`;
    }
    const existing = await store.communityGetMemberByHandle(handle);
    if (existing) {
      const err = new Error("该 handle 已被占用");
      err.code = "CONFLICT";
      throw err;
    }
    const token = newToken();
    const row = await store.communityInsertMember({
      token,
      handle,
      displayName,
      avatarUrl: String(body.avatarUrl ?? "").trim().slice(0, 512),
      bio: String(body.bio ?? "").trim().slice(0, 200),
      points: 0,
      tipBalance: WELCOME_TIP_BALANCE,
    });
    log.info(`社区新成员 #${row.id} @${handle}`);
    return { member: memberPublic(row), token, welcomeTipBalance: WELCOME_TIP_BALANCE };
  }

  async function me(token) {
    const row = await requireMember(token);
    return { member: memberPublic(row) };
  }

  /**
   * @param {string} token
   * @param {{ displayName?: string, avatarUrl?: string, bio?: string }} patch
   */
  async function updateProfile(token, patch) {
    const row = await requireMember(token);
    const next = await store.communityUpdateMember(row.id, {
      displayName: patch.displayName != null ? String(patch.displayName).trim().slice(0, 32) : undefined,
      avatarUrl: patch.avatarUrl != null ? String(patch.avatarUrl).trim().slice(0, 512) : undefined,
      bio: patch.bio != null ? String(patch.bio).trim().slice(0, 200) : undefined,
    });
    return { member: memberPublic(next) };
  }

  async function listTitles() {
    return { titles: COMMUNITY_TITLES };
  }

  async function leaderboard(limit = 20) {
    await ensureReady();
    const rows = await store.communityListMembersByPoints(Math.min(50, Math.max(1, limit)));
    return { members: rows.map(memberPublic) };
  }

  /**
   * @param {string} token
   */
  async function checkin(token) {
    const row = await requireMember(token);
    const today = toDayKey();
    if (row.last_checkin_day === today) {
      return {
        ok: true,
        already: true,
        member: memberPublic(row),
        message: "今日已签到",
        pointsEarned: 0,
      };
    }
    const yday = yesterdayKey(today);
    const prevStreak = Number(row.checkin_streak) || 0;
    const streak = row.last_checkin_day === yday ? prevStreak + 1 : 1;
    const earned = checkinPointsForStreak(streak - 1);
    await store.communityInsertCheckin({
      memberId: row.id,
      day: today,
      pointsEarned: earned,
      streak,
    });
    const updated = await store.communityAddPoints(row.id, earned, {
      checkinStreak: streak,
      lastCheckinDay: today,
    });
    log.info(`社区签到 #${row.id} +${earned} streak=${streak}`);
    return {
      ok: true,
      already: false,
      pointsEarned: earned,
      streak,
      member: memberPublic(updated),
      message: `签到成功 +${earned} 积分（连续 ${streak} 天）`,
    };
  }

  async function checkinHistory(token, limit = 30) {
    const row = await requireMember(token);
    const rows = await store.communityListCheckins(row.id, limit);
    return {
      rows: rows.map((r) => ({
        day: r.day,
        pointsEarned: Number(r.points_earned) || 0,
        streak: Number(r.streak) || 0,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * @param {string} token
   * @param {{ content: string }} body
   */
  async function createPost(token, body) {
    const row = await requireMember(token);
    const content = String(body.content ?? "").trim().slice(0, 2000);
    if (!content) {
      const err = new Error("动态内容不能为空");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const post = await store.communityInsertPost({
      memberId: row.id,
      content,
    });
    await store.communityAddPoints(row.id, POST_POINTS);
    const full = await store.communityGetPost(post.id);
    return { post: await enrichPost(full, row.id) };
  }

  /**
   * @param {Record<string, unknown>} post
   * @param {number | null} viewerId
   */
  async function enrichPost(post, viewerId) {
    if (!post) return null;
    const author = await store.communityGetMemberById(Number(post.member_id));
    const liked =
      viewerId != null ? await store.communityHasLiked(Number(post.id), viewerId) : false;
    const comments = await store.communityListComments(Number(post.id), 50);
    const commentOut = [];
    for (const c of comments) {
      const cm = await store.communityGetMemberById(Number(c.member_id));
      commentOut.push({
        id: Number(c.id),
        content: c.content,
        createdAt: c.created_at,
        author: memberPublic(cm),
      });
    }
    return {
      id: Number(post.id),
      content: post.content,
      likeCount: Number(post.like_count) || 0,
      commentCount: Number(post.comment_count) || 0,
      createdAt: post.created_at,
      liked,
      author: memberPublic(author),
      comments: commentOut,
    };
  }

  /**
   * @param {string | undefined} token
   * @param {{ limit?: number, beforeId?: number }} opts
   */
  async function listPosts(token, opts = {}) {
    await ensureReady();
    let viewerId = null;
    if (token) {
      try {
        const m = await requireMember(token);
        viewerId = Number(m.id);
      } catch {
        viewerId = null;
      }
    }
    const rows = await store.communityListPosts({
      limit: opts.limit ?? 30,
      beforeId: opts.beforeId,
    });
    const posts = [];
    for (const p of rows) {
      posts.push(await enrichPost(p, viewerId));
    }
    return { posts };
  }

  /**
   * @param {string} token
   * @param {number} postId
   * @param {{ content: string }} body
   */
  async function addComment(token, postId, body) {
    const row = await requireMember(token);
    const content = String(body.content ?? "").trim().slice(0, 1000);
    if (!content) {
      const err = new Error("评论不能为空");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const post = await store.communityGetPost(postId);
    if (!post) {
      const err = new Error("动态不存在");
      err.code = "NOT_FOUND";
      throw err;
    }
    await store.communityInsertComment({
      postId,
      memberId: row.id,
      content,
    });
    await store.communityAddPoints(row.id, COMMENT_POINTS);
    const full = await store.communityGetPost(postId);
    return { post: await enrichPost(full, row.id) };
  }

  /**
   * @param {string} token
   * @param {number} postId
   */
  async function toggleLike(token, postId) {
    const row = await requireMember(token);
    const post = await store.communityGetPost(postId);
    if (!post) {
      const err = new Error("动态不存在");
      err.code = "NOT_FOUND";
      throw err;
    }
    const liked = await store.communityHasLiked(postId, row.id);
    if (liked) {
      await store.communityRemoveLike(postId, row.id);
    } else {
      await store.communityAddLike(postId, row.id);
      // 给作者一点互动分（自己赞自己不加）
      if (Number(post.member_id) !== Number(row.id)) {
        await store.communityAddPoints(Number(post.member_id), LIKE_POINTS);
      }
    }
    const full = await store.communityGetPost(postId);
    return { post: await enrichPost(full, row.id), liked: !liked };
  }

  /**
   * @param {string} token
   * @param {{ toHandle?: string, toMemberId?: number, amount: number, message?: string }} body
   */
  async function tip(token, body) {
    const from = await requireMember(token);
    const amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
      const err = new Error("打赏数量需为 1–10000 的整数");
      err.code = "BAD_REQUEST";
      throw err;
    }
    let to = null;
    if (body.toMemberId) {
      to = await store.communityGetMemberById(Number(body.toMemberId));
    } else if (body.toHandle) {
      to = await store.communityGetMemberByHandle(String(body.toHandle).trim().toLowerCase());
    }
    if (!to) {
      const err = new Error("打赏对象不存在");
      err.code = "NOT_FOUND";
      throw err;
    }
    if (Number(to.id) === Number(from.id)) {
      const err = new Error("不能打赏自己");
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (Number(from.tip_balance) < amount) {
      const err = new Error("打赏币不足");
      err.code = "INSUFFICIENT";
      throw err;
    }
    const message = String(body.message ?? "").trim().slice(0, 200);
    await store.communityTransferTip({
      fromId: from.id,
      toId: to.id,
      amount,
      message,
      zone: "plaza",
    });
    // 打赏双方小幅加积分
    await store.communityAddPoints(from.id, Math.min(5, amount));
    await store.communityAddPoints(to.id, Math.min(10, amount * 2));
    const tipRow = await store.communityLatestTip(from.id, to.id);
    log.info(`社区打赏 ${from.handle} → ${to.handle} x${amount}`);
    return {
      tip: {
        id: tipRow?.id ?? null,
        amount,
        message,
        from: memberPublic(await store.communityGetMemberById(from.id)),
        to: memberPublic(await store.communityGetMemberById(to.id)),
        createdAt: tipRow?.created_at ?? new Date().toISOString(),
      },
      member: memberPublic(await store.communityGetMemberById(from.id)),
    };
  }

  /**
   * @param {{ limit?: number }} opts
   */
  async function listTips(opts = {}) {
    await ensureReady();
    const rows = await store.communityListTips(opts.limit ?? 40);
    const out = [];
    for (const r of rows) {
      out.push({
        id: Number(r.id),
        amount: Number(r.amount) || 0,
        message: r.message || "",
        zone: r.zone || "plaza",
        createdAt: r.created_at,
        from: memberPublic(await store.communityGetMemberById(Number(r.from_member_id))),
        to: memberPublic(await store.communityGetMemberById(Number(r.to_member_id))),
      });
    }
    return { tips: out };
  }

  async function overview(token) {
    await ensureReady();
    const [lb, tips, posts] = await Promise.all([
      leaderboard(8),
      listTips({ limit: 8 }),
      listPosts(token, { limit: 8 }),
    ]);
    let meRes = null;
    if (token) {
      try {
        meRes = await me(token);
      } catch {
        meRes = null;
      }
    }
    return {
      titles: COMMUNITY_TITLES,
      leaderboard: lb.members,
      recentTips: tips.tips,
      recentPosts: posts.posts,
      me: meRes?.member ?? null,
      welcomeTipBalance: WELCOME_TIP_BALANCE,
    };
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {Record<string, unknown> | null} [memberRow]
   */
  function chatMessagePublic(row, memberRow) {
    return {
      id: Number(row.id),
      type: String(row.msg_type || "text"),
      content: String(row.content ?? ""),
      mediaUrl: String(row.media_url ?? ""),
      createdAt: row.created_at,
      author: memberPublic(memberRow || null),
    };
  }

  /**
   * @param {{ limit?: number, beforeId?: number }} [opts]
   */
  async function listChatMessages(opts = {}) {
    await ensureReady();
    const rows = await store.communityListChatMessages(opts);
    /** @type {Map<number, Record<string, unknown>>} */
    const memberCache = new Map();
    const messages = [];
    for (const r of rows) {
      const mid = Number(r.member_id);
      if (!memberCache.has(mid)) {
        memberCache.set(mid, (await store.communityGetMemberById(mid)) || null);
      }
      messages.push(chatMessagePublic(r, memberCache.get(mid)));
    }
    // API 返回时间正序（旧→新），便于前端直接 append
    messages.reverse();
    return { messages };
  }

  /**
   * @param {string} token
   * @param {{ type?: string, content?: string, mediaUrl?: string }} body
   */
  async function sendChatMessage(token, body) {
    const row = await requireMember(token);
    const type = String(body.type ?? "text").trim().toLowerCase();
    if (!["text", "image", "video"].includes(type)) {
      const err = new Error("消息类型须为 text / image / video");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const content = String(body.content ?? "").trim().slice(0, 2000);
    const mediaUrl = String(body.mediaUrl ?? "").trim().slice(0, 512);
    if (type === "text") {
      if (!content) {
        const err = new Error("请输入文字");
        err.code = "BAD_REQUEST";
        throw err;
      }
    } else if (!mediaUrl) {
      const err = new Error("图片/视频消息需要 mediaUrl");
      err.code = "BAD_REQUEST";
      throw err;
    } else if (!mediaUrl.startsWith("/api/community/chat/media/file/")) {
      const err = new Error("非法媒体地址");
      err.code = "BAD_REQUEST";
      throw err;
    }

    const inserted = await store.communityInsertChatMessage({
      memberId: Number(row.id),
      msgType: type,
      content,
      mediaUrl: type === "text" ? "" : mediaUrl,
    });
    const message = chatMessagePublic(inserted, row);
    try {
      broadcast?.("community", { kind: "chat_message", message });
    } catch (e) {
      log.warn(`chat broadcast: ${/** @type {Error} */ (e).message}`);
    }
    return { message };
  }

  async function listAvatarPacks() {
    return { packs: COMMUNITY_AVATAR_PACKS };
  }

  /**
   * @param {string} token
   * @param {{ avatarUrl?: string }} body
   */
  async function setAvatar(token, body) {
    const row = await requireMember(token);
    const avatarUrl = String(body.avatarUrl ?? "").trim();
    if (!avatarUrl || !allowedAvatarUrls().has(avatarUrl)) {
      const err = new Error("请选择头像包中的头像");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const next = await store.communityUpdateMember(row.id, { avatarUrl });
    return { member: memberPublic(next) };
  }

  return {
    register,
    me,
    updateProfile,
    listTitles,
    leaderboard,
    checkin,
    checkinHistory,
    createPost,
    listPosts,
    addComment,
    toggleLike,
    tip,
    listTips,
    overview,
    listChatMessages,
    sendChatMessage,
    listAvatarPacks,
    setAvatar,
  };
}
