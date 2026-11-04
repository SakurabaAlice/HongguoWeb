// 通用的「逐页加载」列表状态：上游分页依赖游标，必须按顺序一页页请求
import { ref, shallowRef } from 'vue';

/**
 * @param {(page: number, signal: AbortSignal) => Promise<{ items: any[], hasMore: boolean }>} fetchPage
 * @param {(item: any) => string} keyOf 去重用的键
 */
export function usePaged(fetchPage, keyOf = (item) => item.series_id) {
  const items = shallowRef([]);
  const loading = ref(false);
  const error = ref('');
  const hasMore = ref(true);
  let page = 0;
  let seen = new Set();
  let controller = null;

  async function loadMore() {
    if (loading.value || !hasMore.value) return;
    loading.value = true;
    error.value = '';
    const current = controller = new AbortController();
    try {
      const result = await fetchPage(page + 1, current.signal);
      if (current !== controller) return;
      page += 1;
      const fresh = result.items.filter((item) => {
        const key = keyOf(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      items.value = [...items.value, ...fresh];
      // 上游偶尔返回整页重复数据，此时停止以免无限请求
      hasMore.value = Boolean(result.hasMore) && fresh.length > 0;
    } catch (e) {
      if (e.name !== 'AbortError' && current === controller) error.value = e.message || '加载失败';
    } finally {
      if (current === controller) loading.value = false;
    }
  }

  function reset() {
    controller?.abort();
    controller = null;
    items.value = [];
    loading.value = false;
    error.value = '';
    hasMore.value = true;
    page = 0;
    seen = new Set();
  }

  return { items, loading, error, hasMore, loadMore, reset };
}
