//! Synchronisation of the four developer API families.
//!
//! Catalogs are fetched concurrently, all details are fetched with a bounded
//! worker pool, and files are only published after the complete detail phase
//! succeeds. A failed request therefore leaves the previous API tree intact.

use crate::{
    api::ApiClient,
    api_markdown::{render_api_markdown, ApiMarkdownContext},
    index::{render_api_symbol_index, ApiSymbolIndexRow},
    manifest::{hash_content, SCHEMA_VERSION},
    markdown::{relative_markdown_path, sanitize_path_segment},
};
use anyhow::{Context, Result};
use futures::{stream::FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{fs, sync::Semaphore};

pub const API_OUTPUT_ROOT: &str = "docs/api";
pub const API_MANIFEST_PATH: &str = ".oasis-sync/api-manifest.json";
pub const API_SYMBOL_INDEX_PATH: &str = "docs/api/symbol-index.tsv";
pub const API_FAMILIES: [&str; 4] = ["class", "cppenum", "cppstruct", "globalfunc"];

/// A single API detail document. `description` is kept in memory for the
/// symbol index and omitted from the persisted manifest, matching JavaScript.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiEntity {
    pub family: String,
    pub name: String,
    #[serde(rename = "sourcePath", alias = "source_path")]
    pub source_path: String,
    #[serde(rename = "outputPath", alias = "output_path")]
    pub output_path: String,
    #[serde(rename = "bucketPath", alias = "bucket_path", default)]
    pub bucket_path: Vec<String>,
    #[serde(default, skip_serializing)]
    pub description: String,
    #[serde(rename = "contentHash", alias = "content_hash", default)]
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FamilySummary {
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiManifest {
    #[serde(
        rename = "schemaVersion",
        alias = "schema_version",
        default = "api_schema_version"
    )]
    pub schema_version: u32,
    #[serde(rename = "lastSyncedAt", default)]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub families: HashMap<String, FamilySummary>,
    #[serde(default)]
    pub entities: Vec<ApiEntity>,
}

fn api_schema_version() -> u32 {
    SCHEMA_VERSION
}

impl Default for ApiManifest {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            last_synced_at: None,
            families: HashMap::new(),
            entities: Vec::new(),
        }
    }
}

pub fn create_empty_api_manifest() -> ApiManifest {
    ApiManifest::default()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiManifestDiff {
    pub created: Vec<ApiEntity>,
    pub updated: Vec<ApiEntity>,
    pub deleted: Vec<ApiEntity>,
}

fn equivalent(previous: &ApiEntity, next: &ApiEntity) -> bool {
    previous.family == next.family
        && previous.name == next.name
        && previous.output_path == next.output_path
        && previous.content_hash == next.content_hash
}

/// Compare manifests by source JSON path, matching the original synchronizer.
pub fn diff_api_manifest(previous: &ApiManifest, next: &ApiManifest) -> ApiManifestDiff {
    let old: HashMap<&str, &ApiEntity> = previous
        .entities
        .iter()
        .map(|e| (e.source_path.as_str(), e))
        .collect();
    let current: HashMap<&str, &ApiEntity> = next
        .entities
        .iter()
        .map(|e| (e.source_path.as_str(), e))
        .collect();
    let mut diff = ApiManifestDiff::default();
    for entity in &next.entities {
        match old.get(entity.source_path.as_str()) {
            None => diff.created.push(entity.clone()),
            Some(previous) if !equivalent(previous, entity) => diff.updated.push(entity.clone()),
            _ => {}
        }
    }
    for entity in &previous.entities {
        if !current.contains_key(entity.source_path.as_str()) {
            diff.deleted.push(entity.clone());
        }
    }
    diff
}

pub async fn load_api_manifest(path: impl AsRef<Path>) -> Result<ApiManifest> {
    match fs::read_to_string(path).await {
        Ok(raw) => Ok(serde_json::from_str(&raw).context("invalid API manifest JSON")?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ApiManifest::default()),
        Err(error) => Err(error.into()),
    }
}

pub async fn save_api_manifest(path: impl AsRef<Path>, manifest: &ApiManifest) -> Result<()> {
    if let Some(parent) = path.as_ref().parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut text = serde_json::to_string_pretty(manifest)?;
    text.push('\n');
    fs::write(path, text).await?;
    Ok(())
}

pub fn normalize_api_source_path(family: &str, source_path: &str) -> String {
    let normalized = source_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_owned();
    if normalized.starts_with(&format!("{family}/detail/")) {
        normalized
    } else if family == "class" && normalized.starts_with("detail/class/") {
        format!("class/detail/{}", &normalized["detail/class/".len()..])
    } else {
        normalized
    }
}

pub fn build_api_output_path(family: &str, source_path: &str, bucket_path: &[String]) -> String {
    if family == "class" {
        let normalized = normalize_api_source_path(family, source_path);
        let relative = normalized
            .strip_prefix("class/detail/")
            .unwrap_or(normalized.as_str());
        let without_extension = relative.strip_suffix(".json").unwrap_or(relative);
        let mut segments: Vec<String> = without_extension
            .split('/')
            .map(sanitize_path_segment)
            .collect();
        let file = segments.pop().unwrap_or_else(|| "未命名".to_owned());
        let mut path = vec![API_OUTPUT_ROOT.to_owned(), family.to_owned()];
        path.extend(segments);
        path.push(format!("{file}.md"));
        return path.join("/");
    }

    let source_name = source_path
        .rsplit('/')
        .next()
        .unwrap_or(source_path)
        .strip_suffix(".json")
        .unwrap_or_else(|| source_path.rsplit('/').next().unwrap_or(source_path));
    let mut path = vec![API_OUTPUT_ROOT.to_owned(), family.to_owned()];
    path.extend(bucket_path.iter().map(sanitize_path_segment));
    path.push(format!("{}.md", sanitize_path_segment(source_name)));
    path.join("/")
}

#[derive(Debug, Clone)]
struct IndexNode {
    label: String,
    entity: bool,
    output_path: String,
    children: Vec<IndexNode>,
}

fn string_value(value: Option<&Value>) -> String {
    value
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_default()
}

fn flatten_class(
    nodes: &Value,
    ancestry: &[String],
    records: &mut Vec<ApiEntity>,
    index_nodes: &mut Vec<IndexNode>,
) {
    let Some(nodes) = nodes.as_array() else {
        return;
    };
    for node in nodes {
        let typ = string_value(node.get("Type"));
        let label = string_value(node.get("Label").or_else(|| node.get("Name")));
        if typ == "class" {
            let name = string_value(node.get("Name")).if_empty_then(&label);
            let source_path = normalize_api_source_path("class", &string_value(node.get("Path")));
            let output_path = build_api_output_path("class", &source_path, &[]);
            records.push(ApiEntity {
                family: "class".to_owned(),
                name: name.clone(),
                source_path,
                output_path: output_path.clone(),
                bucket_path: ancestry.to_vec(),
                ..Default::default()
            });
            index_nodes.push(IndexNode {
                label,
                entity: true,
                output_path,
                children: Vec::new(),
            });
        } else {
            let mut next_ancestry = ancestry.to_vec();
            if !label.is_empty() {
                next_ancestry.push(label.clone());
            }
            let mut children = Vec::new();
            flatten_class(
                node.get("Children").unwrap_or(&Value::Null),
                &next_ancestry,
                records,
                &mut children,
            );
            index_nodes.push(IndexNode {
                label,
                entity: false,
                output_path: String::new(),
                children,
            });
        }
    }
}

fn flatten_sorted(
    family: &str,
    tree: &Value,
    bucket_path: &[String],
    records: &mut Vec<ApiEntity>,
    index_nodes: &mut Vec<IndexNode>,
) {
    let Some(tree) = tree.as_object() else { return };
    for (name, value) in tree {
        if let Some(source) = value.as_str() {
            let source_path = normalize_api_source_path(family, source);
            let output_path = build_api_output_path(family, &source_path, bucket_path);
            records.push(ApiEntity {
                family: family.to_owned(),
                name: name.clone(),
                source_path,
                output_path: output_path.clone(),
                bucket_path: bucket_path.to_vec(),
                ..Default::default()
            });
            index_nodes.push(IndexNode {
                label: name.clone(),
                entity: true,
                output_path,
                children: Vec::new(),
            });
        } else {
            let mut next_bucket = bucket_path.to_vec();
            next_bucket.push(name.clone());
            let mut children = Vec::new();
            flatten_sorted(family, value, &next_bucket, records, &mut children);
            index_nodes.push(IndexNode {
                label: name.clone(),
                entity: false,
                output_path: String::new(),
                children,
            });
        }
    }
}

fn build_tree_index(title: &str, index_path: &str, nodes: &[IndexNode]) -> String {
    let mut lines = vec![format!("# {title}"), String::new()];
    fn visit(lines: &mut Vec<String>, index_path: &str, nodes: &[IndexNode], depth: usize) {
        for node in nodes {
            if node.entity {
                lines.push(format!(
                    "- [{}]({})",
                    node.label,
                    relative_markdown_path(index_path, &node.output_path)
                ));
            } else {
                lines.push(format!("{} {}", "#".repeat(depth.min(6)), node.label));
                lines.push(String::new());
                visit(lines, index_path, &node.children, depth + 1);
            }
        }
    }
    visit(&mut lines, index_path, nodes, 2);
    lines.push(String::new());
    lines.join("\n")
}

fn build_root_index(summaries: &HashMap<String, FamilySummary>) -> String {
    let mut lines = vec!["# 绿洲开发者 API 索引".to_owned(), String::new()];
    for family in API_FAMILIES {
        let count = summaries
            .get(family)
            .map(|summary| summary.count)
            .unwrap_or(0);
        lines.extend([
            format!("## {family}"),
            String::new(),
            format!("- [{family} 索引](./{family}/000_索引.md)"),
            format!("- Entities: {count}"),
            String::new(),
        ]);
    }
    lines.join("\n")
}

fn symbol_index(entities: &[ApiEntity]) -> String {
    let rows = entities
        .iter()
        .map(|entity| {
            let mut symbol_path = entity.bucket_path.join(" / ");
            if !symbol_path.is_empty() {
                symbol_path.push_str(" / ");
            }
            symbol_path.push_str(&entity.name);
            ApiSymbolIndexRow {
                kind: entity.family.clone(),
                name: entity.name.clone(),
                symbol_path,
                source_json_path: entity.source_path.clone(),
                source_json_url: format!("https://developer.gp.qq.com/api/{}", entity.source_path),
                markdown_file: entity.output_path.clone(),
                description: entity.description.clone(),
            }
        })
        .collect::<Vec<_>>();
    render_api_symbol_index(&rows)
}

#[derive(Debug, Clone, Default)]
pub struct ApiSyncOptions {
    pub root_dir: PathBuf,
    pub detail_concurrency: usize,
}

impl ApiSyncOptions {
    pub fn in_dir(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
            detail_concurrency: get_default_api_detail_concurrency(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiSyncResult {
    pub total_entities: usize,
    pub created_count: usize,
    pub updated_count: usize,
    pub deleted_count: usize,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Default)]
pub struct ApiProgress {
    pub phase: String,
    pub label: String,
    pub current: usize,
    pub total: usize,
    pub done: bool,
}

pub fn get_default_api_detail_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().saturating_mul(4))
        .unwrap_or(16)
        .clamp(16, 96)
}

fn emit(
    callback: &Option<Arc<dyn Fn(ApiProgress) + Send + Sync>>,
    phase: &str,
    current: usize,
    total: usize,
    done: bool,
) {
    if let Some(callback) = callback {
        callback(ApiProgress {
            phase: phase.to_owned(),
            label: match phase {
                "catalogs" => "正在加载 API 目录".to_owned(),
                "details" => "正在抓取 API 详情".to_owned(),
                _ => "正在写入本地文件".to_owned(),
            },
            current,
            total,
            done,
        });
    }
}

async fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    if fs::read_to_string(path).await.ok().as_deref() == Some(content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(path, content).await?;
    Ok(())
}

fn absolute_path(root: &Path, relative: &str) -> PathBuf {
    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
}

async fn remove_stale(root: &Path, relative: &str) -> Result<()> {
    let root = fs::canonicalize(root).await?;
    let target = absolute_path(&root, relative);
    if target != root && target.strip_prefix(&root).is_err() {
        anyhow::bail!(
            "refusing to remove path outside workspace: {}",
            target.display()
        );
    }
    let _ = fs::remove_file(&target).await;
    let stop = absolute_path(&root, API_OUTPUT_ROOT);
    let mut directory = target.parent().map(Path::to_path_buf);
    while let Some(current) = directory {
        if current == stop || current == root {
            break;
        }
        let mut entries = fs::read_dir(&current).await?;
        if entries.next_entry().await?.is_some() {
            break;
        }
        fs::remove_dir(&current).await?;
        directory = current.parent().map(Path::to_path_buf);
    }
    Ok(())
}

/// Synchronise all API families into `docs/api` under `options.root_dir`.
pub async fn sync_api<C>(
    client: Arc<C>,
    options: ApiSyncOptions,
    on_progress: Option<Arc<dyn Fn(ApiProgress) + Send + Sync>>,
) -> Result<ApiSyncResult>
where
    C: ApiClient + 'static,
{
    let started = SystemTime::now();
    let root = options.root_dir;
    fs::create_dir_all(&root).await?;
    let manifest_path = absolute_path(&root, API_MANIFEST_PATH);
    let previous = load_api_manifest(&manifest_path).await?;

    emit(&on_progress, "catalogs", 0, API_FAMILIES.len(), false);
    let mut catalogs = FuturesUnordered::new();
    for family in API_FAMILIES {
        let client = client.clone();
        catalogs.push(async move {
            let catalog = if family == "class" {
                client.fetch_class_catalog().await?
            } else {
                client.fetch_sorted_catalog(family).await?
            };
            Ok::<_, anyhow::Error>((family, catalog))
        });
    }

    let mut flattened = HashMap::new();
    let mut family_nodes = HashMap::new();
    let mut family_summaries = HashMap::new();
    let mut catalogs_done = 0;
    while let Some(result) = catalogs.next().await {
        let (family, catalog) = result?;
        let mut records = Vec::new();
        let mut nodes = Vec::new();
        if family == "class" {
            flatten_class(&catalog, &[], &mut records, &mut nodes);
        } else {
            flatten_sorted(family, &catalog, &[], &mut records, &mut nodes);
        }
        family_summaries.insert(
            family.to_owned(),
            FamilySummary {
                count: records.len(),
            },
        );
        family_nodes.insert(family.to_owned(), nodes);
        flattened.insert(family, records);
        catalogs_done += 1;
        emit(
            &on_progress,
            "catalogs",
            catalogs_done,
            API_FAMILIES.len(),
            catalogs_done == API_FAMILIES.len(),
        );
    }

    let mut records: Vec<ApiEntity> = API_FAMILIES
        .iter()
        .flat_map(|family| flattened.remove(family).unwrap_or_default())
        .collect();
    let output_by_source: Arc<HashMap<String, String>> = Arc::new(
        records
            .iter()
            .map(|record| (record.source_path.clone(), record.output_path.clone()))
            .collect(),
    );
    let mut name_counts = HashMap::<String, usize>::new();
    for record in &records {
        *name_counts.entry(record.name.clone()).or_default() += 1;
    }
    let unique_by_name: Arc<HashMap<String, String>> = Arc::new(
        records
            .iter()
            .filter(|record| name_counts.get(&record.name) == Some(&1))
            .map(|record| (record.name.clone(), record.output_path.clone()))
            .collect(),
    );

    emit(&on_progress, "details", 0, records.len(), false);
    if records.is_empty() {
        emit(&on_progress, "details", 0, 0, true);
    }
    let semaphore = Arc::new(Semaphore::new(options.detail_concurrency.max(1)));
    let mut details = FuturesUnordered::new();
    for record in records.drain(..) {
        let client = client.clone();
        let semaphore = semaphore.clone();
        let output_by_source = output_by_source.clone();
        let unique_by_name = unique_by_name.clone();
        details.push(async move {
            let _permit = semaphore.acquire_owned().await?;
            let detail = client
                .fetch_detail(&record.family, &record.source_path)
                .await?;
            let body = render_api_markdown(&ApiMarkdownContext {
                family: record.family.clone(),
                detail: detail.clone(),
                output_path: record.output_path.clone(),
                output_path_by_source_path: output_by_source,
                unique_output_path_by_name: unique_by_name,
            })?;
            let mut record = record;
            record.description = string_value(detail.get("Description"));
            record.content_hash = hash_content(&body);
            Ok::<_, anyhow::Error>((record, body))
        });
    }

    let total_details = details.len();
    let mut detail_done = 0;
    let mut rendered = Vec::with_capacity(total_details);
    let mut bodies = HashMap::new();
    while let Some(result) = details.next().await {
        let (record, body) = result?;
        bodies.insert(record.output_path.clone(), body);
        rendered.push(record);
        detail_done += 1;
        emit(
            &on_progress,
            "details",
            detail_done,
            total_details,
            detail_done == total_details,
        );
    }
    rendered.sort_by(|left, right| left.output_path.cmp(&right.output_path));

    let next = ApiManifest {
        schema_version: SCHEMA_VERSION,
        last_synced_at: Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string(),
        ),
        families: family_summaries.clone(),
        entities: rendered.clone(),
    };
    let diff = diff_api_manifest(&previous, &next);
    let next_paths: HashSet<&str> = next
        .entities
        .iter()
        .map(|entity| entity.output_path.as_str())
        .collect();
    let stale_paths: Vec<String> = previous
        .entities
        .iter()
        .filter(|entity| !next_paths.contains(entity.output_path.as_str()))
        .map(|entity| entity.output_path.clone())
        .collect();

    let finalize_total = rendered.len() + API_FAMILIES.len() + stale_paths.len() + 3;
    let mut finalize_done = 0usize;
    emit(&on_progress, "finalize", 0, finalize_total, false);
    let mut tick_finalize = |callback: &Option<Arc<dyn Fn(ApiProgress) + Send + Sync>>| {
        finalize_done += 1;
        emit(
            callback,
            "finalize",
            finalize_done,
            finalize_total,
            finalize_done == finalize_total,
        );
    };

    let previous_by_source: HashMap<&str, &ApiEntity> = previous
        .entities
        .iter()
        .map(|entity| (entity.source_path.as_str(), entity))
        .collect();
    // 每个输出只探测一次；warm 同步同时复用结果判断恢复和写入，避免重复 metadata 调用。
    let mut missing_outputs = HashSet::new();
    let mut restored_count = 0usize;
    for entity in &rendered {
        let present = fs::metadata(absolute_path(&root, &entity.output_path))
            .await
            .is_ok();
        if !present {
            missing_outputs.insert(entity.output_path.clone());
        }
        if previous_by_source
            .get(entity.source_path.as_str())
            .map(|old| equivalent(old, entity))
            .unwrap_or(false)
            && !present
        {
            restored_count += 1;
        }
    }
    for entity in &rendered {
        let output = absolute_path(&root, &entity.output_path);
        let old = previous_by_source.get(entity.source_path.as_str());
        let missing = missing_outputs.contains(&entity.output_path);
        if old.is_none() || !equivalent(old.unwrap(), entity) || missing {
            write_if_changed(
                &output,
                bodies
                    .get(&entity.output_path)
                    .context("missing rendered body")?,
            )
            .await?;
        }
        tick_finalize(&on_progress);
    }
    for stale in stale_paths {
        remove_stale(&root, &stale).await?;
        tick_finalize(&on_progress);
    }

    for family in API_FAMILIES {
        let index_path = format!("{API_OUTPUT_ROOT}/{family}/000_索引.md");
        let body = build_tree_index(
            &format!("{family} API 索引"),
            &index_path,
            family_nodes.get(family).map(Vec::as_slice).unwrap_or(&[]),
        );
        write_if_changed(&absolute_path(&root, &index_path), &body).await?;
        tick_finalize(&on_progress);
    }
    write_if_changed(
        &absolute_path(&root, &format!("{API_OUTPUT_ROOT}/000_索引.md")),
        &build_root_index(&family_summaries),
    )
    .await?;
    tick_finalize(&on_progress);
    write_if_changed(
        &absolute_path(&root, API_SYMBOL_INDEX_PATH),
        &symbol_index(&rendered),
    )
    .await?;
    tick_finalize(&on_progress);
    save_api_manifest(&manifest_path, &next).await?;
    tick_finalize(&on_progress);

    let duration_ms = started.elapsed().unwrap_or_default().as_millis();
    Ok(ApiSyncResult {
        total_entities: next.entities.len(),
        created_count: diff.created.len() + restored_count,
        updated_count: diff.updated.len(),
        deleted_count: diff.deleted.len(),
        duration_ms,
    })
}

trait IfEmpty {
    fn if_empty_then(self, fallback: &str) -> String;
}
impl IfEmpty for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_paths_and_normalization() {
        assert_eq!(
            normalize_api_source_path("class", "detail/class/A/B.json"),
            "class/detail/A/B.json"
        );
        assert_eq!(
            build_api_output_path("class", "class/detail/A/B.json", &[]),
            "docs/api/class/A/B.md"
        );
        assert_eq!(
            build_api_output_path("cppenum", "cppenum/detail/X.json", &["A".into()]),
            "docs/api/cppenum/A/X.md"
        );
    }

    #[test]
    fn symbol_index_includes_bucket_path() {
        let text = symbol_index(&[ApiEntity {
            family: "cppenum".into(),
            name: "Phase".into(),
            source_path: "cppenum/detail/Phase.json".into(),
            output_path: "docs/api/cppenum/A/Phase.md".into(),
            bucket_path: vec!["A".into()],
            description: "demo".into(),
            ..Default::default()
        }]);
        assert!(text.contains("cppenum\tPhase\tA / Phase"));
    }
}
