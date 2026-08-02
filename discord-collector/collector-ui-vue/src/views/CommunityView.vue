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
  logoutCommunity,
  postCheckin,
  registerCommunityMember,
  sendTip,
  toggleLike,
} from "../lib/communityApi.js";

const tab = ref("plaza"); // plaza | checkin | tip | titles
const loading = ref(true);
const error = ref("");
const me = ref(null);
const titles = ref([]);
const leaderboard = ref([]);
const posts = ref([]);
const tips = ref([]);
const checkinHistory = ref([]);
const welcomeTip = ref(100);

const joinName = ref("");
const joinHandle = ref("");
const joinBusy = ref(false);

const postText = ref("");
const postBusy = ref(false);
const commentDrafts = ref({});
const expandedComments = ref({});

const checkinMsg = ref("");
const checkinBusy = ref(false);

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

async function onJoin() {
  joinBusy.value = true;
  error.value = "";
  try {
    const data = await registerCommunityMember({
      displayName: joinName.value.trim(),
      handle: joinHandle.value.trim() || undefined,
    });
    me.value = data.member;
    joinName.value = "";
    joinHandle.value = "";
    await reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    joinBusy.value = false;
  }
}

function onLogout() {
  logoutCommunity();
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

async function onCheckin() {
  checkinBusy.value = true;
  checkinMsg.value = "";
  try {
    const data = await postCheckin();
    checkinMsg.value = data.message || "签到完成";
    me.value = data.member ?? me.value;
    const hist = await fetchCheckinHistory(14);
    checkinHistory.value = hist.rows ?? [];
  } catch (e) {
    checkinMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    checkinBusy.value = false;
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
  tipHandle.value = member.handle || "";
  tab.value = "tip";
}

watch(tab, async (t) => {
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
    <header class="hero">
      <div>
        <h1>社区</h1>
        <p class="sub">信号卡片 · OI 做单 · 会员互动 — 广场动态、签到成长、打赏互助</p>
      </div>
      <div v-if="me" class="me-chip">
        <span class="avatar" :style="{ background: me.title?.color || '#5865f2' }">{{
          initialOf(me.displayName)
        }}</span>
        <div class="me-meta">
          <strong>{{ me.displayName }}</strong>
          <span class="title-badge" :style="{ color: me.title?.color }">{{ me.title?.label }}</span>
          <span class="muted">@{{ me.handle }} · {{ me.points }} 分 · 币 {{ me.tipBalance }}</span>
        </div>
        <button type="button" class="ghost" @click="onLogout">退出</button>
      </div>
    </header>

    <p v-if="error" class="banner err">{{ error }}</p>
    <p v-if="loading" class="banner">加载中…</p>

    <!-- 加入社区 -->
    <section v-if="!me && !loading" class="panel join">
      <h2>加入社区</h2>
      <p class="muted">本地轻量身份（存于本机 Token），注册即赠 {{ welcomeTip }} 打赏币。</p>
      <div class="row">
        <input v-model="joinName" placeholder="昵称（必填）" maxlength="32" @keyup.enter="onJoin" />
        <input v-model="joinHandle" placeholder="handle（可选，字母数字）" maxlength="24" @keyup.enter="onJoin" />
        <button type="button" class="primary" :disabled="joinBusy || !joinName.trim()" @click="onJoin">
          {{ joinBusy ? "加入中…" : "加入" }}
        </button>
      </div>
    </section>

    <nav class="tabs">
      <button type="button" :class="{ active: tab === 'plaza' }" @click="tab = 'plaza'">动态广场</button>
      <button type="button" :class="{ active: tab === 'checkin' }" @click="tab = 'checkin'">每日签到</button>
      <button type="button" :class="{ active: tab === 'tip' }" @click="tab = 'tip'">打赏专区</button>
      <button type="button" :class="{ active: tab === 'titles' }" @click="tab = 'titles'">会员头衔</button>
    </nav>

    <div class="layout">
      <main class="main">
        <!-- 广场 -->
        <section v-show="tab === 'plaza'" class="panel">
          <h2>动态广场</h2>
          <div v-if="me" class="composer">
            <textarea v-model="postText" rows="3" maxlength="2000" placeholder="分享观点、信号复盘、行情随笔…" />
            <button type="button" class="primary" :disabled="postBusy || !postText.trim()" @click="onPost">
              {{ postBusy ? "发布中…" : "发布动态" }}
            </button>
          </div>
          <p v-else class="muted">加入社区后可发动态、评论与点赞。</p>

          <article v-for="p in posts" :key="p.id" class="post">
            <header class="post-hd">
              <span class="avatar sm" :style="{ background: p.author?.title?.color || '#5865f2' }">{{
                initialOf(p.author?.displayName)
              }}</span>
              <div>
                <strong>{{ p.author?.displayName || "匿名" }}</strong>
                <span class="title-badge" :style="{ color: p.author?.title?.color }">{{
                  p.author?.title?.label
                }}</span>
                <div class="muted tiny">@{{ p.author?.handle }} · {{ formatTime(p.createdAt) }}</div>
              </div>
            </header>
            <p class="post-body">{{ p.content }}</p>
            <footer class="post-ft">
              <button type="button" class="ghost" :disabled="!me" @click="onLike(p)">
                {{ p.liked ? "已赞" : "点赞" }} {{ p.likeCount || 0 }}
              </button>
              <button
                type="button"
                class="ghost"
                @click="expandedComments[p.id] = !expandedComments[p.id]"
              >
                评论 {{ p.commentCount || 0 }}
              </button>
              <button
                v-if="me && p.author?.handle && p.author.handle !== me.handle"
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
          <p v-if="!posts.length" class="muted">还没有动态，来发第一条吧。</p>
        </section>

        <!-- 签到 -->
        <section v-show="tab === 'checkin'" class="panel">
          <h2>每日签到</h2>
          <p class="muted">基础 +10 分，连续签到每日额外 +1（最多 +7）。断签重新计。</p>
          <div v-if="me" class="checkin-box">
            <div class="streak">
              连续 <strong>{{ me.checkinStreak || 0 }}</strong> 天 · 今日{{
                me.lastCheckinDay === new Date().toISOString().slice(0, 10) ? "已签" : "未签"
              }}
            </div>
            <button type="button" class="primary" :disabled="checkinBusy" @click="onCheckin">
              {{ checkinBusy ? "签到中…" : "立即签到" }}
            </button>
            <p v-if="checkinMsg" class="ok">{{ checkinMsg }}</p>
          </div>
          <p v-else class="muted">请先加入社区再签到。</p>
          <ul v-if="checkinHistory.length" class="hist">
            <li v-for="h in checkinHistory" :key="h.day">
              <span>{{ h.day }}</span>
              <span>+{{ h.pointsEarned }} · 连续 {{ h.streak }} 天</span>
            </li>
          </ul>
        </section>

        <!-- 打赏 -->
        <section v-show="tab === 'tip'" class="panel">
          <h2>打赏专区</h2>
          <p class="muted">用打赏币感谢优质分享。新会员赠币；打赏双方都会获得少量积分。</p>
          <div v-if="me" class="tip-form">
            <p>我的余额：<strong>{{ me.tipBalance }}</strong> 币</p>
            <div class="row">
              <input v-model="tipHandle" placeholder="对方 handle（不含 @）" />
              <input v-model.number="tipAmount" type="number" min="1" max="10000" placeholder="数量" />
            </div>
            <input v-model="tipMessage" placeholder="留言（可选）" maxlength="200" />
            <button type="button" class="primary" :disabled="tipBusy || !tipHandle.trim()" @click="onTip">
              {{ tipBusy ? "发送中…" : "打赏" }}
            </button>
            <p v-if="tipMsg" class="ok">{{ tipMsg }}</p>
          </div>
          <p v-else class="muted">加入社区后可打赏。</p>

          <h3 class="subh">最近打赏</h3>
          <ul class="tip-list">
            <li v-for="t in tips" :key="t.id">
              <span>
                <strong>{{ t.from?.displayName }}</strong>
                →
                <strong>{{ t.to?.displayName }}</strong>
              </span>
              <span class="amt">+{{ t.amount }}</span>
              <span class="muted tiny">{{ t.message || formatTime(t.createdAt) }}</span>
            </li>
          </ul>
          <p v-if="!tips.length" class="muted">暂无打赏记录。</p>
        </section>

        <!-- 头衔 -->
        <section v-show="tab === 'titles'" class="panel">
          <h2>会员头衔</h2>
          <p v-if="me" class="progress">
            当前
            <span class="title-badge" :style="{ color: me.title?.color }">{{ me.title?.label }}</span>
            · {{ me.points }} 分
            <template v-if="me.titleProgress?.nextLabel">
              → 下一档 {{ me.titleProgress.nextLabel }}（{{ me.titleProgress.nextMinPoints }} 分）
            </template>
            <span class="bar"><i :style="{ width: (me.titleProgress?.pct || 0) + '%' }" /></span>
          </p>
          <ul class="title-list">
            <li v-for="t in titles" :key="t.key">
              <span class="dot" :style="{ background: t.color }" />
              <div>
                <strong :style="{ color: t.color }">{{ t.label }}</strong>
                <span class="muted"> ≥ {{ t.minPoints }} 分</span>
                <p class="muted">{{ t.desc }}</p>
              </div>
            </li>
          </ul>
        </section>
      </main>

      <aside class="side">
        <section class="panel">
          <h3>积分榜</h3>
          <ol class="lb">
            <li v-for="(m, i) in leaderboard" :key="m.id">
              <span class="rank">{{ i + 1 }}</span>
              <span class="avatar xs" :style="{ background: m.title?.color || '#5865f2' }">{{
                initialOf(m.displayName)
              }}</span>
              <div class="lb-meta">
                <strong>{{ m.displayName }}</strong>
                <span class="title-badge" :style="{ color: m.title?.color }">{{ m.title?.label }}</span>
                <div class="muted tiny">{{ m.points }} 分</div>
              </div>
              <button
                v-if="me && m.handle !== me.handle"
                type="button"
                class="ghost sm"
                @click="tipQuick(m)"
              >
                赏
              </button>
            </li>
          </ol>
          <p v-if="!leaderboard.length" class="muted">暂无成员。</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.community {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 1rem 1.25rem 2rem;
  background: var(--bg, #313338);
  color: var(--text, #dbdee1);
}
.hero {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.hero h1 {
  margin: 0;
  font-size: 1.45rem;
  color: #f2f3f5;
}
.sub {
  margin: 0.35rem 0 0;
  color: var(--muted, #949ba4);
  font-size: 0.92rem;
}
.me-chip {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  background: var(--bg2, #2b2d31);
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 0.55rem 0.75rem;
}
.me-meta {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-size: 0.85rem;
}
.avatar {
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
.avatar.sm {
  width: 36px;
  height: 36px;
  font-size: 0.85rem;
}
.avatar.xs {
  width: 28px;
  height: 28px;
  font-size: 0.72rem;
}
.title-badge {
  font-size: 0.78rem;
  font-weight: 700;
  margin-left: 0.35rem;
}
.muted {
  color: var(--muted, #949ba4);
}
.tiny {
  font-size: 0.75rem;
}
.banner {
  padding: 0.55rem 0.75rem;
  border-radius: 8px;
  background: #1e1f22;
  margin-bottom: 0.75rem;
}
.banner.err {
  background: #4a1f22;
  color: #f2a7ad;
}
.panel {
  background: var(--bg2, #2b2d31);
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 1rem 1.1rem;
  margin-bottom: 1rem;
}
.panel h2,
.panel h3 {
  margin: 0 0 0.65rem;
  font-size: 1.05rem;
  color: #f2f3f5;
}
.subh {
  margin-top: 1.25rem !important;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1rem;
}
.tabs button {
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  border-radius: 999px;
  padding: 0.4rem 0.9rem;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.88rem;
}
.tabs button.active {
  background: var(--accent, #5865f2);
  border-color: var(--accent, #5865f2);
  color: #fff;
}
.layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 1rem;
  align-items: start;
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
input,
textarea {
  flex: 1;
  min-width: 140px;
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  color: #dbdee1;
  padding: 0.55rem 0.7rem;
  font: inherit;
}
textarea {
  width: 100%;
  resize: vertical;
  margin-bottom: 0.5rem;
}
button.primary {
  background: var(--accent, #5865f2);
  border: none;
  color: #fff;
  border-radius: 8px;
  padding: 0.55rem 1rem;
  font-weight: 700;
  cursor: pointer;
}
button.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.primary.sm {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
}
button.ghost {
  background: transparent;
  border: 1px solid #3f4147;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.35rem 0.65rem;
  cursor: pointer;
  font-size: 0.85rem;
}
button.ghost.sm {
  padding: 0.25rem 0.45rem;
  font-size: 0.75rem;
}
.composer {
  margin-bottom: 1rem;
}
.post {
  border-top: 1px solid #3f4147;
  padding: 0.85rem 0;
}
.post-hd {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
}
.post-body {
  margin: 0.55rem 0;
  white-space: pre-wrap;
  line-height: 1.5;
}
.post-ft {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.comments {
  margin-top: 0.65rem;
  padding: 0.65rem;
  background: #1e1f22;
  border-radius: 8px;
}
.comment {
  margin-bottom: 0.55rem;
}
.comment p {
  margin: 0.2rem 0 0;
}
.checkin-box {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  align-items: flex-start;
}
.streak strong {
  font-size: 1.4rem;
  color: #57f287;
}
.hist {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
}
.hist li {
  display: flex;
  justify-content: space-between;
  padding: 0.4rem 0;
  border-bottom: 1px solid #3f4147;
  font-size: 0.88rem;
}
.tip-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.tip-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.tip-list li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.15rem 0.75rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #3f4147;
  font-size: 0.88rem;
}
.tip-list .amt {
  color: #f1c40f;
  font-weight: 700;
}
.ok {
  color: #57f287;
  margin: 0;
  font-size: 0.9rem;
}
.title-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.title-list li {
  display: flex;
  gap: 0.75rem;
  padding: 0.65rem 0;
  border-bottom: 1px solid #3f4147;
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
  background: #1e1f22;
  border-radius: 999px;
  margin-top: 0.55rem;
  overflow: hidden;
}
.progress .bar i {
  display: block;
  height: 100%;
  background: var(--accent, #5865f2);
}
.lb {
  list-style: none;
  padding: 0;
  margin: 0;
}
.lb li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0;
  border-bottom: 1px solid #3f4147;
}
.rank {
  width: 1.2rem;
  color: #949ba4;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
.lb-meta {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
}
</style>
