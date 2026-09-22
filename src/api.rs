use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio::time::sleep;

pub const DEFAULT_WIKI_BASE_URL: &str = "https://developer.gp.qq.com/wikieditor";
pub const DEFAULT_API_BASE_URL: &str = "https://developer.gp.qq.com/api";

#[derive(Clone)]
pub struct HttpJsonClient {
    pub client: Client,
    pub base_url: String,
    pub retries: usize,
    pub retry_delay: Duration,
}
impl HttpJsonClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            retries: 2,
            retry_delay: Duration::from_millis(300),
        }
    }
    pub fn with_client(base_url: impl Into<String>, client: Client) -> Self {
        Self {
            client,
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            retries: 2,
            retry_delay: Duration::from_millis(300),
        }
    }
    async fn get_json<T: DeserializeOwned>(&self, url: &str) -> Result<T> {
        let mut last = None;
        for attempt in 0..=self.retries {
            match self.client.get(url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.json::<T>().await {
                    Ok(v) => return Ok(v),
                    Err(e) => last = Some(anyhow!(e)),
                },
                Ok(resp) => {
                    last = Some(anyhow!("request failed, status {}: {}", resp.status(), url))
                }
                Err(e) => last = Some(anyhow!(e)),
            }
            if attempt < self.retries {
                sleep(self.retry_delay.mul_f64((attempt + 1) as f64)).await;
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("request failed: {url}")))
    }
}

#[async_trait]
pub trait WikiClient: Send + Sync {
    async fn fetch_category_tree(&self) -> Result<CategoryTree>;
    async fn fetch_article(&self, id: &str) -> Result<Article>;
    async fn download_image(&self, url: &str) -> Result<ImageDownload>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryTree {
    pub tree: Value,
    pub version: i64,
    #[serde(rename = "updateTime")]
    pub update_time: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Article {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(rename = "updateTime")]
    pub update_time: i64,
    #[serde(rename = "addTime", default)]
    pub add_time: i64,
}
#[derive(Debug, Clone)]
pub struct ImageDownload {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

#[derive(Clone)]
pub struct WikiHttpClient {
    pub inner: HttpJsonClient,
}
impl WikiHttpClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            inner: HttpJsonClient::new(base_url),
        }
    }
}
#[derive(Debug, Deserialize)]
struct WikiEnvelope {
    code: i64,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Vec<Value>,
}
#[async_trait]
impl WikiClient for WikiHttpClient {
    async fn fetch_category_tree(&self) -> Result<CategoryTree> {
        let url = format!("{}/_api/look-Category", self.inner.base_url);
        let p: WikiEnvelope = self.inner.get_json(&url).await?;
        if p.code != 0 {
            return Err(anyhow!(p
                .message
                .unwrap_or_else(|| format!("wiki API error: {url}"))));
        }
        let e = p.data.first().context("分类接口返回缺少数据")?;
        let body = e
            .get("Body")
            .and_then(Value::as_str)
            .context("分类接口返回缺少树结构内容")?;
        Ok(CategoryTree {
            tree: serde_json::from_str(body).context("分类树 JSON 无效")?,
            version: value_i64(e, "Version"),
            update_time: value_i64(e, "UpdateTime"),
        })
    }
    async fn fetch_article(&self, id: &str) -> Result<Article> {
        let url = format!(
            "{}/_api/query-articles?Id={}",
            self.inner.base_url,
            urlencoding::encode(id)
        );
        let p: WikiEnvelope = self.inner.get_json(&url).await?;
        if p.code != 0 {
            return Err(anyhow!(p
                .message
                .unwrap_or_else(|| format!("wiki API error: {url}"))));
        }
        let e = p.data.first().context(format!("词条 {id} 未返回数据"))?;
        Ok(Article {
            id: e.get("Id").and_then(Value::as_str).unwrap_or(id).to_owned(),
            title: value_string(e, "Title"),
            body: value_string(e, "Body"),
            update_time: value_i64(e, "UpdateTime").max(value_i64(e, "AddTime")),
            add_time: value_i64(e, "AddTime"),
        })
    }
    async fn download_image(&self, url: &str) -> Result<ImageDownload> {
        let mut last = None;
        for attempt in 0..=self.inner.retries {
            match self.inner.client.get(url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let ct = resp
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("application/octet-stream")
                        .to_owned();
                    match resp.bytes().await {
                        Ok(b) => {
                            return Ok(ImageDownload {
                                bytes: b.to_vec(),
                                content_type: ct,
                            })
                        }
                        Err(e) => last = Some(anyhow!(e)),
                    }
                }
                Ok(resp) => last = Some(anyhow!("图片请求失败，状态码 {}：{}", resp.status(), url)),
                Err(e) => last = Some(anyhow!(e)),
            }
            if attempt < self.inner.retries {
                sleep(self.inner.retry_delay.mul_f64((attempt + 1) as f64)).await;
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("image request failed: {url}")))
    }
}

fn value_string(v: &Value, key: &str) -> String {
    v.get(key)
        .map(|x| {
            x.as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| x.to_string())
        })
        .unwrap_or_default()
}
fn value_i64(v: &Value, key: &str) -> i64 {
    v.get(key)
        .and_then(|x| x.as_i64().or_else(|| x.as_str()?.parse().ok()))
        .unwrap_or(0)
}

#[async_trait]
pub trait ApiClient: Send + Sync {
    async fn fetch_class_catalog(&self) -> Result<Value>;
    async fn fetch_sorted_catalog(&self, family: &str) -> Result<Value>;
    async fn fetch_detail(&self, family: &str, source_path: &str) -> Result<Value>;
}
#[derive(Clone)]
pub struct ApiHttpClient {
    pub inner: HttpJsonClient,
}
impl ApiHttpClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            inner: HttpJsonClient::new(base_url),
        }
    }
}
#[async_trait]
impl ApiClient for ApiHttpClient {
    async fn fetch_class_catalog(&self) -> Result<Value> {
        self.inner
            .get_json(&format!("{}/class/list/list.json", self.inner.base_url))
            .await
    }
    async fn fetch_sorted_catalog(&self, family: &str) -> Result<Value> {
        self.inner
            .get_json(&format!(
                "{}/{}/list/sorted_list.json",
                self.inner.base_url, family
            ))
            .await
    }
    async fn fetch_detail(&self, _family: &str, source_path: &str) -> Result<Value> {
        self.inner
            .get_json(&format!(
                "{}/{}",
                self.inner.base_url,
                source_path.trim_start_matches('/')
            ))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn values() {
        let v = serde_json::json!({"Id":4,"UpdateTime":"2"});
        assert_eq!(value_i64(&v, "Id"), 4);
        assert_eq!(value_i64(&v, "UpdateTime"), 2);
    }
}
