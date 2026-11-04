<script setup>
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { usePaged } from '../usePaged.js';
import DramaCard from '../components/DramaCard.vue';
import LoadMore from '../components/LoadMore.vue';

const route = useRoute();
const keyword = computed(() => String(route.query.q || '').trim());

const list = usePaged(async (page, signal) => {
  const res = await api.search(keyword.value, page, { signal });
  if (res.error && !res.results?.length) throw new Error(res.error);
  return { items: res.results || [], hasMore: res.hasMore };
});

watch(keyword, (q) => {
  document.title = q ? `搜索：${q} · 红果短剧` : '红果短剧 · 网页版';
  list.reset();
  if (q) list.loadMore();
}, { immediate: true });
</script>

<template>
  <div class="page">
    <h1 class="page-title">「{{ keyword }}」的搜索结果</h1>
    <div class="grid">
      <DramaCard v-for="item in list.items.value" :key="item.series_id" :item="item" />
    </div>
    <LoadMore
      :loading="list.loading.value"
      :error="list.error.value"
      :has-more="list.hasMore.value && !!keyword"
      :empty="!list.items.value.length"
      empty-text="没有找到相关短剧，换个关键词试试"
      @load="list.loadMore"
    />
  </div>
</template>
