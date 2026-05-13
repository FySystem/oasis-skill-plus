export const DEFAULT_BASE_URL = 'https://developer.gp.qq.com/wikieditor';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWikiClient({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
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

        const payload = await response.json();
        if (payload.code !== 0) {
          throw new Error(payload.message || `接口返回异常：${url}`);
        }

        return payload;
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

  async function fetchCategoryTree() {
    const payload = await requestJson(`${baseUrl}/_api/look-Category`);
    const entry = payload.data?.[0];

    if (!entry?.Body) {
      throw new Error('分类接口返回缺少树结构内容');
    }

    return {
      tree: JSON.parse(entry.Body),
      version: Number(entry.Version ?? 0),
      updateTime: Number(entry.UpdateTime ?? 0)
    };
  }

  async function fetchArticle(id) {
    const payload = await requestJson(`${baseUrl}/_api/query-articles?Id=${encodeURIComponent(id)}`);
    const entry = payload.data?.[0];

    if (!entry) {
      throw new Error(`词条 ${id} 未返回数据`);
    }

    return {
      id: String(entry.Id ?? id),
      title: String(entry.Title ?? ''),
      body: String(entry.Body ?? ''),
      updateTime: Number(entry.UpdateTime ?? entry.AddTime ?? 0),
      addTime: Number(entry.AddTime ?? 0)
    };
  }

  async function downloadImage(url) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchImpl(url);
        if (!response.ok) {
          throw new Error(`图片请求失败，状态码 ${response.status}：${url}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return {
          buffer: Buffer.from(arrayBuffer),
          contentType: response.headers.get('content-type') ?? 'application/octet-stream'
        };
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

  return {
    fetchCategoryTree,
    fetchArticle,
    downloadImage
  };
}
