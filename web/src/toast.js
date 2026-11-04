import { ref } from 'vue';

export const toastMessage = ref('');
let timer;

export function toast(message, duration = 2600) {
  toastMessage.value = message;
  clearTimeout(timer);
  timer = setTimeout(() => { toastMessage.value = ''; }, duration);
}
