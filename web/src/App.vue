<script setup>
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from './api.js';
import { toast, toastMessage } from './toast.js';
import AccountMenu from './components/AccountMenu.vue';
import { account } from './account/store.js';

const route = useRoute();
const router = useRouter();
const keyword = ref('');
const resolving = ref(false);

// 红果登录失效（被动退出）时告知原因
watch(() => account.error, (reason) => { if (reason) toast(reason, 5000); });

watch(() => route.query.q, (q) => { if (route.name === 'search') keyword.value = String(q || ''); }, { immediate: true });

// 首页切换分类、播放页切换分集只更新 query，不重建页面
function viewKey(r) {
  if (r.name === 'home') return 'home';
  if (r.name === 'play') return `play:${r.params.sid}`;
  return r.fullPath;
}

// 分享链接或纯数字 ID 直接跳转播放，其他内容按关键词搜索
const looksLikeShare = (text) => /https?:\/\//i.test(text) || /^\d{15,30}$/.test(text);

async function submit() {
  const text = keyword.value.trim();
  if (!text) return;
  if (looksLikeShare(text)) {
    resolving.value = true;
    try {
      const { series_id } = await api.resolve(text);
      keyword.value = '';
      router.push({ name: 'play', params: { sid: series_id } });
    } catch (error) {
      toast(error.message);
    } finally {
      resolving.value = false;
    }
    return;
  }
  router.push({ name: 'search', query: { q: text } });
}
</script>

<template>
  <header class="header">
    <RouterLink to="/" class="logo">
      <svg viewBox="0 0 64 64" width="26" height="26"><circle cx="32" cy="32" r="30" fill="#ff3b5c" /><path d="M26 20l18 12-18 12z" fill="#fff" /></svg>
      <span>红果短剧</span><em>Web</em>
    </RouterLink>
    <nav class="nav">
      <RouterLink to="/" :class="{ active: route.name === 'home' }">发现</RouterLink>
      <RouterLink to="/actors" :class="{ active: route.name === 'actors' || route.name === 'actor' }">剧星榜</RouterLink>
      <RouterLink to="/library" :class="{ active: route.name === 'library' }">我的</RouterLink>
    </nav>
    <form class="search" @submit.prevent="submit">
      <input v-model="keyword" type="search" placeholder="搜索剧名、演员，或粘贴分享链接" :disabled="resolving" />
      <button type="submit" class="primary" :disabled="resolving">{{ resolving ? '解析中' : '搜索' }}</button>
    </form>
    <AccountMenu />
  </header>
  <main class="main">
    <RouterView v-slot="{ Component, route: r }">
      <KeepAlive include="HomeView">
        <component :is="Component" :key="viewKey(r)" />
      </KeepAlive>
    </RouterView>
  </main>
  <Transition name="fade">
    <div v-if="toastMessage" class="toast">{{ toastMessage }}</div>
  </Transition>
</template>

<style scoped>
.header {
  position: sticky; top: 0; z-index: 50;
  height: var(--header-h);
  display: flex; align-items: center; gap: 20px;
  padding: 0 28px;
  background: rgba(15, 16, 20, .92);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}
.logo { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 700; white-space: nowrap; }
.logo em { font-style: normal; font-size: 11px; font-weight: 600; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; padding: 0 4px; }
.nav { display: flex; gap: 6px; }
.nav a { padding: 6px 12px; border-radius: 8px; color: var(--text-dim); white-space: nowrap; }
.nav a:hover { color: var(--text); background: var(--bg-elev); }
.nav a.active { color: var(--text); font-weight: 600; }
.search { margin-left: auto; display: flex; gap: 8px; width: min(420px, 36vw); }
.search input {
  flex: 1; min-width: 0;
  background: var(--bg-elev); border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 12px; outline: none;
}
.search input:focus { border-color: var(--accent); }
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
