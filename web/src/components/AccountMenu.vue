<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { account, signOut, openLogin } from '../account/store.js';
import LoginDialog from './LoginDialog.vue';

const open = ref(false);
const root = ref(null);

function onOutside(event) {
  if (open.value && root.value && !root.value.contains(event.target)) open.value = false;
}
onMounted(() => document.addEventListener('pointerdown', onOutside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside));

function logout() {
  open.value = false;
  if (confirm('确定退出红果账号吗？')) signOut();
}
</script>

<template>
  <div ref="root" class="account">
    <button v-if="account.status !== 'signed-in'" class="login" @click="openLogin">登录</button>
    <template v-else>
      <button class="me ghost" @click="open = !open">
        <img v-if="account.profile?.avatar" :src="account.profile.avatar" referrerpolicy="no-referrer" alt="" />
        <span v-else class="ph">{{ account.profile?.nickname?.slice(0, 1) }}</span>
        <span class="name">{{ account.profile?.nickname }}</span>
      </button>
      <div v-if="open" class="menu" @click="open = false">
        <div class="who">
          <b>{{ account.profile?.nickname }}</b>
          <small v-if="account.profile?.hongguoId">红果号：{{ account.profile.hongguoId }}</small>
          <small v-else>红果账号已登录</small>
        </div>
        <RouterLink to="/library">观看历史</RouterLink>
        <RouterLink to="/library?tab=favorites">我的收藏</RouterLink>
        <p v-if="account.lastUpload" class="sync" :class="{ err: !account.lastUpload.ok }">
          进度{{ account.lastUpload.ok ? '已同步到账号' : '同步失败' }}：{{ account.lastUpload.message }}
        </p>
        <button class="ghost" @click="logout">退出登录</button>
      </div>
    </template>
    <LoginDialog v-if="account.loginOpen" @close="account.loginOpen = false" />
  </div>
</template>

<style scoped>
.account { position: relative; }
.login { white-space: nowrap; }
.me { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; border-radius: 999px; }
.me img, .ph { width: 30px; height: 30px; border-radius: 50%; object-fit: cover; }
.ph { display: grid; place-items: center; background: var(--accent); color: #fff; font-weight: 600; }
.name { max-width: 8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu {
  position: absolute; right: 0; top: calc(100% + 8px); z-index: 60; width: 240px;
  display: flex; flex-direction: column; padding: 6px;
  background: #1d2027; border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
.who { padding: 8px 10px 10px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.who b { display: block; }
.who small { color: var(--text-mute); }
.menu a, .menu button { padding: 8px 10px; border-radius: 8px; text-align: left; font-size: 14px; }
.menu a:hover { background: var(--bg-hover); }
.sync { margin: 0; padding: 4px 10px 6px; font-size: 12px; color: var(--text-mute); }
.sync.err { color: #ff8a9c; }
</style>
