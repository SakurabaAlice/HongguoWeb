<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { account } from '../account/store.js';
import { usePaged } from '../usePaged.js';
import DramaCard from '../components/DramaCard.vue';
import LoadMore from '../components/LoadMore.vue';

defineOptions({ name: 'HomeView' });

const TABS = [
  { key: 'hot-drama', label: '热播榜', rank: true },
  { key: 'hot-real-drama', label: '真人热播', rank: true },
  { key: 'hot-comic-drama', label: '漫剧热播', rank: true },
  { key: 'hot-ai-drama', label: 'AI 短剧热播', rank: true },
  { key: 'real-drama', label: '真人短剧' },
  { key: 'comic-drama', label: '漫剧' },
  { key: 'ai-drama', label: 'AI 短剧' },
];

const route = useRoute();
const router = useRouter();
const tab = computed(() => TABS.find((t) => t.key === route.query.tab) || TABS[0]);
const genre = computed(() => (tab.value.rank ? '' : String(route.query.genre || '')));
const genres = ref([]);

const list = usePaged(async (page, signal) => {
  const res = await api.catalog({ category: tab.value.key, genre: genre.value, page }, { signal });
  if (page === 1 && !tab.value.rank && Array.isArray(res.genres) && res.genres.length) genres.value = res.genres;
  return { items: res.results || [], hasMore: res.hasMore };
});

// 继续观看：红果账号最近的观看记录
const continueWatching = computed(() => account.history.slice(0, 6));

let lastKey = '';
watch([() => route.name, tab, genre], ([name]) => {
  if (name !== 'home') return;
  const key = `${tab.value.key}|${genre.value}`;
  if (key === lastKey) return;
  if (lastKey.split('|')[0] !== tab.value.key) genres.value = [];
  lastKey = key;
  list.reset();
  list.loadMore();
}, { immediate: true });

function selectTab(t) {
  router.replace({ query: t.key === TABS[0].key ? {} : { tab: t.key } });
}
function selectGenre(slug) {
  router.replace({ query: { tab: tab.value.key, ...(slug ? { genre: slug } : {}) } });
}
function retry() {
  // 分类游标可能已失效，出错后从第一页重新加载
  if (!list.items.value.length) { list.reset(); }
  list.loadMore();
}
</script>

<template>
  <div class="page">
    <section v-if="continueWatching.length" class="continue">
      <h2 class="section-title">继续观看 <RouterLink to="/library" class="more">全部记录 ›</RouterLink></h2>
      <div class="grid">
        <DramaCard
          v-for="h in continueWatching"
          :key="h.series_id"
          :item="h"
          :note="`看到第 ${h.ep} 集${h.episode_count ? ` / 共 ${h.episode_count} 集` : ''}`"
          :progress="h.episode_count ? h.ep / h.episode_count : 0"
        />
      </div>
    </section>

    <div class="tabs">
      <span v-for="t in TABS" :key="t.key" class="tab" :class="{ active: t.key === tab.key }" @click="selectTab(t)">{{ t.label }}</span>
    </div>
    <div v-if="!tab.rank && genres.length" class="chips">
      <span class="chip" :class="{ active: !genre }" @click="selectGenre('')">全部</span>
      <span v-for="g in genres" :key="g.slug" class="chip" :class="{ active: g.slug === genre }" @click="selectGenre(g.slug)">{{ g.label }}</span>
    </div>

    <div class="grid">
      <DramaCard v-for="(item, i) in list.items.value" :key="item.series_id" :item="item" :rank="tab.rank ? i + 1 : undefined" />
    </div>
    <LoadMore
      :loading="list.loading.value"
      :error="list.error.value"
      :has-more="list.hasMore.value"
      :empty="!list.items.value.length"
      @load="retry"
    />
  </div>
</template>

<style scoped>
.continue { margin-bottom: 36px; }
.continue .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
</style>
