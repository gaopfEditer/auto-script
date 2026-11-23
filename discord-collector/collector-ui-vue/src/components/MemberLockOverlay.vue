<script setup>
import { useRouter } from "vue-router";
import { useMembership } from "../composables/useMembership.js";

const props = defineProps({
  title: { type: String, default: "开通会员后可查看该内容" },
  detail: {
    type: String,
    default:
      "这是本地非会员体验。博主胜率、频道消息和手动统计详情已锁定，切回「会员」可立即恢复。",
  },
});

const router = useRouter();
const { openContact } = useMembership();

function goCenter() {
  router.push("/local/membership");
}
</script>

<template>
  <div class="mlock" role="dialog" aria-label="会员内容已锁定">
    <div class="mlock-card">
      <div class="mlock-icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.8" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </div>
      <h2>{{ title }}</h2>
      <p>{{ detail }}</p>
      <div class="mlock-actions">
        <button type="button" class="mlock-primary" @click="goCenter">前往会员中心</button>
        <button type="button" class="mlock-ghost" @click="openContact()">联系客服</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mlock {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: rgba(8, 8, 10, 0.55);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
}
.mlock-card {
  width: min(420px, 100%);
  padding: 1.6rem 1.4rem 1.35rem;
  border-radius: 16px;
  background: linear-gradient(180deg, #1c1914 0%, #141311 100%);
  border: 1px solid rgba(212, 175, 99, 0.45);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  text-align: center;
  color: #f3e6c8;
}
.mlock-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  margin-bottom: 0.7rem;
  border-radius: 50%;
  color: #e8c57a;
  background: rgba(212, 175, 99, 0.12);
  border: 1px solid rgba(212, 175, 99, 0.35);
}
.mlock-card h2 {
  margin: 0 0 0.45rem;
  font-size: 1.05rem;
  color: #fff8e8;
}
.mlock-card p {
  margin: 0 0 1.1rem;
  font-size: 0.82rem;
  line-height: 1.55;
  color: #b9aa8c;
}
.mlock-actions {
  display: flex;
  gap: 0.6rem;
  justify-content: center;
  flex-wrap: wrap;
}
.mlock-primary,
.mlock-ghost {
  border-radius: 8px;
  padding: 0.48rem 0.95rem;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
}
.mlock-primary {
  border: none;
  color: #3a2a10;
  background: linear-gradient(180deg, #f3d394 0%, #d4a24a 100%);
}
.mlock-primary:hover {
  filter: brightness(1.06);
}
.mlock-ghost {
  border: 1px solid rgba(212, 175, 99, 0.45);
  background: transparent;
  color: #e8c57a;
}
.mlock-ghost:hover {
  background: rgba(212, 175, 99, 0.1);
}
</style>
