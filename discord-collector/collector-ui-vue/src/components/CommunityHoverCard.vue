<script setup>
import { computed, nextTick, onUnmounted, ref } from "vue";
import { SHOW_COMMUNITY_TIPS } from "../lib/communityApi.js";
import CommunityLevelBadges from "./CommunityLevelBadges.vue";

const props = defineProps({
  /** 会员公开资料（含 level / badges / title） */
  member: { type: Object, default: null },
  /** 触发元素：默认插槽 */
  placement: { type: String, default: "auto" }, // auto | top | bottom
});

const emit = defineEmits(["tip"]);
const showTips = SHOW_COMMUNITY_TIPS;

const open = ref(false);
const wrapEl = ref(null);
const cardEl = ref(null);
const pos = ref({ top: 0, left: 0 });
let hideTimer = null;
let showTimer = null;

const hasMember = computed(() => Boolean(props.member?.id || props.member?.handle));

function initialOf(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
}

function clearTimers() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function placeCard() {
  const wrap = wrapEl.value;
  const card = cardEl.value;
  if (!wrap || !card) return;
  const r = wrap.getBoundingClientRect();
  const cw = card.offsetWidth || 260;
  const ch = card.offsetHeight || 180;
  let left = r.left + r.width / 2 - cw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
  let top = r.bottom + 8;
  if (props.placement === "top" || (props.placement === "auto" && top + ch > window.innerHeight - 8)) {
    top = r.top - ch - 8;
  }
  if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - ch - 8);
  pos.value = { top, left };
}

function onEnter() {
  if (!hasMember.value) return;
  clearTimers();
  showTimer = setTimeout(async () => {
    open.value = true;
    await nextTick();
    placeCard();
  }, 220);
}

function onLeave() {
  clearTimers();
  hideTimer = setTimeout(() => {
    open.value = false;
  }, 180);
}

function keepOpen() {
  clearTimers();
  open.value = true;
}

onUnmounted(() => clearTimers());
</script>

<template>
  <span
    ref="wrapEl"
    class="hover-wrap"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @focusin="onEnter"
    @focusout="onLeave"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="open && hasMember"
        ref="cardEl"
        class="hover-card"
        :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
        @mouseenter="keepOpen"
        @mouseleave="onLeave"
      >
        <div class="hc-top">
          <img v-if="member.avatarUrl" class="hc-av img" :src="member.avatarUrl" alt="" />
          <span
            v-else
            class="hc-av"
            :style="{ background: member.title?.color || '#5865f2' }"
            >{{ initialOf(member.displayName) }}</span
          >
          <div class="hc-id">
            <strong>{{ member.displayName }}</strong>
            <span class="hc-handle">@{{ member.handle }}</span>
            <CommunityLevelBadges :badges="member.badges" :level="member.level" size="sm" />
          </div>
        </div>
        <div class="hc-title" :style="{ color: member.title?.color }">
          {{ member.title?.label || "新芽" }}
          <span class="hc-muted">· Lv.{{ member.level || 1 }}</span>
        </div>
        <p v-if="member.bio" class="hc-bio">{{ member.bio }}</p>
        <p v-else class="hc-bio muted">暂无简介</p>
        <div class="hc-stats">
          <div><b>{{ member.points ?? 0 }}</b><span>积分</span></div>
          <div><b>{{ member.checkinStreak ?? 0 }}</b><span>连签</span></div>
          <div v-if="showTips"><b>{{ member.tipBalance ?? "—" }}</b><span>打赏币</span></div>
        </div>
        <div v-if="member.levelProgressPct != null" class="hc-bar-wrap">
          <span class="hc-muted"
            >距 Lv.{{ member.nextLevel || (member.level || 1) + 1 }} 还需
            {{ member.pointsToNextLevel ?? "?" }} 分</span
          >
          <span class="hc-bar"><i :style="{ width: (member.levelProgressPct || 0) + '%' }" /></span>
        </div>
        <button
          v-if="showTips && member.handle"
          type="button"
          class="hc-tip"
          @click.stop="emit('tip', member)"
        >
          打赏 Ta
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.hover-wrap {
  display: inline-flex;
  vertical-align: middle;
  position: relative;
}
.hover-card {
  position: fixed;
  z-index: 200;
  width: 268px;
  padding: 0.85rem 0.9rem 0.75rem;
  background: #1a1b1e;
  border: 1px solid #3a3c43;
  border-radius: 14px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  color: #dbdee1;
  pointer-events: auto;
}
.hc-top {
  display: flex;
  gap: 0.65rem;
  align-items: center;
}
.hc-av {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  color: #fff;
  font-size: 1.2rem;
  flex-shrink: 0;
}
.hc-av.img {
  object-fit: cover;
  background: #2b2d31;
}
.hc-id {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.hc-id strong {
  font-size: 0.95rem;
  color: #f2f3f5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hc-handle {
  font-size: 0.75rem;
  color: #8b9199;
}
.hc-title {
  margin-top: 0.55rem;
  font-size: 0.82rem;
  font-weight: 700;
}
.hc-muted {
  color: #8b9199;
  font-weight: 500;
  font-size: 0.75rem;
}
.hc-bio {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  line-height: 1.4;
  color: #b5bac1;
}
.hc-bio.muted {
  color: #6a6e76;
}
.hc-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.35rem;
  margin-top: 0.65rem;
  padding-top: 0.55rem;
  border-top: 1px solid #2c2e33;
  text-align: center;
}
.hc-stats b {
  display: block;
  color: #f2f3f5;
  font-size: 0.92rem;
}
.hc-stats span {
  font-size: 0.65rem;
  color: #8b9199;
}
.hc-bar-wrap {
  margin-top: 0.55rem;
}
.hc-bar {
  display: block;
  height: 5px;
  margin-top: 0.3rem;
  background: #111214;
  border-radius: 999px;
  overflow: hidden;
}
.hc-bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #5865f2, #57f287);
}
.hc-tip {
  margin-top: 0.65rem;
  width: 100%;
  border: 0;
  background: #5865f2;
  color: #fff;
  border-radius: 8px;
  padding: 0.4rem;
  font-weight: 700;
  font-size: 0.8rem;
  cursor: pointer;
}
</style>
