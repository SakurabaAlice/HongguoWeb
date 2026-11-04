<script setup>
import { ref, shallowRef } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { usePaged } from '../usePaged.js';
import DramaCard from '../components/DramaCard.vue';
import LoadMore from '../components/LoadMore.vue';

const PAGE_SIZE = 20;
const route = useRoute();
const id = String(route.params.id);
const actor = shallowRef(null);
const error = ref('');

async function loadActor() {
  error.value = '';
  try {
    actor.value = (await api.actor(id)).actor;
    document.title = `${actor.value?.name || '演员'} · 红果短剧`;
  } catch (e) {
    error.value = e.message;
  }
}

const works = usePaged(async (page, signal) => {
  const res = await api.actorWorks(id, { offset: (page - 1) * PAGE_SIZE, count: PAGE_SIZE }, { signal });
  return { items: res.works || [], hasMore: res.has_more };
});

loadActor();
works.loadMore();
</script>

<template>
  <div class="page">
    <div v-if="error" class="state error">{{ error }}<br /><button @click="loadActor">重试</button></div>
    <section v-else-if="actor" class="profile">
      <img v-if="actor.avatar" :src="actor.avatar" referrerpolicy="no-referrer" alt="" />
      <div>
        <h1>{{ actor.name }}</h1>
        <p>{{ actor.intro }}</p>
      </div>
    </section>
    <div v-else class="state"><div class="spinner" /></div>

    <section v-if="actor?.related_celebrities?.length" class="related">
      <h2 class="section-title">合作演员</h2>
      <div class="related-list">
        <RouterLink v-for="c in actor.related_celebrities" :key="c.actor_id" :to="`/actor/${c.actor_id}`" class="mate" :title="c.intro">
          <img v-if="c.avatar" :src="c.avatar" referrerpolicy="no-referrer" alt="" />
          <span>{{ c.name }}</span>
        </RouterLink>
      </div>
    </section>

    <h2 class="section-title">参演作品</h2>
    <div class="grid">
      <DramaCard v-for="w in works.items.value" :key="w.series_id" :item="w" />
    </div>
    <LoadMore
      :loading="works.loading.value"
      :error="works.error.value"
      :has-more="works.hasMore.value"
      :empty="!works.items.value.length"
      @load="works.loadMore"
    />
  </div>
</template>

<style scoped>
.profile { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 28px; }
.profile img { width: 120px; height: 120px; border-radius: 50%; object-fit: cover; flex: none; }
.profile h1 { margin: 6px 0 8px; font-size: 24px; }
.profile p { margin: 0; color: var(--text-dim); max-width: 860px; }
.related { margin-bottom: 28px; }
.related-list { display: flex; gap: 18px; overflow-x: auto; padding-bottom: 6px; }
.mate { flex: none; width: 72px; text-align: center; font-size: 13px; }
.mate img { width: 60px; height: 60px; margin: 0 auto 6px; border-radius: 50%; object-fit: cover; }
.mate:hover span { color: var(--accent); }
</style>
