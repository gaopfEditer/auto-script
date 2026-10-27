<script setup>
import { computed } from "vue";
import { levelBadgesFromLevel } from "../lib/communityLevel.js";

const props = defineProps({
  /** @type {{ crowns?: number, suns?: number, moons?: number, stars?: number, level?: number } | null} */
  badges: { type: Object, default: null },
  level: { type: Number, default: 0 },
  size: { type: String, default: "md" }, // sm | md
  showLevel: { type: Boolean, default: true },
});

function iconCount(b) {
  if (!b) return 0;
  return (
    (Number(b.crowns) || 0) +
    (Number(b.suns) || 0) +
    (Number(b.moons) || 0) +
    (Number(b.stars) || 0)
  );
}

/** badges 缺字段时按 level 重算，避免一律掉成一星 */
const resolved = computed(() => {
  const b = props.badges;
  if (b && iconCount(b) > 0) return b;
  const lv = Number(b?.level || props.level) || 0;
  if (lv > 0) return levelBadgesFromLevel(lv);
  return levelBadgesFromLevel(1);
});

const icons = computed(() => {
  const b = resolved.value;
  /** @type {{ kind: string, char: string, title: string }[]} */
  const list = [];
  const push = (n, kind, char, title) => {
    const c = Math.max(0, Number(n) || 0);
    for (let i = 0; i < c; i++) list.push({ kind, char, title });
  };
  push(b.crowns, "crown", "👑", "冠");
  push(b.suns, "sun", "☀️", "日");
  push(b.moons, "moon", "🌙", "月");
  push(b.stars, "star", "⭐", "星");
  if (!list.length) list.push({ kind: "star", char: "⭐", title: "星" });
  return list;
});

const lv = computed(() => Number(resolved.value.level || props.level) || 0);
</script>

<template>
  <span class="lv-badges" :class="size" :title="`Lv.${lv}（4星=1月 · 4月=1日 · 4日=1冠）`">
    <span v-for="(ic, i) in icons" :key="i" class="ic" :class="ic.kind" :title="ic.title">{{
      ic.char
    }}</span>
    <span v-if="showLevel && lv" class="lv-num">Lv.{{ lv }}</span>
  </span>
</template>

<style scoped>
.lv-badges {
  display: inline-flex;
  align-items: center;
  gap: 0.08rem;
  line-height: 1;
  vertical-align: middle;
}
.ic {
  font-style: normal;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
}
.lv-badges.md .ic {
  font-size: 0.92rem;
}
.lv-badges.sm .ic {
  font-size: 0.78rem;
}
.lv-num {
  margin-left: 0.25rem;
  font-size: 0.72rem;
  font-weight: 700;
  color: #aeb4ff;
  font-variant-numeric: tabular-nums;
}
.lv-badges.sm .lv-num {
  font-size: 0.65rem;
}
</style>
