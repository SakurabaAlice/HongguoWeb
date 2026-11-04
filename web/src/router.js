import { createRouter, createWebHistory } from 'vue-router';
import Home from './views/Home.vue';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/search', name: 'search', component: () => import('./views/Search.vue') },
    { path: '/play/:sid', name: 'play', component: () => import('./views/Play.vue') },
    { path: '/library', name: 'library', component: () => import('./views/Library.vue') },
    { path: '/actors', name: 'actors', component: () => import('./views/Actors.vue') },
    { path: '/actor/:id', name: 'actor', component: () => import('./views/Actor.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior(to, from, saved) {
    if (saved) return saved;
    if (to.path !== from.path) return { top: 0 };
  },
});
