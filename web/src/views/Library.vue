<script setup>
// 观看历史与收藏，全部来自红果账号
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { account, openLogin, refreshHistory, refreshFavorites, setFavorite } from '../account/store.js';
import { toast } from '../toast.js';
import DramaCard from '../components/DramaCard.vue';

const TABS = [
  { key: 'history', label: '观看历史' },
  { key: 'favorites', label: '我的收藏' },
];

const route = useRoute();
const router = useRouter();
const tab = computed(() => TABS.find((t) => t.key === route.query.tab) || TABS[0]);
const signedIn = computed(() => account.status === 'signed-in');
const isHistory = computed(() => tab.value.key === 'history');

const items = computed(() => (isHistory.value ? account.history : account.favorites));
const loading = computed(() => (isHistory.value ? account.historyLoading : account.favoritesLoading));
const error = computed(() => (isHistory.value ? account.historyError : account.favoritesError));

function refresh() {
  (isHistory.value ? refreshHistory() : refreshFavorites()).catch(() => {});
}
// 进入页签时从红果账号刷新
watch([tab, signedIn], ([, ok]) => { if (ok) refresh(); }, { immediate: true });

async function unfavorite(item) {
  if (!confirm(`取消收藏《${item.series_title}》？`)) return;
  try {
    const { confirmed } = await setFavorite(item.series_id, false);
    toast(confirmed ? '已取消收藏' : '已提交，但回读收藏列表仍包含该剧，请稍后刷新确认');
  } catch (e) {
    toast(`操作失败：${e.message}`);
  }
}
function timeAgo(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts).toLocaleDateString();
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div class="tabs">
        <span
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ active: t.key === tab.key }"
          @click="router.replace({ query: t.key === 'history' ? {} : { tab: t.key } })"
        >{{ t.label }}</span>
      </div>
      <button v-if="signedIn" class="ghost" :disabled="loading" @click="refresh">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>

    <div v-if="!signedIn" class="state">
      观看历史与收藏都保存在你的红果账号中，登录后与手机 App 同步。<br />
      <button class="primary" @click="openLogin">扫码登录</button>
    </div>
    <template v-else>
      <p v-if="isHistory" class="tip">红果账号最近 50 部观看记录，点击即可从上次看到的位置继续播放。</p>
      <div v-if="error" class="state error">{{ error }}<br /><button @click="refresh">重试</button></div>
      <div v-else-if="loading && !items.length" class="state"><div class="spinner" /></div>
      <div v-else-if="!items.length" class="state">{{ isHistory ? '红果账号里还没有观看记录' : '还没有收藏，在播放页点击「收藏」即可加入' }}</div>
      <div v-else class="grid">
        <div v-for="item in items" :key="item.series_id" class="cell">
          <DramaCard
            :item="item"
            :note="isHistory ? `看到第 ${item.ep} 集${item.episode_count ? ` / 共 ${item.episode_count} 集` : ''}` : undefined"
            :progress="isHistory && item.episode_count ? item.ep / item.episode_count : 0"
          >
            <div class="when">{{ timeAgo(item.updated_at || item.added_at) }}</div>
          </DramaCard>
          <button v-if="!isHistory" class="remove" title="取消收藏" @click="unfavorite(item)">✕</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: flex-start; gap: 8px; }
.head .tabs { flex: 1; }
.tip { margin: -4px 0 16px; font-size: 13px; color: var(--text-mute); }
.cell { position: relative; }
.remove {
  position: absolute; right: 6px; top: 6px;
  width: 26px; height: 26px; padding: 0; border-radius: 50%;
  background: rgba(0,0,0,.6); border: none; font-size: 12px;
  opacity: 0; transition: opacity .2s;
}
.cell:hover .remove { opacity: 1; }
.remove:hover { background: var(--accent) !important; }
.when { font-size: 12px; color: var(--text-mute); }
</style>
