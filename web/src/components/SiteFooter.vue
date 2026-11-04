<script setup>
// 页脚：项目说明与源码链接（AGPL-3.0 要求向网络用户提供源码）
import { SOURCE_URL } from '../base.js';

defineProps({ compact: Boolean });
</script>

<template>
  <footer class="site-footer" :class="{ compact }">
    HongguoWeb · 非官方第三方项目 ·
    <a :href="SOURCE_URL" target="_blank" rel="noopener">源代码</a>（AGPL-3.0）
  </footer>
</template>

<style scoped>
.site-footer { padding: 28px 0 36px; text-align: center; font-size: 12px; color: var(--text-mute); }
.site-footer.compact { padding: 16px 0 4px; text-align: left; }
.site-footer a { color: var(--text-mute); text-decoration: underline; text-underline-offset: 2px; }
.site-footer a:hover { color: var(--text-dim); }
</style>
