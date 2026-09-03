<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

/**
 * @typedef {{ key: string, alias: string, label: string }} BloggerOption
 */

const props = defineProps({
  modelValue: { type: String, default: "" },
  /** @type {import("vue").PropType<BloggerOption[]>} */
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: "thankUcrypto|熬鹰" },
  /** blur / 选中时写入历史（筛选用 false） */
  rememberOnCommit: { type: Boolean, default: true },
  /** 表格单元格 data 属性 */
  draftLid: { type: String, default: "" },
  field: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "remember", "keydown"]);

const rootRef = ref(/** @type {HTMLElement | null} */ (null));
const inputRef = ref(/** @type {HTMLInputElement | null} */ (null));
const open = ref(false);
const query = ref(props.modelValue);
const highlight = ref(0);
/** @type {import("vue").Ref<{ top: number, left: number, width: number } | null>} */
const menuPos = ref(null);

watch(
  () => props.modelValue,
  (v) => {
    if (!open.value) query.value = String(v ?? "");
  }
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = /** @type {BloggerOption[]} */ (props.options ?? []);
  if (!q) return list.slice(0, 24);
  return list
    .filter(
      (b) =>
        b.key.toLowerCase().includes(q) ||
        b.alias.toLowerCase().includes(q) ||
        b.label.toLowerCase().includes(q)
    )
    .slice(0, 24);
});

const showMenu = computed(() => open.value && filtered.value.length > 0);

function updateMenuPos() {
  const el = inputRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  menuPos.value = {
    top: r.bottom + 4,
    left: r.left,
    width: Math.max(r.width, 220),
  };
}

async function openMenu() {
  open.value = true;
  highlight.value = 0;
  await nextTick();
  updateMenuPos();
}

function closeMenu() {
  open.value = false;
  menuPos.value = null;
}

/** @param {BloggerOption} b */
function selectOption(b) {
  query.value = b.label;
  emit("update:modelValue", b.label);
  if (props.rememberOnCommit) emit("remember", b.label);
  closeMenu();
  inputRef.value?.blur();
}

function commitInput() {
  const v = query.value.trim();
  emit("update:modelValue", v);
  if (v && props.rememberOnCommit) emit("remember", v);
  closeMenu();
}

function onInput() {
  emit("update:modelValue", query.value);
  void openMenu();
}

function onFocus() {
  void openMenu();
}

function onBlur() {
  window.setTimeout(() => {
    commitInput();
  }, 120);
}

/** @param {MouseEvent} e */
function onToggleClick(e) {
  e.preventDefault();
  e.stopPropagation();
  if (open.value) {
    closeMenu();
    return;
  }
  inputRef.value?.focus();
  void openMenu();
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (showMenu.value) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight.value = Math.min(highlight.value + 1, filtered.value.length - 1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight.value = Math.max(highlight.value - 1, 0);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const b = filtered.value[highlight.value];
      if (b) selectOption(b);
      else commitInput();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      return;
    }
  }
  emit("keydown", e);
}

function onScrollOrResize() {
  if (open.value) updateMenuPos();
}

onBeforeUnmount(() => {
  window.removeEventListener("scroll", onScrollOrResize, true);
  window.removeEventListener("resize", onScrollOrResize);
});

watch(open, (isOpen) => {
  if (isOpen) {
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    updateMenuPos();
  } else {
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  }
});
</script>

<template>
  <div ref="rootRef" class="blogger-combobox">
    <input
      ref="inputRef"
      v-model="query"
      type="text"
      class="field-input blogger-combobox-input"
      :placeholder="placeholder"
      :data-draft-lid="draftLid || undefined"
      :data-field="field || undefined"
      autocomplete="off"
      spellcheck="false"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="showMenu"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <button
      type="button"
      class="blogger-combobox-toggle"
      tabindex="-1"
      aria-label="展开博主列表"
      @mousedown.prevent
      @click="onToggleClick"
    >
      ▾
    </button>
    <Teleport to="body">
      <ul
        v-if="showMenu && menuPos"
        class="blogger-combobox-menu"
        role="listbox"
        :style="{
          top: `${menuPos.top}px`,
          left: `${menuPos.left}px`,
          width: `${menuPos.width}px`,
        }"
        @mousedown.prevent
      >
        <li
          v-for="(b, i) in filtered"
          :key="b.key"
          role="option"
          :class="{ active: i === highlight }"
          :aria-selected="i === highlight"
          @mouseenter="highlight = i"
          @click="selectOption(b)"
        >
          <span class="alias">{{ b.alias }}</span>
          <span v-if="b.alias !== b.key" class="key">{{ b.key }}</span>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.blogger-combobox {
  position: relative;
  width: 100%;
}
.blogger-combobox-input {
  width: 100%;
  padding-right: 1.85rem;
}
.blogger-combobox-toggle {
  position: absolute;
  top: 50%;
  right: 0.2rem;
  transform: translateY(-50%);
  width: 1.55rem;
  height: 1.55rem;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #949ba4;
  cursor: pointer;
  font-size: 0.72rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease, color 0.12s ease;
}
.blogger-combobox-toggle:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #dbdee1;
}
</style>

<style>
.blogger-combobox-menu {
  position: fixed;
  z-index: 9999;
  margin: 0;
  padding: 0.35rem;
  list-style: none;
  max-height: 16rem;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid #404249;
  background: #1a1b1f;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.blogger-combobox-menu li {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  padding: 0.45rem 0.55rem;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.84rem;
  color: #dbdee1;
}
.blogger-combobox-menu li:hover,
.blogger-combobox-menu li.active {
  background: rgba(88, 101, 242, 0.18);
  color: #fff;
}
.blogger-combobox-menu .alias {
  font-weight: 600;
  color: inherit;
}
.blogger-combobox-menu .key {
  font-size: 0.75rem;
  color: #949ba4;
}
.blogger-combobox-menu li:hover .key,
.blogger-combobox-menu li.active .key {
  color: #b5bac1;
}
</style>
