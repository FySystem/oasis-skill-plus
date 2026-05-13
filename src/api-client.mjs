export const DEFAULT_API_BASE_URL = 'https://developer.gp.qq.com/api';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApiClient({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_API_BASE_URL,
  retries = 2,
  retryDelayMs = 300
} = {}) {
  async function requestJson(url) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(url);
        if (!response.ok) {
          throw new Error(`请求失败，状态码 ${response.status}：${url}`);
        }

        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt === retries) {
          break;
        }

        await delay(retryDelayMs * (attempt + 1));
      }
    }

    throw lastError;
  }

  async function fetchClassCatalog() {
    return requestJson(`${baseUrl}/class/list/list.json`);
  }

  async function fetchSortedCatalog(family) {
    return requestJson(`${baseUrl}/${family}/list/sorted_list.json`);
  }

  async function fetchDetail(_family, sourcePath) {
    return requestJson(`${baseUrl}/${sourcePath}`);
  }

  return {
    fetchClassCatalog,
    fetchSortedCatalog,
    fetchDetail
  };
}
