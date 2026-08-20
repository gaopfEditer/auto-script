<script setup>
import { computed, onMounted, ref, watch } from "vue";
import {
  addComment,
  createPost,
  fetchCheckinHistory,
  fetchCommunityOverview,
  fetchPosts,
  fetchTips,
  getCommunityToken,
  sendTip,
  SHOW_COMMUNITY_TIPS,
  toggleLike,
} from "../lib/communityApi.js";
import CommunityChatPanel from "../components/CommunityChatPanel.vue";
import CommunityFeedPanel from "../components/CommunityFeedPanel.vue";
import CommunityProfileRail from "../components/CommunityProfileRail.vue";
import CommunityHoverCard from "../components/CommunityHoverCard.vue";
import CommunityLevelBadges from "../components/CommunityLevelBadges.vue";
import { badgesCountLabel, levelBadgesFromLevel } from "../lib/communityLevel.js";

const view = ref("chat"); // chat | feed | twitter | plaza | tip | titles
const loading = ref(true);
const error = ref("");
const me = ref(null);
const titles = ref([]);
const levelSystem = ref(null);
const leaderboard = ref([]);
const posts = ref([]);
const tips = ref([]);
const checkinHistory = ref([]);
const welcomeTip = ref(100);

/**
 * 头衔档位兜底（与 community-titles.js 对齐）。
 * 旧后端若未返回 minLevel，禁止再掉成「全是一星」。
 */
const TITLE_TIER_FALLBACK = [
  { key: "sprout", label: "新芽", minLevel: 1, minPoints: 0, color: "#95a5a6", desc: "刚加入，从签到与闲聊开始" },
  { key: "pathfinder", label: "探路者", minLevel: 4, minPoints: 54, color: "#3498db", desc: "开始稳定活跃" },
  { key: "hunter", label: "信号猎手", minLevel: 9, minPoints: 264, color: "#9b59b6", desc: "常驻聊天与动态" },
  { key: "gold", label: "金标会员", minLevel: 16, minPoints: 810, color: "#f1c40f", desc: "社区中坚" },
  { key: "elder", label: "社区元老", minLevel: 32, minPoints: 3162, color: "#e67e22", desc: "长期签到与互助" },
  { key: "legend", label: "殿堂传说", minLevel: 64, minPoints: 12474, color: "#e74c3c", desc: "顶尖贡献者" },
];

/** 头衔行：起步图标严格按 minLevel 换算（Lv.4→🌙，Lv.9→🌙🌙⭐ …） */
const titleRows = computed(() => {
  const fromSys = Array.isArray(levelSystem.value?.titles) ? levelSystem.value.titles : [];
  const byKey = new Map(
    [...TITLE_TIER_FALLBACK, ...titles.value, ...fromSys].map((t) => [t.key, t])
  );
  const order = fromSys.length
    ? fromSys.map((t) => t.key)
    : titles.value.length
      ? titles.value.map((t) => t.key)
      : TITLE_TIER_FALLBACK.map((t) => t.key);

  return order.map((key) => {
    const fb = TITLE_TIER_FALLBACK.find((x) => x.key === key) || TITLE_TIER_FALLBACK[0];
    const t = byKey.get(key) || fb;
    const minLevel = Number(t.minLevel) || Number(fb.minLevel) || 1;
    // 一律按等级重算，不信任残缺 badges（否则会掉成一星）
    const badges = levelBadgesFromLevel(minLevel);
    return {
      key,
      label: t.label || fb.label,
      color: t.color || fb.color,
      desc: t.desc || fb.desc,
      minLevel,
      badges,
      badgeLabel: badgesCountLabel(badges),
      minPoints: Number(t.minPoints ?? t.approxPoints ?? fb.minPoints) || 0,
    };
  });
});

const postText = ref("");
const postBusy = ref(false);
const commentDrafts = ref({});
const expandedComments = ref({});

const tipHandle = ref("");
const tipAmount = ref(10);
const tipMessage = ref("");
const tipBusy = ref(false);
const tipMsg = ref("");

const hasToken = computed(() => Boolean(getCommunityToken()));

function formatTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function initialOf(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    const ov = await fetchCommunityOverview();
    me.value = ov.me ?? null;
    titles.value = ov.titles ?? [];
    levelSystem.value = ov.levelSystem ?? null;
    leaderboard.value = ov.leaderboard ?? [];
    posts.value = ov.recentPosts ?? [];
    tips.value = ov.recentTips ?? [];
    welcomeTip.value = ov.welcomeTipBalance ?? 100;
    if (hasToken.value) {
      try {
        const hist = await fetchCheckinHistory(14);
        checkinHistory.value = hist.rows ?? [];
      } catch {
        checkinHistory.value = [];
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function refreshPosts() {
  const data = await fetchPosts(40);
  posts.value = data.posts ?? [];
}

function onLogout() {
  me.value = null;
  checkinHistory.value = [];
}

async function onPost() {
  if (!postText.value.trim()) return;
  postBusy.value = true;
  try {
    await createPost(postText.value.trim());
    postText.value = "";
    await refreshPosts();
    const ov = await fetchCommunityOverview();
    me.value = ov.me ?? me.value;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    postBusy.value = false;
  }
}

async function onLike(post) {
  try {
    const data = await toggleLike(post.id);
    const idx = posts.value.findIndex((p) => p.id === post.id);
    if (idx >= 0 && data.post) posts.value[idx] = data.post;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function onComment(post) {
  const text = String(commentDrafts.value[post.id] || "").trim();
  if (!text) return;
  try {
    const data = await addComment(post.id, text);
    commentDrafts.value[post.id] = "";
    const idx = posts.value.findIndex((p) => p.id === post.id);
    if (idx >= 0 && data.post) posts.value[idx] = data.post;
    expandedComments.value[post.id] = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function onTip() {
  tipBusy.value = true;
  tipMsg.value = "";
  try {
    const data = await sendTip({
      toHandle: tipHandle.value.trim(),
      amount: Number(tipAmount.value),
      message: tipMessage.value.trim(),
    });
    tipMsg.value = `已打赏 ${data.tip?.amount} 币给 @${data.tip?.to?.handle}`;
    me.value = data.member ?? me.value;
    tipHandle.value = "";
    tipMessage.value = "";
    const t = await fetchTips(40);
    tips.value = t.tips ?? [];
  } catch (e) {
    tipMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    tipBusy.value = false;
  }
}

function tipQuick(member) {
  if (!SHOW_COMMUNITY_TIPS) return;
  tipHandle.value = member.handle || "";
  view.value = "tip";
}

function gotoView(v) {
  if (v === "tip" && !SHOW_COMMUNITY_TIPS) return;
  view.value = v;
}

watch(view, async (t) => {
  if (t === "plaza") {
    try {
      await refreshPosts();
    } catch {
      /* ignore */
    }
  }
});

onMounted(() => {
  void reload();
});
</script>

<template>
  <div class="community">
    <header class="top">
      <div>
        <h1>社区</h1>
        <p class="sub">聊天大厅 · 消息频道 · Twitter · 动态</p>
      </div>
      <nav class="seg">
        <button type="button" :class="{ on: view === 'chat' }" @click="view = 'chat'">聊天</button>
        <button type="button" :class="{ on: view === 'feed' }" @click="view = 'feed'">消息频道</button>
        <button type="button" :class="{ on: view === 'twitter' }" @click="view = 'twitter'">Twitter</button>
        <button type="button" :class="{ on: view === 'plaza' }" @click="view = 'plaza'">动态</button>
        <button
          v-if="SHOW_COMMUNITY_TIPS"
          type="button"
          :class="{ on: view === 'tip' }"
          @click="view = 'tip'"
        >
          打赏
        </button>
        <button type="button" :class="{ on: view === 'titles' }" @click="view = 'titles'">头衔</button>
      </nav>
    </header>

    <p v-if="error" class="banner err">{{ error }}</p>
    <p v-if="loading" class="banner">加载中…</p>

    <div class="shell">
      <main class="main">
        <div v-show="view === 'chat'" class="chat-fill">
          <CommunityChatPanel :me="me" @update:me="me = $event" @tip-member="tipQuick" />
        </div>

        <div v-show="view === 'feed'" class="chat-fill">
          <CommunityFeedPanel feed-type="card" />
        </div>

        <div v-show="view === 'twitter'" class="chat-fill">
          <CommunityFeedPanel feed-type="twitter" />
        </div>

        <section v-show="view === 'plaza'" class="panel feed">
          <h2>动态广场</h2>
          <div v-if="me" class="composer">
            <textarea v-model="postText" rows="3" maxlength="2000" placeholder="分享观点、信号复盘…" />
            <button type="button" class="primary" :disabled="postBusy || !postText.trim()" @click="onPost">
              {{ postBusy ? "发布中…" : "发布" }}
            </button>
          </div>
          <p v-else class="muted">在右侧登录后可发动态。</p>

          <article v-for="p in posts" :key="p.id" class="post-card">
            <header class="post-hd">
              <CommunityHoverCard :member="p.author" @tip="tipQuick">
                <button type="button" class="av-hit">
                  <img v-if="p.author?.avatarUrl" class="av img" :src="p.author.avatarUrl" alt="" />
                  <span
                    v-else
                    class="av"
                    :style="{ background: p.author?.title?.color || '#5865f2' }"
                    >{{ initialOf(p.author?.displayName) }}</span
                  >
                </button>
              </CommunityHoverCard>
              <div>
                <strong>{{ p.author?.displayName || "匿名" }}</strong>
                <CommunityLevelBadges
                  v-if="p.author?.badges || p.author?.level"
                  :badges="p.author?.badges"
                  :level="p.author?.level"
                  size="sm"
                />
                <span class="tb" :style="{ color: p.author?.title?.color }">{{ p.author?.title?.label }}</span>
                <div class="muted tiny">@{{ p.author?.handle }} · {{ formatTime(p.createdAt) }}</div>
              </div>
            </header>
            <p class="post-body">{{ p.content }}</p>
            <footer class="post-ft">
              <button type="button" class="ghost" :disabled="!me" @click="onLike(p)">
                {{ p.liked ? "已赞" : "赞" }} {{ p.likeCount || 0 }}
              </button>
              <button type="button" class="ghost" @click="expandedComments[p.id] = !expandedComments[p.id]">
                评 {{ p.commentCount || 0 }}
              </button>
              <button
                v-if="SHOW_COMMUNITY_TIPS && me && p.author?.handle && p.author.handle !== me.handle"
                type="button"
                class="ghost"
                @click="tipQuick(p.author)"
              >
                打赏
              </button>
            </footer>
            <div v-if="expandedComments[p.id]" class="comments">
              <div v-for="c in p.comments || []" :key="c.id" class="comment">
                <strong>{{ c.author?.displayName }}</strong>
                <span class="muted tiny">{{ formatTime(c.createdAt) }}</span>
                <p>{{ c.content }}</p>
              </div>
              <div v-if="me" class="row">
                <input
                  v-model="commentDrafts[p.id]"
                  placeholder="写评论…"
                  maxlength="1000"
                  @keyup.enter="onComment(p)"
                />
                <button type="button" class="primary sm" @click="onComment(p)">发送</button>
              </div>
            </div>
          </article>
          <p v-if="!posts.length" class="muted">还没有动态。</p>
        </section>

        <section v-if="SHOW_COMMUNITY_TIPS" v-show="view === 'tip'" class="panel">
          <h2>打赏</h2>
          <p class="muted">用打赏币感谢优质分享。新会员有赠币。</p>
          <div v-if="me" class="tip-form">
            <p>余额 <strong>{{ me.tipBalance }}</strong> 币</p>
            <div class="row">
              <input v-model="tipHandle" placeholder="对方 handle" />
              <input v-model.number="tipAmount" type="number" min="1" max="10000" />
            </div>
            <input v-model="tipMessage" placeholder="留言（可选）" maxlength="200" />
            <button type="button" class="primary" :disabled="tipBusy || !tipHandle.trim()" @click="onTip">
              {{ tipBusy ? "发送中…" : "打赏" }}
            </button>
            <p v-if="tipMsg" class="ok">{{ tipMsg }}</p>
          </div>
          <p v-else class="muted">请先在右侧登录。</p>
          <h3 class="subh">最近打赏</h3>
          <ul class="tip-list">
            <li v-for="t in tips" :key="t.id">
              <span
                ><strong>{{ t.from?.displayName }}</strong> → <strong>{{ t.to?.displayName }}</strong></span
              >
              <span class="amt">+{{ t.amount }}</span>
              <span class="muted tiny">{{ t.message || formatTime(t.createdAt) }}</span>
            </li>
          </ul>
          <p v-if="!tips.length" class="muted">暂无记录。</p>
        </section>

        <section v-show="view === 'titles'" class="panel">
          <h2>等级与头衔</h2>
          <p class="muted">
            {{ levelSystem?.rule || "4星=1月，4月=1日，4日=1冠（同 QQ）" }}。{{
              levelSystem?.costHint || "升级耗分随等级递增"
            }}。
          </p>
          <p v-if="me" class="progress">
            当前
            <CommunityLevelBadges :badges="me.badges" :level="me.level" />
            <span class="tb" :style="{ color: me.title?.color }">{{ me.title?.label }}</span>
            · {{ me.points }} 分
            <template v-if="me.titleProgress?.nextLabel">
              → {{ me.titleProgress.nextLabel }}（Lv.{{ me.titleProgress.nextMinLevel }} /
              {{ me.titleProgress.nextMinPoints }} 分）
            </template>
            <span class="bar"><i :style="{ width: (me.titleProgress?.pct || 0) + '%' }" /></span>
          </p>
          
          <ul class="title-list">
            <li v-for="t in titleRows" :key="t.key + '-desc'">
              <span class="dot" :style="{ background: t.color }" />
              <div>
                <strong :style="{ color: t.color }">{{ t.label }}</strong>
                <div class="title-req">
                  <CommunityLevelBadges :badges="t.badges" :level="t.minLevel" size="sm" :show-level="false" />
                  <span class="muted">
                    {{ t.badgeLabel }} · Lv.{{ t.minLevel }} 起 · ≥ {{ t.minPoints }} 分
                  </span>
                </div>
                <p class="muted">{{ t.desc }}</p>
              </div>
            </li>
          </ul>
        </section>
      </main>

      <CommunityProfileRail
        :me="me"
        :welcome-tip="welcomeTip"
        :leaderboard="leaderboard"
        @update:me="me = $event"
        @refresh="void reload()"
        @logout="onLogout"
        @tip-member="tipQuick"
        @goto="gotoView"
      />
    </div>
  </div>
</template>

<style scoped>
.community {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0.85rem 1rem 1rem;
  background: #111214;
  color: #dbdee1;
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  flex-shrink: 0;
}
.top h1 {
  margin: 0;
  font-size: 1.25rem;
  color: #f2f3f5;
}
.sub {
  margin: 0.2rem 0 0;
  color: #8b9199;
  font-size: 0.82rem;
}
.seg {
  display: flex;
  gap: 0.35rem;
  background: #1a1b1e;
  border: 1px solid #2c2e33;
  border-radius: 999px;
  padding: 0.25rem;
}
.seg button {
  border: 0;
  background: transparent;
  color: #949ba4;
  border-radius: 999px;
  padding: 0.35rem 0.85rem;
  font-weight: 700;
  font-size: 0.82rem;
  cursor: pointer;
}
.seg button.on {
  background: #5865f2;
  color: #fff;
}
.banner {
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  background: #1e1f22;
  margin-bottom: 0.65rem;
  flex-shrink: 0;
}
.banner.err {
  background: #4a1f22;
  color: #f2a7ad;
}
.shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 0.85rem;
  align-items: stretch;
}
@media (max-width: 960px) {
  .shell {
    grid-template-columns: 1fr;
    overflow: auto;
  }
  .chat-fill {
    height: min(65vh, 560px);
  }
}
.main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.chat-fill {
  flex: 1;
  min-height: 0;
  height: 100%;
}
.panel {
  background: #1e1f22;
  border: 1px solid #2c2e33;
  border-radius: 16px;
  padding: 1rem 1.1rem;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.panel h2 {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
  color: #f2f3f5;
}
.muted {
  color: #8b9199;
}
.tiny {
  font-size: 0.75rem;
}
.ok {
  color: #57f287;
  margin: 0;
  font-size: 0.88rem;
}
.composer textarea {
  width: 100%;
  background: #151618;
  border: 1px solid #34363c;
  border-radius: 10px;
  color: #dbdee1;
  padding: 0.65rem 0.75rem;
  font: inherit;
  resize: vertical;
  margin-bottom: 0.5rem;
}
.primary {
  background: #5865f2;
  border: 0;
  color: #fff;
  border-radius: 10px;
  padding: 0.5rem 1rem;
  font-weight: 700;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary.sm {
  padding: 0.35rem 0.7rem;
  font-size: 0.82rem;
}
.ghost {
  background: transparent;
  border: 1px solid #3a3c43;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
  font-size: 0.82rem;
}
.post-card {
  border-top: 1px solid #2c2e33;
  padding: 0.85rem 0;
}
.post-hd {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
}
.av {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: #fff;
  flex-shrink: 0;
}
.av.img {
  object-fit: cover;
}
.av-hit {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  line-height: 0;
  border-radius: 50%;
}
.title-icons {
  margin: 0.25rem 0;
}
.title-req {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.5rem;
  margin: 0.25rem 0 0.15rem;
  font-size: 0.85rem;
}
.title-table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0 1rem;
  font-size: 0.88rem;
}
.title-table th,
.title-table td {
  text-align: left;
  padding: 0.45rem 0.55rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  vertical-align: middle;
}
.title-table th {
  color: #9aa3b5;
  font-weight: 600;
  font-size: 0.75rem;
}
.title-table .dot {
  display: inline-block;
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  margin-right: 0.4rem;
  vertical-align: middle;
}
.title-icons-cell {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.tb {
  font-size: 0.75rem;
  font-weight: 700;
  margin-left: 0.35rem;
}
.post-body {
  margin: 0.55rem 0;
  white-space: pre-wrap;
  line-height: 1.5;
}
.post-ft {
  display: flex;
  gap: 0.45rem;
  flex-wrap: wrap;
}
.comments {
  margin-top: 0.65rem;
  padding: 0.65rem;
  background: #151618;
  border-radius: 10px;
}
.comment {
  margin-bottom: 0.5rem;
}
.comment p {
  margin: 0.2rem 0 0;
}
.row {
  display: flex;
  gap: 0.45rem;
  flex-wrap: wrap;
  margin-top: 0.45rem;
}
.row input,
.tip-form input {
  flex: 1;
  min-width: 120px;
  background: #151618;
  border: 1px solid #34363c;
  border-radius: 8px;
  color: #dbdee1;
  padding: 0.5rem 0.65rem;
  font: inherit;
}
.tip-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.subh {
  margin: 1.1rem 0 0.5rem;
  font-size: 0.95rem;
  color: #f2f3f5;
}
.tip-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tip-list li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.15rem 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #2c2e33;
  font-size: 0.88rem;
}
.amt {
  color: #f1c40f;
  font-weight: 700;
}
.title-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.title-list li {
  display: flex;
  gap: 0.75rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid #2c2e33;
}
.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin-top: 0.35rem;
  flex-shrink: 0;
}
.progress .bar {
  display: block;
  height: 6px;
  background: #151618;
  border-radius: 999px;
  margin-top: 0.55rem;
  overflow: hidden;
}
.progress .bar i {
  display: block;
  height: 100%;
  background: #5865f2;
}
</style>
