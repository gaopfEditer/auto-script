/**
 * 社区业务：会员 / 动态广场 / 签到 / 打赏 / 聊天室。
 */
import { randomBytes } from "node:crypto";
import {
  COMMENT_POINTS,
  LIKE_POINTS,
  POST_POINTS,
  WELCOME_TIP_BALANCE,
  checkinPointsForStreak,
  levelSystemMeta,
  pointsRequiredForLevel,
  titleForPoints,
  titleProgress,
  titlesWithBadges,
} from "./community-titles.js";
import { allowedAvatarUrls, COMMUNITY_AVATAR_PACKS } from "./community-avatar-packs.js";
import {
  handleFromEmail,
  hashPassword,
  isGoogleMail,
  isValidEmail,
  normalizeEmail,
  verifyGoogleIdToken,
  verifyPassword,
} from "./community-auth.js";
import { config } from "./config.js";
import { extractFirstHttpUrl, fetchLinkPreview } from "./community-link-preview.js";

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
 * @param {{ self?: boolean }} [opts]
 */
function memberPublic(row, opts = {}) {
  if (!row) return null;
  const points = Number(row.points) || 0;
  const title = titleForPoints(points);
  const progress = titleProgress(points);
  /** @type {Record<string, unknown>} */
  const out = {
    id: Number(row.id),
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || "",
    bio: row.bio || "",
    points,
    tipBalance: Number(row.tip_balance) || 0,
    checkinStreak: Number(row.checkin_streak) || 0,
    lastCheckinDay: row.last_checkin_day || null,
    level: progress.level,
    badges: progress.badges,
    pointsToNextLevel: progress.pointsToNextLevel,
    levelProgressPct: progress.levelProgressPct,
    nextLevel: progress.nextLevel,
    title: {
      key: title.key,
      label: title.label,
      color: title.color,
      desc: title.desc,
      minLevel: title.minLevel,
    },
    titleProgress: {
      pct: progress.progressPct,
      nextLabel: progress.next?.label ?? null,
      nextMinPoints: progress.next ? pointsRequiredForLevel(progress.next.minLevel) : null,
      nextMinLevel: progress.next?.minLevel ?? null,
    },
    createdAt: row.created_at,
  };
  if (opts.self) {
    out.email = row.email || "";
    out.authProvider = row.auth_provider || "local";
    out.hasPassword = Boolean(row.password_hash);
  }
  return out;
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
   * @param {string} preferred
   */
  async function allocHandle(preferred) {
    let base = String(preferred || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 20);
    if (!base) base = `u${Date.now().toString(36)}`;
    for (let i = 0; i < 20; i += 1) {
      const candidate = (i === 0 ? base : `${base}${i}`).slice(0, 24);
      const existing = await store.communityGetMemberByHandle(candidate);
      if (!existing) return candidate;
    }
    return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 24);
  }

  function authConfig() {
    return {
      googleClientId: config.communityGoogleClientId || "",
      googleEnabled: Boolean(config.communityGoogleClientId),
      emailAuth: true,
      requireGoogleMail: config.communityEmailRequireGoogleMail,
    };
  }

  /**
   * 邮箱 + 密码注册（信息入库）。
   * @param {{ email: string, password: string, displayName?: string, handle?: string }} body
   */
  async function registerWithEmail(body) {
    await ensureReady();
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) {
      const err = new Error("请输入有效邮箱");
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (config.communityEmailRequireGoogleMail && !isGoogleMail(email)) {
      const err = new Error("仅支持 Google 邮箱（@gmail.com）注册，或使用「Google 登录」");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const password = String(body.password ?? "");
    if (password.length < 8 || password.length > 128) {
      const err = new Error("密码长度须为 8～128 位");
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (await store.communityGetMemberByEmail(email)) {
      const err = new Error("该邮箱已注册，请直接登录");
      err.code = "CONFLICT";
      throw err;
    }
    const displayName =
      String(body.displayName ?? "").trim().slice(0, 32) ||
      email.split("@")[0].slice(0, 32) ||
      "会员";
    const handle = await allocHandle(body.handle || handleFromEmail(email));
    const token = newToken();
    const passwordHash = await hashPassword(password);
    const row = await store.communityInsertMember({
      token,
      handle,
      displayName,
      avatarUrl: "",
      bio: "",
      email,
      passwordHash,
      authProvider: "local",
      points: 0,
      tipBalance: WELCOME_TIP_BALANCE,
    });
    log.info(`社区邮箱注册 #${row.id} @${handle} ${email}`);
    return {
      member: memberPublic(row, { self: true }),
      token,
      welcomeTipBalance: WELCOME_TIP_BALANCE,
      created: true,
    };
  }

  /**
   * 邮箱 + 密码登录。
   * @param {{ email: string, password: string }} body
   */
  async function loginWithEmail(body) {
    await ensureReady();
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");
    if (!isValidEmail(email) || !password) {
      const err = new Error("请输入邮箱和密码");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const row = await store.communityGetMemberByEmail(email);
    if (!row || !row.password_hash) {
      const err = new Error("邮箱或密码错误");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    const ok = await verifyPassword(password, String(row.password_hash));
    if (!ok) {
      const err = new Error("邮箱或密码错误");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    const token = newToken();
    const next = await store.communityUpdateMember(row.id, { token });
    log.info(`社区邮箱登录 #${row.id} @${row.handle}`);
    return { member: memberPublic(next, { self: true }), token, created: false };
  }

  /**
   * Google ID Token 登录 / 自动注册。
   * @param {{ idToken: string }} body
   */
  async function loginWithGoogle(body) {
    await ensureReady();
    const profile = await verifyGoogleIdToken(body.idToken);
    let row =
      (await store.communityGetMemberByGoogleSub(profile.sub)) ||
      (await store.communityGetMemberByEmail(profile.email));

    const token = newToken();
    if (row) {
      /** @type {Record<string, unknown>} */
      const patch = { token, googleSub: profile.sub };
      if (!row.email) patch.email = profile.email;
      if (profile.picture && !row.avatar_url) patch.avatarUrl = profile.picture;
      if (row.auth_provider === "local") patch.authProvider = "both";
      else if (!row.auth_provider || row.auth_provider === "google") patch.authProvider = "google";
      const next = await store.communityUpdateMember(row.id, patch);
      log.info(`社区 Google 登录 #${row.id} @${row.handle}`);
      return { member: memberPublic(next, { self: true }), token, created: false };
    }

    const displayName = profile.name || profile.email.split("@")[0] || "Google用户";
    const handle = await allocHandle(handleFromEmail(profile.email));
    row = await store.communityInsertMember({
      token,
      handle,
      displayName: displayName.slice(0, 32),
      avatarUrl: profile.picture || "",
      bio: "",
      email: profile.email,
      googleSub: profile.sub,
      authProvider: "google",
      points: 0,
      tipBalance: WELCOME_TIP_BALANCE,
    });
    log.info(`社区 Google 注册 #${row.id} @${handle} ${profile.email}`);
    return {
      member: memberPublic(row, { self: true }),
      token,
      welcomeTipBalance: WELCOME_TIP_BALANCE,
      created: true,
    };
  }

  /**
   * 兼容旧接口：无邮箱时仍可快速加入；有 email+password 则走正式注册。
   * @param {{ displayName?: string, handle?: string, avatarUrl?: string, bio?: string, email?: string, password?: string }} body
   */
  async function register(body) {
    if (body.email && body.password) {
      return registerWithEmail(body);
    }
    await ensureReady();
    const displayName = String(body.displayName ?? "").trim().slice(0, 32);
    if (!displayName) {
      const err = new Error("请填写昵称，或使用邮箱 / Google 注册");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const handle = await allocHandle(body.handle);
    const token = newToken();
    const row = await store.communityInsertMember({
      token,
      handle,
      displayName,
      avatarUrl: String(body.avatarUrl ?? "").trim().slice(0, 512),
      bio: String(body.bio ?? "").trim().slice(0, 200),
      authProvider: "guest",
      points: 0,
      tipBalance: WELCOME_TIP_BALANCE,
    });
    log.info(`社区游客加入 #${row.id} @${handle}`);
    return { member: memberPublic(row, { self: true }), token, welcomeTipBalance: WELCOME_TIP_BALANCE };
  }

  async function me(token) {
    const row = await requireMember(token);
    return { member: memberPublic(row, { self: true }) };
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
    return { member: memberPublic(next, { self: true }) };
  }

  async function listTitles() {
    return { titles: titlesWithBadges(), levelSystem: levelSystemMeta() };
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
      titles: titlesWithBadges(),
      levelSystem: levelSystemMeta(),
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
    let meta = row.meta_json ?? row.metaJson ?? null;
    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta);
      } catch {
        meta = null;
      }
    }
    const linkPreview =
      meta && typeof meta === "object" && meta.linkPreview && typeof meta.linkPreview === "object"
        ? {
            url: String(meta.linkPreview.url ?? ""),
            title: String(meta.linkPreview.title ?? ""),
            description: String(meta.linkPreview.description ?? ""),
            image: String(meta.linkPreview.image ?? ""),
            imageAlt: String(meta.linkPreview.imageAlt ?? ""),
            siteName: String(meta.linkPreview.siteName ?? ""),
            card: String(meta.linkPreview.card ?? ""),
            twitterSite: String(meta.linkPreview.twitterSite ?? ""),
            twitterCreator: String(meta.linkPreview.twitterCreator ?? ""),
            source: String(meta.linkPreview.source ?? ""),
          }
        : null;
    return {
      id: Number(row.id),
      type: String(row.msg_type || "text"),
      content: String(row.content ?? ""),
      mediaUrl: String(row.media_url ?? ""),
      linkPreview,
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

    /** @type {Record<string, unknown> | null} */
    let metaJson = null;
    if (type === "text") {
      const url = extractFirstHttpUrl(content);
      if (url) {
        try {
          const preview = await fetchLinkPreview(url);
          if (preview) metaJson = { linkPreview: preview };
        } catch {
          /* 预览失败仍发文字 */
        }
      }
    }

    const inserted = await store.communityInsertChatMessage({
      memberId: Number(row.id),
      msgType: type,
      content,
      mediaUrl: type === "text" ? "" : mediaUrl,
      metaJson,
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
    return { member: memberPublic(next, { self: true }) };
  }

  return {
    register,
    registerWithEmail,
    loginWithEmail,
    loginWithGoogle,
    authConfig,
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
