<script setup>
// 列表底部：滚动到可见区域时自动加载下一页，并展示加载 / 出错 / 到底状态
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  loading: Boolean,
  error: String,
  hasMore: Boolean,
  empty: Boolean,
  emptyText: { type: String, default: '暂无内容' },
});
const emit = defineEmits(['load']);
const el = ref(null);
let observer;
let visible = false;

onMounted(() => {
  observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) maybeLoad();
  }, { rootMargin: '600px 0px' });
  observer.observe(el.value);
});
onBeforeUnmount(() => observer?.disconnect());

function maybeLoad() {
  if (visible && props.hasMore && !props.loading && !props.error) emit('load');
}
// 加载完一页后若哨兵仍在视口内（内容太少），继续加载
watch(() => props.loading, (now) => { if (!now) requestAnimationFrame(maybeLoad); });
</script>

<template>
  <div ref="el" class="load-more">
    <div v-if="loading" class="spinner" />
    <div v-else-if="error" class="state error">
      {{ error }}<br />
      <button @click="emit('load')">重试</button>
    </div>
    <div v-else-if="empty" class="state">{{ emptyText }}</div>
    <div v-else-if="!hasMore" class="end">— 已经到底了 —</div>
  </div>
</template>

<style scoped>
.load-more { padding: 28px 0; min-height: 40px; }
.end { text-align: center; color: var(--text-mute); font-size: 13px; }
</style>
