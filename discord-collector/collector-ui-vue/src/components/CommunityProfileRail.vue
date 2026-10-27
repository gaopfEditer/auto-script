<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  fetchAvatarPacks,
  fetchCommunityAuthConfig,
  loginCommunityWithEmail,
  loginCommunityWithGoogle,
  logoutCommunity,
  patchCommunityMe,
  postCheckin,
  registerCommunityWithEmail,
  SHOW_COMMUNITY_TIPS,
  updateMyAvatar,
} from "../lib/communityApi.js";
import CommunityLevelBadges from "./CommunityLevelBadges.vue";
import CommunityHoverCard from "./CommunityHoverCard.vue";

const props = defineProps({
  me: { type: Object, default: null },
  welcomeTip: { type: Number, default: 100 },
  leaderboard: { type: Array, default: () => [] },
});

const emit = defineEmits(["update:me", "logout", "tip-member", "goto", "refresh"]);

/** 供模板使用 */
const showTips = SHOW_COMMUNITY_TIPS;

const authMode = ref("login"); // login | register
const authBusy = ref(false);
const authError = ref("");
const email = ref("");
const password = ref("");
const displayName = ref("");
const authCfg = ref({ googleEnabled: false, googleClientId: "", requireGoogleMail: false });

const googleBtnEl = ref(null);
let googleScriptLoaded = false;

const editing = ref(false);
const editName = ref("");
const editBio = ref("");
const editBusy = ref(false);
const editMsg = ref("");
const editError = ref("");

const packs = ref([]);
const packsLoaded = ref(false);
const avatarBusy = ref(false);
const showAvatars = ref(false);

const checkinBusy = ref(false);
const checkinMsg = ref("");

const today = computed(() => new Date().toISOString().slice(0, 10));
const checkedToday = computed(() => props.me?.lastCheckinDay === today.value);

function initialOf(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
}

watch(
  () => props.me,
  (m) => {
    if (m) {
      editName.value = String(m.displayName || "");
      editBio.value = String(m.bio || "");
    }
  },
  { immediate: true },
);

watch(
  () => [authCfg.value.googleEnabled, authCfg.value.googleClientId, props.me, authMode.value],
  async () => {
    if (!props.me && authCfg.value.googleEnabled) {
      await nextTick();
      void renderGoogleButton();
    }
  },
);

async function ensurePacks() {
  if (packsLoaded.value) return;
  try {
    const data = await fetchAvatarPacks();
    packs.value = data.packs ?? [];
    packsLoaded.value = true;
  } catch {
    packs.value = [];
  }
}

async function loadAuthConfig() {
  try {
    authCfg.value = await fetchCommunityAuthConfig();
  } catch {
    authCfg.value = { googleEnabled: false, googleClientId: "", requireGoogleMail: false };
  }
}

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (googleScriptLoaded && /** @type {any} */ (window).google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector("script[data-community-gis]");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Google 脚本加载失败")));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.dataset.communityGis = "1";
    s.onload = () => {
      googleScriptLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("Google 脚本加载失败"));
    document.head.appendChild(s);
  });
}

async function onGoogleCredential(resp) {
  const idToken = resp?.credential;
  if (!idToken) return;
  authBusy.value = true;
  authError.value = "";
  try {
    const data = await loginCommunityWithGoogle(idToken);
    emit("update:me", data.member);
    emit("refresh");
    editing.value = true;
    showAvatars.value = !data.member?.avatarUrl;
    await ensurePacks();
  } catch (e) {
    authError.value = e instanceof Error ? e.message : String(e);
  } finally {
    authBusy.value = false;
  }
}

async function renderGoogleButton() {
  if (!authCfg.value.googleClientId || !googleBtnEl.value || props.me) return;
  try {
    await loadGoogleScript();
    const g = /** @type {any} */ (window).google;
    if (!g?.accounts?.id) return;
    googleBtnEl.value.innerHTML = "";
    g.accounts.id.initialize({
      client_id: authCfg.value.googleClientId,
      callback: onGoogleCredential,
      auto_select: false,
      ux_mode: "popup",
    });
    g.accounts.id.renderButton(googleBtnEl.value, {
      theme: "filled_black",
      size: "large",
      shape: "pill",
      text: "continue_with",
      locale: "zh_CN",
      width: 260,
    });
  } catch (e) {
    authError.value = e instanceof Error ? e.message : String(e);
  }
}

async function onAuthSubmit() {
  authBusy.value = true;
  authError.value = "";
  try {
    const payload = {
      email: email.value.trim(),
      password: password.value,
    };
    const data =
      authMode.value === "register"
        ? await registerCommunityWithEmail({
            ...payload,
            displayName: displayName.value.trim() || undefined,
          })
        : await loginCommunityWithEmail(payload);
    emit("update:me", data.member);
    emit("refresh");
    password.value = "";
    if (authMode.value === "register") {
      editing.value = true;
      showAvatars.value = true;
      await ensurePacks();
    }
  } catch (e) {
    authError.value = e instanceof Error ? e.message : String(e);
  } finally {
    authBusy.value = false;
  }
}

function openEdit() {
  editing.value = true;
  editMsg.value = "";
  editError.value = "";
  void ensurePacks();
}

function closeEdit() {
  editing.value = false;
  showAvatars.value = false;
  editMsg.value = "";
  editError.value = "";
}

async function saveProfile() {
  if (!props.me) return;
  editBusy.value = true;
  editError.value = "";
  editMsg.value = "";
  try {
    const data = await patchCommunityMe({
      displayName: editName.value.trim(),
      bio: editBio.value.trim(),
    });
    if (data.member) emit("update:me", data.member);
    editMsg.value = "资料已保存";
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  } finally {
    editBusy.value = false;
  }
}

async function chooseAvatar(url) {
  avatarBusy.value = true;
  editError.value = "";
  try {
    const data = await updateMyAvatar(url);
    if (data.member) emit("update:me", data.member);
    editMsg.value = "头像已更新";
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e);
  } finally {
    avatarBusy.value = false;
  }
}

async function onCheckin() {
  checkinBusy.value = true;
  checkinMsg.value = "";
  try {
    const data = await postCheckin();
    checkinMsg.value = data.message || "签到完成";
    if (data.member) emit("update:me", data.member);
  } catch (e) {
    checkinMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    checkinBusy.value = false;
  }
}

function onLogout() {
  logoutCommunity();
  emit("logout");
  editing.value = false;
  nextTick(() => {
    void renderGoogleButton();
  });
}

onMounted(async () => {
  await loadAuthConfig();
  if (props.me) void ensurePacks();
  else void renderGoogleButton();
});

onUnmounted(() => {
  /* GIS 按钮随 DOM 销毁即可 */
});
</script>

<template>
  <aside class="rail">
    <!-- 未登录：邮箱 / Google -->
    <section v-if="!me" class="card join-card">
      <div class="join-avatar" aria-hidden="true">✉</div>
      <h3>{{ authMode === "login" ? "登录社区" : "注册账号" }}</h3>
      <p class="muted">
        账号信息保存在后台。支持邮箱密码
        <template v-if="authCfg.requireGoogleMail">（仅 Gmail）</template>
        <template v-if="authCfg.googleEnabled">与 Google 一键登录</template>。
        <template v-if="showTips">注册赠 {{ welcomeTip }} 打赏币。</template>
      </p>

      <div class="auth-tabs">
        <button type="button" :class="{ on: authMode === 'login' }" @click="authMode = 'login'">登录</button>
        <button type="button" :class="{ on: authMode === 'register' }" @click="authMode = 'register'">
          注册
        </button>
      </div>

      <div v-if="authCfg.googleEnabled" class="google-wrap">
        <div ref="googleBtnEl" class="google-btn" />
        <p class="or">或使用邮箱</p>
      </div>
      <p v-else class="muted tiny">未配置 Google Client ID 时仅可用邮箱注册登录。</p>

      <label v-if="authMode === 'register'" class="field">
        <span>昵称（可选）</span>
        <input v-model="displayName" maxlength="32" placeholder="怎么称呼你" autocomplete="nickname" />
      </label>
      <label class="field">
        <span>邮箱</span>
        <input
          v-model="email"
          type="email"
          maxlength="255"
          :placeholder="authCfg.requireGoogleMail ? 'you@gmail.com' : 'you@example.com'"
          autocomplete="username"
          @keyup.enter="onAuthSubmit"
        />
      </label>
      <label class="field">
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          maxlength="128"
          :placeholder="authMode === 'register' ? '至少 8 位' : '登录密码'"
          autocomplete="current-password"
          @keyup.enter="onAuthSubmit"
        />
      </label>
      <p v-if="authError" class="err">{{ authError }}</p>
      <button
        type="button"
        class="primary"
        :disabled="authBusy || !email.trim() || password.length < (authMode === 'register' ? 8 : 1)"
        @click="onAuthSubmit"
      >
        {{
          authBusy
            ? authMode === "login"
              ? "登录中…"
              : "注册中…"
            : authMode === "login"
              ? "登录"
              : "注册并加入"
        }}
      </button>
    </section>

    <!-- 已登录：资料卡 -->
    <section v-else class="card profile-card">
      <button type="button" class="avatar-btn" title="编辑资料" @click="openEdit">
        <img v-if="me.avatarUrl" class="avatar-lg img" :src="me.avatarUrl" alt="" />
        <span
          v-else
          class="avatar-lg"
          :style="{ background: me.title?.color || '#5865f2' }"
          >{{ initialOf(me.displayName) }}</span
        >
        <span class="edit-fab">编辑</span>
      </button>
      <h3 class="name">{{ me.displayName }}</h3>
      <p class="handle">@{{ me.handle }}</p>
      <p v-if="me.email" class="muted tiny email-line">{{ me.email }}</p>
      <div class="level-row">
        <CommunityLevelBadges :badges="me.badges" :level="me.level" />
      </div>
      <span class="title-pill" :style="{ color: me.title?.color, borderColor: me.title?.color }">{{
        me.title?.label
      }}</span>
      <p v-if="me.pointsToNextLevel != null" class="muted next-lv">
        距 Lv.{{ me.nextLevel }} 还需 {{ me.pointsToNextLevel }} 分
      </p>
      <span v-if="me.levelProgressPct != null" class="mini-bar"
        ><i :style="{ width: (me.levelProgressPct || 0) + '%' }"
      /></span>
      <p v-if="me.bio" class="bio">{{ me.bio }}</p>
      <div class="stats">
        <div><b>{{ me.points }}</b><span>积分</span></div>
        <div v-if="showTips"><b>{{ me.tipBalance }}</b><span>打赏币</span></div>
        <div><b>{{ me.checkinStreak || 0 }}</b><span>连签</span></div>
      </div>
      <div class="actions">
        <button type="button" class="primary sm" :disabled="checkinBusy || checkedToday" @click="onCheckin">
          {{ checkedToday ? "今日已签" : checkinBusy ? "签到中…" : "每日签到" }}
        </button>
        <button type="button" class="ghost sm" @click="openEdit">编辑资料</button>
      </div>
      <p v-if="checkinMsg" class="ok">{{ checkinMsg }}</p>
      <button type="button" class="linkish" @click="onLogout">退出登录</button>
    </section>

    <!-- 编辑抽屉 -->
    <section v-if="me && editing" class="card edit-card">
      <header class="edit-hd">
        <h4>编辑资料</h4>
        <button type="button" class="ghost sm" @click="closeEdit">完成</button>
      </header>
      <label class="field">
        <span>昵称</span>
        <input v-model="editName" maxlength="32" />
      </label>
      <label class="field">
        <span>简介</span>
        <textarea v-model="editBio" rows="3" maxlength="200" placeholder="一句话介绍自己" />
      </label>
      <button type="button" class="primary sm" :disabled="editBusy || !editName.trim()" @click="saveProfile">
        {{ editBusy ? "保存中…" : "保存资料" }}
      </button>
      <p v-if="editMsg" class="ok">{{ editMsg }}</p>
      <p v-if="editError" class="err">{{ editError }}</p>

      <button type="button" class="ghost sm block" @click="showAvatars = !showAvatars">
        {{ showAvatars ? "收起头像包" : "更换头像" }}
      </button>
      <div v-if="showAvatars" class="packs">
        <div v-for="pack in packs" :key="pack.id" class="pack">
          <h5>{{ pack.label }}</h5>
          <div class="pack-grid">
            <button
              v-for="a in pack.avatars"
              :key="a.id"
              type="button"
              class="pack-item"
              :class="{ active: me.avatarUrl === a.url }"
              :disabled="avatarBusy"
              :title="a.label"
              @click="chooseAvatar(a.url)"
            >
              <img :src="a.url" :alt="a.label" />
            </button>
          </div>
        </div>
        <p v-if="!packs.length" class="muted">暂无头像包</p>
      </div>
    </section>

    <section class="card lb-card">
      <h4>积分榜</h4>
      <ol class="lb">
        <li v-for="(m, i) in leaderboard" :key="m.id">
          <span class="rank">{{ i + 1 }}</span>
          <CommunityHoverCard :member="m" @tip="emit('tip-member', $event)">
            <button type="button" class="lb-av-btn">
              <img v-if="m.avatarUrl" class="avatar-sm img" :src="m.avatarUrl" alt="" />
              <span
                v-else
                class="avatar-sm"
                :style="{ background: m.title?.color || '#5865f2' }"
                >{{ initialOf(m.displayName) }}</span
              >
            </button>
          </CommunityHoverCard>
          <div class="lb-meta">
            <strong>{{ m.displayName }}</strong>
            <CommunityLevelBadges :badges="m.badges" :level="m.level" size="sm" :show-level="false" />
            <span class="muted">{{ m.points }} 分 · {{ m.title?.label }}</span>
          </div>
          <button
            v-if="showTips && me && m.handle !== me.handle"
            type="button"
            class="ghost xs"
            @click="emit('tip-member', m)"
          >
            赏
          </button>
        </li>
      </ol>
      <p v-if="!leaderboard.length" class="muted">暂无成员</p>
    </section>

    <nav class="quick">
      <button type="button" @click="emit('goto', 'plaza')">动态</button>
      <button v-if="showTips" type="button" @click="emit('goto', 'tip')">打赏</button>
      <button type="button" @click="emit('goto', 'titles')">头衔</button>
    </nav>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 0;
  overflow: auto;
  padding-bottom: 0.5rem;
}
.card {
  background: #1e1f22;
  border: 1px solid #2c2e33;
  border-radius: 16px;
  padding: 1rem 1rem 0.9rem;
}
.muted {
  color: #8b9199;
  font-size: 0.8rem;
  margin: 0;
}
.err {
  color: #f38688;
  font-size: 0.8rem;
  margin: 0.35rem 0 0;
}
.ok {
  color: #57f287;
  font-size: 0.8rem;
  margin: 0.35rem 0 0;
}
.join-card {
  text-align: left;
}
.join-card h3 {
  text-align: center;
}
.join-card > .muted:first-of-type {
  text-align: center;
}
.auth-tabs {
  display: flex;
  gap: 0.25rem;
  background: #151618;
  border-radius: 999px;
  padding: 0.2rem;
  margin: 0.75rem 0 0.65rem;
}
.auth-tabs button {
  flex: 1;
  border: 0;
  background: transparent;
  color: #949ba4;
  border-radius: 999px;
  padding: 0.35rem 0.5rem;
  font-weight: 700;
  font-size: 0.8rem;
  cursor: pointer;
}
.auth-tabs button.on {
  background: #5865f2;
  color: #fff;
}
.google-wrap {
  margin-bottom: 0.55rem;
}
.google-btn {
  display: flex;
  justify-content: center;
  min-height: 40px;
}
.or {
  margin: 0.55rem 0 0.15rem;
  color: #6a6e76;
  font-size: 0.72rem;
}
.tiny {
  font-size: 0.72rem;
}
.email-line {
  margin: 0.15rem 0 0.35rem;
  word-break: break-all;
}
.join-avatar {
  width: 72px;
  height: 72px;
  margin: 0 auto 0.65rem;
  border-radius: 50%;
  background: #2b2d31;
  border: 2px dashed #4a4d55;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.6rem;
  font-weight: 800;
  color: #6a6e76;
}
.join-card h3,
.profile-card .name {
  margin: 0 0 0.35rem;
  color: #f2f3f5;
  font-size: 1.05rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  text-align: left;
  margin-top: 0.65rem;
  font-size: 0.75rem;
  color: #949ba4;
}
.field input,
.field textarea {
  background: #151618;
  border: 1px solid #34363c;
  border-radius: 10px;
  color: #dbdee1;
  padding: 0.5rem 0.7rem;
  font: inherit;
  resize: vertical;
}
.primary {
  margin-top: 0.75rem;
  width: 100%;
  border: 0;
  background: #5865f2;
  color: #fff;
  border-radius: 10px;
  padding: 0.55rem 0.85rem;
  font-weight: 700;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary.sm,
.ghost.sm {
  width: auto;
  margin-top: 0;
  padding: 0.4rem 0.75rem;
  font-size: 0.82rem;
}
.ghost {
  border: 1px solid #3a3c43;
  background: #25272c;
  color: #c4c8ce;
  border-radius: 10px;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
  font-size: 0.82rem;
}
.ghost.xs {
  padding: 0.2rem 0.4rem;
  font-size: 0.72rem;
  border-radius: 8px;
}
.ghost.block {
  width: 100%;
  margin-top: 0.65rem;
}
.profile-card {
  text-align: center;
}
.avatar-btn {
  position: relative;
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  margin: 0 auto 0.55rem;
  display: block;
}
.avatar-lg {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 2rem;
  font-weight: 800;
  color: #fff;
  box-shadow: 0 0 0 3px #2b2d31, 0 8px 24px rgba(0, 0, 0, 0.35);
}
.avatar-lg.img {
  object-fit: cover;
  background: #2b2d31;
}
.edit-fab {
  position: absolute;
  right: -2px;
  bottom: 2px;
  background: #5865f2;
  color: #fff;
  font-size: 0.68rem;
  font-weight: 700;
  border-radius: 999px;
  padding: 0.15rem 0.45rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.handle {
  margin: 0;
  color: #8b9199;
  font-size: 0.82rem;
}
.level-row {
  margin-top: 0.4rem;
  display: flex;
  justify-content: center;
}
.next-lv {
  margin-top: 0.35rem !important;
  font-size: 0.72rem !important;
}
.mini-bar {
  display: block;
  height: 5px;
  margin: 0.35rem auto 0;
  width: 80%;
  background: #111214;
  border-radius: 999px;
  overflow: hidden;
}
.mini-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #5865f2, #57f287);
}
.lb-av-btn {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  line-height: 0;
  border-radius: 50%;
}
.title-pill {
  display: inline-block;
  margin-top: 0.45rem;
  border: 1px solid;
  border-radius: 999px;
  padding: 0.15rem 0.55rem;
  font-size: 0.72rem;
  font-weight: 700;
}
.bio {
  margin: 0.55rem 0 0;
  font-size: 0.82rem;
  color: #b5bac1;
  line-height: 1.4;
}
.stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.35rem;
  margin-top: 0.85rem;
  padding-top: 0.75rem;
  border-top: 1px solid #2c2e33;
}
.stats div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.stats b {
  color: #f2f3f5;
  font-size: 1rem;
}
.stats span {
  color: #8b9199;
  font-size: 0.68rem;
}
.actions {
  display: flex;
  gap: 0.4rem;
  justify-content: center;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}
.linkish {
  margin-top: 0.55rem;
  border: 0;
  background: transparent;
  color: #6a6e76;
  font-size: 0.75rem;
  cursor: pointer;
  text-decoration: underline;
}
.edit-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.35rem;
}
.edit-hd h4 {
  margin: 0;
  color: #f2f3f5;
  font-size: 0.95rem;
}
.packs {
  margin-top: 0.65rem;
  max-height: 220px;
  overflow: auto;
}
.pack h5 {
  margin: 0.45rem 0 0.35rem;
  font-size: 0.78rem;
  color: #b5bac1;
}
.pack-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.4rem;
}
.pack-item {
  border: 1px solid #34363c;
  background: #151618;
  border-radius: 10px;
  padding: 0.3rem;
  cursor: pointer;
}
.pack-item.active {
  border-color: #5865f2;
  box-shadow: 0 0 0 1px #5865f2;
}
.pack-item img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.lb-card h4 {
  margin: 0 0 0.55rem;
  font-size: 0.9rem;
  color: #f2f3f5;
}
.lb {
  list-style: none;
  margin: 0;
  padding: 0;
}
.lb li {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid #2c2e33;
}
.rank {
  width: 1rem;
  color: #6a6e76;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.avatar-sm {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}
.avatar-sm.img {
  object-fit: cover;
}
.lb-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  font-size: 0.8rem;
}
.lb-meta strong {
  color: #dbdee1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quick {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.4rem;
}
.quick button {
  border: 1px solid #2c2e33;
  background: #1e1f22;
  color: #b5bac1;
  border-radius: 10px;
  padding: 0.45rem 0.3rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.quick button:hover {
  border-color: #5865f2;
  color: #fff;
}
</style>
