import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import { initMedia } from './media.js';
import { restoreAccount } from './account/store.js';
import './store.js'; // 启动时加载播放偏好，并清理旧版本的本机历史与收藏
import './styles.css';

initMedia();
restoreAccount();
createApp(App).use(router).mount('#app');
