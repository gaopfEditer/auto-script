<script setup>
import { useMembership, MEMBER_PLANS, formatMessageTime } from "../composables/useMembership.js";

defineOptions({ name: "MembershipCenterView" });

const {
  isMember,
  planId,
  selectedPlan,
  messages,
  setPlan,
  openContact,
} = useMembership();

/** @param {string} id */
function pickPlan(id) {
  setPlan(id);
}
</script>

<template>
  <div class="ms-page">
    <div class="ms-wrap">
      <header class="ms-title-row">
        <span class="ms-title-bar" aria-hidden="true" />
        <h1>会员中心</h1>
        <span class="ms-local-tag">本地体验</span>
      </header>

      <section class="ms-id-card">
        <div class="ms-id-copy">
          <div class="ms-id-label">我的身份</div>
          <h2 v-if="isMember">已开通（本地体验），可查看全部本地内容</h2>
          <h2 v-else>开通鲸享 VIP，解锁全部会员频道</h2>
          <p v-if="isMember">当前为本地会员体验，不是真实付费状态。切到「非会员」可预览锁定效果。</p>
          <p v-else>本地演示定价，不是真实收费。开通后可查看博主胜率、频道消息和手动统计详情。</p>
        </div>
        <span class="ms-id-status" :class="{ on: isMember }">{{ isMember ? "已开通" : "待开通" }}</span>
      </section>

      <section class="ms-plans-block">
        <h3 class="ms-sec-title">选择会员类型</h3>
        <div class="ms-vip-box">
          <div class="ms-vip-label">
            <span class="ms-whale" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M4 14c2-5 7-8 11-7 1.5.3 2.2 1 3 2 2 .2 4 1.5 4 3.5-3 0-5 .5-7 2-1.2 1-3 2.5-5 2.5-3 0-6-1.2-6-3z" fill="currentColor" />
                <circle cx="7.5" cy="13" r="0.9" fill="#2a1d0a" />
              </svg>
            </span>
            鲸享 VIP
            <span class="ms-paid">付费</span>
          </div>
          <div class="ms-plan-grid">
            <button
              v-for="p in MEMBER_PLANS"
              :key="p.id"
              type="button"
              class="ms-plan"
              :class="{ on: planId === p.id }"
              @click="pickPlan(p.id)"
            >
              <span class="ms-plan-name">{{ p.name }}</span>
              <span class="ms-plan-price">{{ p.priceLabel }}</span>
              <span class="ms-plan-days">{{ p.duration }}</span>
              <span v-if="planId === p.id" class="ms-plan-check" aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
      </section>

      <section class="ms-perk">
        <h3 class="ms-sec-title">本地体验说明</h3>
        <div class="ms-perk-row">
          <div class="ms-perk-card">
            <div class="ms-perk-kicker">解锁内容</div>
            <p>博主胜率、频道消息、手动统计详情。非会员模式下会遮罩，切回会员立即恢复。</p>
          </div>
          <div class="ms-perk-card alt">
            <div class="ms-perk-kicker">本机留言</div>
            <p>联系客服只写在浏览器本地，不会发到外部，也不是真实付费通道。</p>
          </div>
        </div>
      </section>

      <div v-if="!isMember" class="ms-cta">
        <button type="button" class="ms-cta-btn" @click="openContact()">
          联系客服开通 鲸享 VIP · {{ selectedPlan.name }}
        </button>
        <p class="ms-cta-note">点击后打开本机私信，不会对外发送，也不会产生真实扣费。</p>
      </div>

      <section v-else class="ms-inbox">
        <div class="ms-inbox-head">
          <h3 class="ms-sec-title">本地客服留言</h3>
          <button type="button" class="ms-inbox-open" @click="openContact({ preset: false })">打开收件箱</button>
        </div>
        <p v-if="!messages.length" class="ms-inbox-empty">暂无留言。切到非会员后，可通过「联系开通」在本机留言。</p>
        <ul v-else class="ms-inbox-list">
          <li v-for="m in messages.slice(-8)" :key="m.id">
            <span class="ms-inbox-role" :class="m.role">{{ m.role === "user" ? "访客" : "客服" }}</span>
            <span class="ms-inbox-text">{{ m.text }}</span>
            <time>{{ formatMessageTime(m.ts) }}</time>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ms-page {
  height: 100%;
  overflow: auto;
  background: #0c0c0e;
  color: #e8e0d0;
}
.ms-wrap {
  max-width: 820px;
  margin: 0 auto;
  padding: 1.15rem 1.25rem 2.4rem;
}
.ms-title-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin: 0 0 1rem;
}
.ms-title-bar {
  width: 3px;
  height: 1.05rem;
  border-radius: 2px;
  background: linear-gradient(180deg, #f3d394, #c9953d);
}
.ms-title-row h1 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 800;
  color: #fff8e8;
}
.ms-local-tag {
  margin-left: 0.15rem;
  padding: 0.14rem 0.45rem;
  border-radius: 999px;
  font-size: 0.68rem;
  font-weight: 700;
  color: #e8c57a;
  border: 1px solid rgba(212, 175, 99, 0.4);
  background: rgba(212, 175, 99, 0.1);
}
.ms-id-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.15rem 1.2rem 1.2rem;
  border-radius: 14px;
  background: linear-gradient(115deg, #c9a24a 0%, #e6c57a 38%, #b8882f 100%);
  color: #3a2a10;
  box-shadow: 0 10px 28px rgba(80, 55, 10, 0.28);
}
.ms-id-label {
  font-size: 0.75rem;
  font-weight: 700;
  opacity: 0.75;
  margin-bottom: 0.28rem;
}
.ms-id-copy h2 {
  margin: 0 0 0.35rem;
  font-size: 1.12rem;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.ms-id-copy p {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  opacity: 0.8;
}
.ms-id-status {
  flex-shrink: 0;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 800;
  color: #fff;
  background: #e2454a;
}
.ms-id-status.on {
  background: #2e7d4f;
}
.ms-plans-block {
  margin-top: 1.25rem;
}
.ms-sec-title {
  margin: 0 0 0.65rem;
  font-size: 0.92rem;
  font-weight: 800;
  color: #f2ead6;
}
.ms-vip-box {
  padding: 0.9rem;
  border-radius: 14px;
  border: 1px solid rgba(212, 175, 99, 0.45);
  background: #141312;
}
.ms-vip-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
  font-weight: 800;
  color: #f3d394;
}
.ms-whale {
  display: inline-flex;
  color: #f3d394;
}
.ms-paid {
  padding: 0.12rem 0.4rem;
  border-radius: 6px;
  font-size: 0.65rem;
  font-weight: 700;
  color: #fff;
  background: #d97706;
}
.ms-plan-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.7rem;
}
.ms-plan {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
  padding: 0.85rem 0.95rem 0.75rem;
  border-radius: 12px;
  border: 1px solid #2a2a2c;
  background: #101011;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.ms-plan:hover {
  border-color: rgba(212, 175, 99, 0.4);
}
.ms-plan.on {
  border-color: #e0b85c;
  box-shadow: inset 0 0 0 1px rgba(224, 184, 92, 0.55);
  background: #16130e;
}
.ms-plan-name {
  font-size: 0.82rem;
  color: #cfc6b2;
}
.ms-plan-price {
  font-size: 1.35rem;
  font-weight: 800;
  color: #f3d394;
  letter-spacing: 0.02em;
}
.ms-plan-days {
  font-size: 0.75rem;
  color: #8a8376;
}
.ms-plan-check {
  position: absolute;
  top: 0.55rem;
  right: 0.6rem;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 800;
  color: #3a2a10;
  background: #f3d394;
}
.ms-perk {
  margin-top: 1.2rem;
}
.ms-perk-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.7rem;
}
.ms-perk-card {
  padding: 0.9rem 1rem;
  border-radius: 12px;
  background: #151a1c;
  border: 1px solid #243033;
}
.ms-perk-card.alt {
  background: #1a1414;
  border-color: #3a2224;
}
.ms-perk-kicker {
  font-size: 0.78rem;
  font-weight: 800;
  color: #7ad0c5;
  margin-bottom: 0.3rem;
}
.ms-perk-card.alt .ms-perk-kicker {
  color: #f08a8d;
}
.ms-perk-card p {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: #b9b1a2;
}
.ms-cta {
  margin-top: 1.35rem;
  text-align: center;
}
.ms-cta-btn {
  width: 100%;
  border: none;
  border-radius: 12px;
  padding: 0.85rem 1rem;
  font-size: 0.98rem;
  font-weight: 800;
  color: #3a2a10;
  cursor: pointer;
  background: linear-gradient(180deg, #f6dba0 0%, #d4a24a 55%, #c08a2e 100%);
  box-shadow: 0 8px 20px rgba(180, 130, 40, 0.28);
}
.ms-cta-btn:hover {
  filter: brightness(1.05);
}
.ms-cta-note {
  margin: 0.55rem 0 0;
  font-size: 0.72rem;
  color: #8a8376;
}
.ms-inbox {
  margin-top: 1.35rem;
  padding: 0.9rem 1rem 0.7rem;
  border-radius: 14px;
  border: 1px solid #2a2a2c;
  background: #121214;
}
.ms-inbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
}
.ms-inbox-head .ms-sec-title {
  margin: 0;
}
.ms-inbox-open {
  border: 1px solid rgba(212, 175, 99, 0.4);
  background: transparent;
  color: #e8c57a;
  border-radius: 8px;
  padding: 0.28rem 0.7rem;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}
.ms-inbox-open:hover {
  background: rgba(212, 175, 99, 0.1);
}
.ms-inbox-empty {
  margin: 0.7rem 0 0.2rem;
  font-size: 0.8rem;
  color: #8a8376;
}
.ms-inbox-list {
  list-style: none;
  margin: 0.7rem 0 0;
  padding: 0;
}
.ms-inbox-list li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 0.55rem;
  align-items: start;
  padding: 0.45rem 0;
  border-top: 1px solid #242426;
  font-size: 0.8rem;
}
.ms-inbox-role {
  font-weight: 800;
  color: #7ad0c5;
}
.ms-inbox-role.user {
  color: #7dcea0;
}
.ms-inbox-text {
  color: #d4ccc0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms-inbox-list time {
  color: #6d7178;
  font-size: 0.7rem;
  white-space: nowrap;
}
@media (max-width: 640px) {
  .ms-plan-grid,
  .ms-perk-row {
    grid-template-columns: 1fr;
  }
}
</style>
