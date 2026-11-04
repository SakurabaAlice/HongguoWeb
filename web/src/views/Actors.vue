<script setup>
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { usePaged } from '../usePaged.js';
import LoadMore from '../components/LoadMore.vue';

const GENDERS = [['all', '全部'], ['male', '男演员'], ['female', '女演员']];
const route = useRoute();
const router = useRouter();
const gender = computed(() => (['male', 'female'].includes(route.query.gender) ? route.query.gender : 'all'));
const rankDate = ref('');

const list = usePaged(async (page, signal) => {
  const res = await api.actorRanking({ page, gender: gender.value }, { signal });
  if (res.rankDate) rankDate.value = res.rankDate;
  return { items: res.actors || [], hasMore: res.hasMore };
}, (actor) => actor.actor_id);

watch(gender, () => { list.reset(); list.loadMore(); }, { immediate: true });
document.title = '剧星榜 · 红果短剧';

function trend(change) {
  if (!change?.num) return '';
  return change.type === 1 ? `↑${change.num}` : change.type === 2 ? `↓${change.num}` : '';
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">剧星榜 <small v-if="rankDate">{{ rankDate }}</small></h1>
    <div class="tabs">
      <span
        v-for="[value, label] in GENDERS"
        :key="value"
        class="tab"
        :class="{ active: value === gender }"
        @click="router.replace({ query: value === 'all' ? {} : { gender: value } })"
      >{{ label }}</span>
    </div>

    <div class="actors">
      <RouterLink v-for="(a, i) in list.items.value" :key="a.actor_id" :to="`/actor/${a.actor_id}`" class="actor">
        <span class="rank" :class="{ top: (a.rank || i + 1) <= 3 }">{{ a.rank || i + 1 }}</span>
        <img v-if="a.avatar" :src="a.avatar" referrerpolicy="no-referrer" alt="" loading="lazy" />
        <div class="body">
          <div class="name">
            {{ a.name }}
            <span v-if="trend(a.rank_change)" class="trend" :class="a.rank_change.type === 1 ? 'up' : 'down'">{{ trend(a.rank_change) }}</span>
          </div>
          <div class="score">{{ a.score }}<template v-for="s in a.sub_titles" :key="s"> · {{ s }}</template></div>
          <div class="works">{{ a.intro }}</div>
        </div>
      </RouterLink>
    </div>
    <LoadMore
      :loading="list.loading.value"
      :error="list.error.value"
      :has-more="list.hasMore.value"
      :empty="!list.items.value.length"
      @load="list.loadMore"
    />
  </div>
</template>

<style scoped>
.page-title small { font-size: 13px; font-weight: 400; color: var(--text-mute); margin-left: 8px; }
.actors { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
.actor {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 16px; border-radius: var(--radius);
  background: var(--bg-elev); border: 1px solid transparent;
}
.actor:hover { border-color: var(--line); background: var(--bg-hover); }
.rank { width: 28px; text-align: center; font-size: 18px; font-weight: 700; font-style: italic; color: var(--text-mute); flex: none; }
.rank.top { color: var(--accent); }
.actor img { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; flex: none; }
.body { min-width: 0; }
.name { font-size: 16px; font-weight: 600; }
.trend { font-size: 12px; font-weight: 400; margin-left: 4px; }
.trend.up { color: #ff6b6b; }
.trend.down { color: #4cc38a; }
.score { font-size: 12px; color: var(--gold); }
.works { font-size: 12px; color: var(--text-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
