use crate::{
    api::{Article, WikiClient},
    manifest::{
        diff_manifest, hash_content, load_manifest, save_manifest, ArticleRecord, Manifest,
    },
    markdown::{
        build_article_file_name, build_image_file_name, collect_image_urls, normalize_markdown,
        relative_markdown_path, rewrite_image_links, rewrite_official_wiki_links,
        sanitize_path_segment,
    },
};
use anyhow::Result;
use futures::{stream::FuturesUnordered, StreamExt};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{fs, sync::Semaphore};

pub const OUTPUT_ROOT: &str = "docs/wiki";
pub const IMAGES_ROOT: &str = "docs/wiki/_assets/images";
pub const MANIFEST_PATH: &str = ".oasis-sync/manifest.json";
pub const INDEX_PATH: &str = "docs/wiki/000_索引.md";
pub const ARTICLE_INDEX_PATH: &str = "docs/wiki/article-index.tsv";

#[derive(Debug, Clone, Default)]
pub struct SyncOptions {
    pub root_dir: PathBuf,
    pub article_concurrency: usize,
    pub image_concurrency: usize,
}
impl SyncOptions {
    pub fn in_dir(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
            article_concurrency: 16,
            image_concurrency: 24,
        }
    }
}
#[derive(Debug, Clone, Default)]
pub struct ProgressEvent {
    pub phase: String,
    pub label: String,
    pub current: usize,
    pub total: usize,
    pub done: bool,
}
#[derive(Debug, Clone, Default)]
pub struct SyncResult {
    pub total_articles: usize,
    pub created_count: usize,
    pub updated_count: usize,
    pub deleted_count: usize,
    pub images_downloaded: usize,
    pub duration_ms: u128,
}
#[derive(Debug, Clone)]
struct PreparedArticle {
    article: Article,
    tree_path: Vec<String>,
    output_path: String,
    linked_body: String,
    image_urls: Vec<String>,
}

#[derive(Debug, Clone)]
struct TreeEntry {
    id: Option<String>,
    label: String,
    article: bool,
    children: Vec<TreeEntry>,
}
fn parse_tree(v: &Value) -> Vec<TreeEntry> {
    v.as_array()
        .map(|a| a.iter().map(parse_node).collect())
        .unwrap_or_default()
}
fn parse_node(v: &Value) -> TreeEntry {
    let article = v.get("type").and_then(Value::as_i64) == Some(1);
    let label = v
        .get("label")
        .or_else(|| v.get("Label"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let id = v.get("id").or_else(|| v.get("Id")).map(|x| {
        x.as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| x.to_string())
    });
    let children = parse_tree(
        v.get("children")
            .or_else(|| v.get("Children"))
            .unwrap_or(&Value::Null),
    );
    TreeEntry {
        id,
        label,
        article,
        children,
    }
}
fn flatten(nodes: &[TreeEntry], ancestry: &[String], out: &mut Vec<(String, String, Vec<String>)>) {
    for n in nodes {
        let mut path = ancestry.to_vec();
        if !n.article {
            if !n.label.is_empty() {
                path.push(n.label.clone());
            }
            flatten(&n.children, &path, out);
        } else if let Some(id) = &n.id {
            out.push((id.clone(), n.label.clone(), path));
        }
    }
}
fn article_path(id: &str, title: &str, tree_path: &[String]) -> String {
    let mut p = PathBuf::from(OUTPUT_ROOT);
    for seg in tree_path {
        p.push(sanitize_path_segment(seg));
    }
    p.push(build_article_file_name(id, title));
    p.to_string_lossy().replace('\\', "/")
}
fn abs(root: &Path, rel: &str) -> PathBuf {
    root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}
async fn write_if_changed(path: &Path, content: &str) -> Result<bool> {
    if let Ok(old) = fs::read_to_string(path).await {
        if old == content {
            return Ok(false);
        }
    }
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).await?;
    }
    fs::write(path, content).await?;
    Ok(true)
}

fn build_index(
    nodes: &[TreeEntry],
    output_paths: &HashMap<String, String>,
    title_by_id: &HashMap<String, String>,
) -> String {
    let mut lines = vec!["# 绿洲启元 Wiki 索引".to_owned(), String::new()];
    fn visit(
        nodes: &[TreeEntry],
        depth: usize,
        lines: &mut Vec<String>,
        paths: &HashMap<String, String>,
        titles: &HashMap<String, String>,
    ) {
        for n in nodes {
            if n.article {
                if let Some(id) = &n.id {
                    if let Some(path) = paths.get(id) {
                        lines.push(format!(
                            "- [{}]({})",
                            titles.get(id).unwrap_or(&n.label),
                            relative_markdown_path(INDEX_PATH, path)
                        ));
                    }
                }
            } else {
                lines.push(format!("{} {}", "#".repeat(depth.min(6)), n.label));
                lines.push(String::new());
                visit(&n.children, depth + 1, lines, paths, titles);
            }
        }
    }
    visit(nodes, 2, &mut lines, output_paths, title_by_id);
    lines.push(String::new());
    lines.join("\n")
}
fn build_tsv(records: &[ArticleRecord]) -> String {
    let mut s = "id\ttitle\twiki_path\turl\tfile\n".to_owned();
    for r in records {
        let tree = r.tree_path.join("/");
        let url = format!("https://developer.gp.qq.com/wikieditor/#/catalog/{}", r.id);
        s.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\n",
            r.id,
            r.title.replace(['\t', '\r', '\n'], " "),
            tree.replace(['\t', '\r', '\n'], " "),
            url,
            r.output_path
        ));
    }
    s
}

pub async fn sync_wiki<C>(
    client: Arc<C>,
    options: SyncOptions,
    on_progress: Option<Arc<dyn Fn(ProgressEvent) + Send + Sync>>,
) -> Result<SyncResult>
where
    C: WikiClient + 'static,
{
    let started = SystemTime::now();
    let root = &options.root_dir;
    let manifest_file = abs(root, MANIFEST_PATH);
    let previous = load_manifest(&manifest_file).await?;
    emit(&on_progress, "category", "获取分类", 0, 1, false);
    let category = client.fetch_category_tree().await?;
    emit(&on_progress, "category", "获取分类", 1, 1, true);
    let nodes = parse_tree(&category.tree);
    let mut leaves = Vec::new();
    flatten(&nodes, &[], &mut leaves);
    let sem = Arc::new(Semaphore::new(options.article_concurrency.max(1)));
    let mut tasks = FuturesUnordered::new();
    for (id, _title, tree) in leaves {
        let c = client.clone();
        let s = sem.clone();
        tasks.push(async move {
            let _permit = s.acquire_owned().await?;
            let a = c.fetch_article(&id).await?;
            let normalized_body = normalize_markdown(&a.body);
            Ok::<_, anyhow::Error>(PreparedArticle {
                article: a,
                tree_path: tree,
                output_path: String::new(),
                linked_body: normalized_body,
                image_urls: Vec::new(),
            })
        });
    }
    let mut prepared = Vec::new();
    let total = tasks.len();
    let mut current = 0;
    while let Some(r) = tasks.next().await {
        prepared.push(r?);
        current += 1;
        emit(
            &on_progress,
            "articles",
            "获取文章",
            current,
            total,
            current == total,
        );
    }
    // 使用文章接口返回的标题生成路径；分类标题可能过期，只作为远端标题缺失时的依据。
    let mut article_paths = HashMap::new();
    for p in &prepared {
        article_paths.insert(
            p.article.id.clone(),
            article_path(&p.article.id, &p.article.title, &p.tree_path),
        );
    }
    for p in &mut prepared {
        p.output_path = article_paths.get(&p.article.id).cloned().unwrap();
        p.linked_body = rewrite_official_wiki_links(&p.linked_body, &p.output_path, &article_paths);
        p.image_urls = collect_image_urls(&p.linked_body);
    }
    prepared.sort_by(|a, b| a.output_path.cmp(&b.output_path));
    let title_by_id: HashMap<_, _> = prepared
        .iter()
        .map(|p| (p.article.id.clone(), p.article.title.clone()))
        .collect();
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for p in &prepared {
        for u in &p.image_urls {
            if seen.insert(u.clone()) {
                unique.push(u.clone());
            }
        }
    }
    emit(
        &on_progress,
        "images",
        "下载图片",
        0,
        unique.len(),
        unique.is_empty(),
    );
    let image_map: HashMap<String, String> = unique
        .iter()
        .map(|u| {
            (
                u.clone(),
                format!("{}/{}", IMAGES_ROOT, build_image_file_name(u)),
            )
        })
        .collect();
    let staging = abs(
        root,
        &format!(
            ".oasis-sync/images-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ),
    );
    fs::create_dir_all(&staging).await?;
    let image_sem = Arc::new(Semaphore::new(options.image_concurrency.max(1)));
    let prev_images = previous.images.clone();
    let mut dl_tasks = FuturesUnordered::new();
    for url in unique.clone() {
        let c = client.clone();
        let s = image_sem.clone();
        let root = root.clone();
        let stage = staging.clone();
        let out = image_map.get(&url).unwrap().clone();
        let old = prev_images.get(&url).cloned();
        dl_tasks.push(async move {
            let _p = s.acquire_owned().await?;
            let target = abs(&root, &out);
            if old.as_deref() == Some(&out) && fs::metadata(&target).await.is_ok() {
                return Ok::<_, anyhow::Error>((url, false));
            }
            let d = c.download_image(&url).await?;
            let file = stage.join(Path::new(&out).file_name().unwrap());
            fs::write(file, d.bytes).await?;
            Ok((url, true))
        });
    }
    let mut image_downloads = 0;
    let mut image_current = 0;
    let mut image_error = None;
    while let Some(r) = dl_tasks.next().await {
        match r {
            Ok((_u, downloaded)) => {
                if downloaded {
                    image_downloads += 1;
                }
            }
            Err(error) => {
                // 继续排空任务，确保所有在途请求结束后再清理 staging 并返回首个错误。
                if image_error.is_none() {
                    image_error = Some(error);
                }
            }
        }
        image_current += 1;
        emit(
            &on_progress,
            "images",
            "下载图片",
            image_current,
            unique.len(),
            image_current == unique.len(),
        );
    }
    if let Some(error) = image_error {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(error);
    }
    // 所有下载成功后再发布 staging，失败时保留上一份图片树。
    // 将整个发布阶段包在统一的错误清理路径中，避免 rename/create_dir 等中途失败
    // 时留下 .oasis-sync/images-* 临时目录。
    let publish_result = async {
        for url in &unique {
            if prev_images
                .get(url)
                .map(|p| p == image_map.get(url).unwrap())
                .unwrap_or(false)
                && fs::metadata(abs(root, image_map.get(url).unwrap()))
                    .await
                    .is_ok()
            {
                continue;
            }
            let src = staging.join(Path::new(image_map.get(url).unwrap()).file_name().unwrap());
            let dst = abs(root, image_map.get(url).unwrap());
            if let Some(p) = dst.parent() {
                fs::create_dir_all(p).await?;
            }
            // staging 与工作区同卷，rename 可直接发布图片，避免再次复制字节；Windows
            // rename 不覆盖目标，所以先删除旧文件，复用中的图片已在上面跳过。
            if fs::metadata(&dst).await.is_ok() {
                fs::remove_file(&dst).await?;
            }
            fs::rename(src, dst).await?;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = publish_result {
        let _ = fs::remove_dir_all(&staging).await;
        return Err(error);
    }
    let _ = fs::remove_dir_all(&staging).await;
    let mut records = Vec::new();
    // 预先建立文章索引，避免 warm 同步对每篇文章执行线性查找。
    let previous_by_id: HashMap<&str, &ArticleRecord> = previous
        .articles
        .iter()
        .map(|article| (article.id.as_str(), article))
        .collect();
    let mut missing_outputs = HashSet::new();
    for article in &prepared {
        if fs::metadata(abs(root, &article.output_path)).await.is_err() {
            missing_outputs.insert(article.output_path.clone());
        }
    }
    for p in &prepared {
        let localized = rewrite_image_links(&p.linked_body, &p.output_path, &image_map);
        // 内容 hash 同时用于 manifest 和未变化文件判断，只计算一次。
        let content_hash = hash_content(&localized);
        records.push(ArticleRecord {
            id: p.article.id.clone(),
            title: p.article.title.clone(),
            tree_path: p.tree_path.clone(),
            output_path: p.output_path.clone(),
            update_time: Some(p.article.update_time),
            content_hash: content_hash.clone(),
            image_urls: p.image_urls.clone(),
        });
        let document = if localized.ends_with('\n') {
            localized.clone()
        } else {
            format!("{localized}\n")
        };
        let manifest_requires_write = previous_by_id
            .get(p.article.id.as_str())
            .map(|article| {
                article.content_hash != content_hash
                    || article.output_path != p.output_path
                    || missing_outputs.contains(&p.output_path)
            })
            .unwrap_or(true);
        // Manifest hash 只能证明远端内容没有变化，不能证明本地文件仍然完整。
        // 对 manifest 命中的文件校验磁盘内容，避免文件被截断或手动修改后永久跳过。
        let should_write = if manifest_requires_write {
            true
        } else {
            match fs::read_to_string(abs(root, &p.output_path)).await {
                Ok(existing) => existing != document,
                Err(_) => true,
            }
        };
        if should_write {
            write_if_changed(&abs(root, &p.output_path), &document).await?;
        }
    }
    let next = Manifest {
        last_synced_at: Some(chrono_now()),
        remote_tree: crate::manifest::RemoteTree {
            version: Some(category.version),
            update_time: Some(category.update_time),
        },
        articles: records.clone(),
        images: image_map.clone(),
        ..Default::default()
    };
    let diff = diff_manifest(&previous, &next);
    let next_paths: HashSet<_> = records.iter().map(|r| r.output_path.clone()).collect();
    for old in &previous.articles {
        if !next_paths.contains(&old.output_path) {
            let old_path = abs(root, &old.output_path);
            let _ = fs::remove_file(&old_path).await;
            let _ = prune_empty_directories(old_path.parent(), &abs(root, OUTPUT_ROOT)).await;
        }
    }
    let next_images: HashSet<_> = image_map.values().collect();
    for old_path in previous.images.values() {
        if !next_images.contains(old_path) {
            let image_path = abs(root, old_path);
            let _ = fs::remove_file(&image_path).await;
            let _ = prune_empty_directories(image_path.parent(), &abs(root, IMAGES_ROOT)).await;
        }
    }
    write_if_changed(
        &abs(root, INDEX_PATH),
        &build_index(&nodes, &article_paths, &title_by_id),
    )
    .await?;
    write_if_changed(&abs(root, ARTICLE_INDEX_PATH), &build_tsv(&records)).await?;
    save_manifest(&manifest_file, &next).await?;
    emit(&on_progress, "finalize", "完成", 1, 1, true);
    let duration = started.elapsed().map(|d| d.as_millis()).unwrap_or_default();
    Ok(SyncResult {
        total_articles: records.len(),
        created_count: diff.created.len(),
        updated_count: diff.updated.len(),
        deleted_count: diff.deleted.len(),
        images_downloaded: image_downloads,
        duration_ms: duration,
    })
}

/// Remove empty parent directories up to (but excluding) `stop_at`.
/// A failed cleanup never invalidates an otherwise successful sync.
async fn prune_empty_directories(directory: Option<&Path>, stop_at: &Path) -> Result<()> {
    let Some(directory) = directory else {
        return Ok(());
    };
    let mut directory = directory.to_path_buf();
    let stop = stop_at.to_path_buf();
    loop {
        if directory == stop || !directory.starts_with(&stop) {
            return Ok(());
        }
        let mut entries = fs::read_dir(&directory).await?;
        if entries.next_entry().await?.is_some() {
            return Ok(());
        }
        fs::remove_dir(&directory).await?;
        let Some(parent) = directory.parent() else {
            return Ok(());
        };
        directory = parent.to_path_buf();
    }
}
fn chrono_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    secs.to_string()
}
fn emit(
    cb: &Option<Arc<dyn Fn(ProgressEvent) + Send + Sync>>,
    phase: &str,
    label: &str,
    current: usize,
    total: usize,
    done: bool,
) {
    if let Some(cb) = cb {
        cb(ProgressEvent {
            phase: phase.into(),
            label: label.into(),
            current,
            total,
            done,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ImageDownload;
    use async_trait::async_trait;
    struct Fixture {
        articles: HashMap<String, Article>,
    }
    #[async_trait]
    impl WikiClient for Fixture {
        async fn fetch_category_tree(&self) -> Result<crate::api::CategoryTree> {
            Ok(crate::api::CategoryTree {
                tree: serde_json::json!([{"label":"分类","type":0,"children":[{"id":1,"label":"文章","type":1}]}]),
                version: 1,
                update_time: 1,
            })
        }
        async fn fetch_article(&self, id: &str) -> Result<Article> {
            Ok(self.articles.get(id).unwrap().clone())
        }
        async fn download_image(&self, _: &str) -> Result<ImageDownload> {
            Ok(ImageDownload {
                bytes: b"x".to_vec(),
                content_type: "image/png".into(),
            })
        }
    }
    #[tokio::test]
    async fn sync_fixture() {
        let td = tempfile::tempdir().unwrap();
        let mut a = HashMap::new();
        a.insert(
            "1".into(),
            Article {
                id: "1".into(),
                title: "文章".into(),
                body: "# hi".into(),
                update_time: 1,
                add_time: 0,
            },
        );
        let r = sync_wiki(
            Arc::new(Fixture { articles: a }),
            SyncOptions::in_dir(td.path()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(r.total_articles, 1);
        assert!(abs(td.path(), "docs/wiki/分类/1_文章.md").exists());
    }

    #[tokio::test]
    async fn publishes_images_by_rename_and_reuses_them() {
        let td = tempfile::tempdir().unwrap();
        let mut a = HashMap::new();
        a.insert(
            "1".into(),
            Article {
                id: "1".into(),
                title: "文章".into(),
                body: "![图片](https://example.com/a.png)".into(),
                update_time: 1,
                add_time: 0,
            },
        );
        let client = Arc::new(Fixture { articles: a });
        let first = sync_wiki(client.clone(), SyncOptions::in_dir(td.path()), None)
            .await
            .unwrap();
        assert_eq!(first.images_downloaded, 1);
        let image_name = build_image_file_name("https://example.com/a.png");
        assert!(abs(td.path(), &format!("{IMAGES_ROOT}/{image_name}")).exists());
        let mut dir = fs::read_dir(abs(td.path(), ".oasis-sync")).await.unwrap();
        let mut staging_entries = Vec::new();
        while let Some(entry) = dir.next_entry().await.unwrap() {
            staging_entries.push(entry.file_name());
        }
        assert_eq!(
            staging_entries.len(),
            1,
            "only manifest remains after publish"
        );
        let second = sync_wiki(client, SyncOptions::in_dir(td.path()), None)
            .await
            .unwrap();
        assert_eq!(second.images_downloaded, 0);
    }

    #[tokio::test]
    async fn cleans_image_staging_when_publish_fails_midway() {
        let td = tempfile::tempdir().unwrap();
        let mut articles = HashMap::new();
        articles.insert(
            "1".into(),
            Article {
                id: "1".into(),
                title: "文章".into(),
                body: "![a](https://example.com/a.png)\n![b](https://example.com/b.png)".into(),
                update_time: 1,
                add_time: 0,
            },
        );
        // 让第二张图片的目标路径成为目录，触发发布阶段的 remove_file 失败；
        // 第一张图片已经发布后仍必须清理 staging 目录。
        let blocked = build_image_file_name("https://example.com/b.png");
        fs::create_dir_all(abs(td.path(), IMAGES_ROOT))
            .await
            .unwrap();
        fs::create_dir(abs(td.path(), &format!("{IMAGES_ROOT}/{blocked}")))
            .await
            .unwrap();

        let result = sync_wiki(
            Arc::new(Fixture { articles }),
            SyncOptions::in_dir(td.path()),
            None,
        )
        .await;
        assert!(result.is_err(), "publish must fail for a directory target");

        let sync_root = abs(td.path(), ".oasis-sync");
        let mut entries = fs::read_dir(&sync_root).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            assert!(
                !entry.file_name().to_string_lossy().starts_with("images-"),
                "failed publish left staging directory: {:?}",
                entry.path()
            );
        }
    }

    #[tokio::test]
    async fn restores_article_files_missing_from_an_unchanged_manifest() {
        let td = tempfile::tempdir().unwrap();
        let mut articles = HashMap::new();
        articles.insert(
            "1".into(),
            Article {
                id: "1".into(),
                title: "文章".into(),
                body: "# hi".into(),
                update_time: 1,
                add_time: 0,
            },
        );
        let client = Arc::new(Fixture { articles });
        sync_wiki(client.clone(), SyncOptions::in_dir(td.path()), None)
            .await
            .unwrap();
        let path = abs(td.path(), "docs/wiki/分类/1_文章.md");
        fs::remove_file(&path).await.unwrap();
        let result = sync_wiki(client, SyncOptions::in_dir(td.path()), None)
            .await
            .unwrap();
        assert_eq!(result.updated_count, 0);
        assert!(path.exists());
    }

    #[tokio::test]
    async fn restores_corrupted_article_files_from_an_unchanged_manifest() {
        let td = tempfile::tempdir().unwrap();
        let mut articles = HashMap::new();
        articles.insert(
            "1".into(),
            Article {
                id: "1".into(),
                title: "文章".into(),
                body: "# expected".into(),
                update_time: 1,
                add_time: 0,
            },
        );
        let client = Arc::new(Fixture { articles });
        sync_wiki(client.clone(), SyncOptions::in_dir(td.path()), None)
            .await
            .unwrap();
        let path = abs(td.path(), "docs/wiki/分类/1_文章.md");
        fs::write(&path, "# corrupted\n").await.unwrap();

        let result = sync_wiki(client, SyncOptions::in_dir(td.path()), None)
            .await
            .unwrap();

        assert_eq!(result.updated_count, 0);
        assert_eq!(fs::read_to_string(path).await.unwrap(), "# expected\n");
    }
}
