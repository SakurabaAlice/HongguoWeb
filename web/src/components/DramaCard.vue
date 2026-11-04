<script setup>
import { computed } from 'vue';

const props = defineProps({
  item: { type: Object, required: true },
  rank: Number,
  /** 封面右下角的覆盖文字，如「看到第 3 集」 */
  note: String,
  /** 0~1，封面底部进度条 */
  progress: Number,
  query: Object,
});

const meta = computed(() => {
  const it = props.item;
  const parts = [];
  if (it.episode_count) parts.push(`${it.episode_count}集`);
  if (it.rec_text) parts.push(it.rec_text);
  else if (Array.isArray(it.tags) && it.tags.length) parts.push(it.tags.slice(0, 2).join(' · '));
  return parts.join(' · ');
});
</script>

<template>
  <RouterLink class="card" :to="{ name: 'play', params: { sid: item.series_id }, query }" :title="item.description || item.series_title">
    <div class="poster">
      <img v-if="item.cover" :src="item.cover" :alt="item.series_title" loading="lazy" referrerpolicy="no-referrer" />
      <span v-if="rank" class="rank" :class="{ top: rank <= 3 }">{{ rank }}</span>
      <span v-if="item.score" class="score">{{ item.score }}分</span>
      <span v-if="note" class="note">{{ note }}</span>
      <div v-if="progress" class="bar"><i :style="{ width: `${Math.min(100, progress * 100)}%` }" /></div>
      <div class="play-icon">▶</div>
    </div>
    <div class="title">{{ item.series_title }}</div>
    <div v-if="meta" class="meta">{{ meta }}</div>
    <slot />
  </RouterLink>
</template>

<style scoped>
.card { display: block; min-width: 0; }
.poster {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg-elev);
}
.poster img { width: 100%; height: 100%; object-fit: cover; transition: transform .3s; }
.card:hover .poster img { transform: scale(1.04); }
.play-icon {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 30px; color: #fff; background: rgba(0, 0, 0, .35);
  opacity: 0; transition: opacity .2s;
}
.card:hover .play-icon { opacity: 1; }
.rank {
  position: absolute; left: 0; top: 0;
  min-width: 28px; padding: 2px 8px;
  font-weight: 700; font-style: italic; text-align: center;
  background: rgba(0, 0, 0, .55); border-bottom-right-radius: 8px;
}
.rank.top { background: linear-gradient(135deg, var(--accent), #ff7a45); }
.score {
  position: absolute; right: 6px; top: 6px;
  padding: 0 6px; border-radius: 4px;
  font-size: 12px; font-weight: 600; color: var(--gold);
  background: rgba(0, 0, 0, .6);
}
.note {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 18px 8px 6px;
  font-size: 12px;
  background: linear-gradient(transparent, rgba(0, 0, 0, .8));
}
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,.2); }
.bar i { display: block; height: 100%; background: var(--accent); }
.title {
  margin-top: 8px;
  font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card:hover .title { color: var(--accent); }
.meta { font-size: 12px; color: var(--text-mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
