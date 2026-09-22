use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RemoteTree {
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(rename = "updateTime", default)]
    pub update_time: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ArticleRecord {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(rename = "treePath", default)]
    pub tree_path: Vec<String>,
    #[serde(rename = "outputPath", default)]
    pub output_path: String,
    #[serde(rename = "updateTime", default)]
    pub update_time: Option<i64>,
    #[serde(rename = "contentHash", default)]
    pub content_hash: String,
    #[serde(rename = "imageUrls", default)]
    pub image_urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    #[serde(
        rename = "schemaVersion",
        alias = "schema_version",
        default = "default_schema"
    )]
    pub schema_version: u32,
    #[serde(rename = "lastSyncedAt", default)]
    pub last_synced_at: Option<String>,
    #[serde(rename = "remoteTree", default)]
    pub remote_tree: RemoteTree,
    #[serde(default)]
    pub articles: Vec<ArticleRecord>,
    #[serde(default)]
    pub images: HashMap<String, String>,
}
fn default_schema() -> u32 {
    SCHEMA_VERSION
}
impl Default for Manifest {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            last_synced_at: None,
            remote_tree: RemoteTree::default(),
            articles: vec![],
            images: HashMap::new(),
        }
    }
}
pub fn create_empty_manifest() -> Manifest {
    Manifest::default()
}

pub async fn load_manifest(path: impl AsRef<Path>) -> Result<Manifest> {
    match tokio::fs::read_to_string(path).await {
        Ok(raw) => Ok(serde_json::from_str::<Manifest>(&raw).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(e.into()),
    }
}

pub async fn save_manifest(path: impl AsRef<Path>, manifest: &Manifest) -> Result<()> {
    if let Some(parent) = path.as_ref().parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut json = serde_json::to_string_pretty(manifest)?;
    json.push('\n');
    tokio::fs::write(path, json).await?;
    Ok(())
}

pub fn hash_content(content: impl AsRef<str>) -> String {
    let mut h = Sha256::new();
    h.update(content.as_ref().as_bytes());
    hex::encode(h.finalize())[..16].to_owned()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestDiff {
    pub created: Vec<ArticleRecord>,
    pub updated: Vec<ArticleRecord>,
    pub deleted: Vec<ArticleRecord>,
}
fn equivalent(a: &ArticleRecord, b: &ArticleRecord) -> bool {
    a.title == b.title
        && a.output_path == b.output_path
        && a.content_hash == b.content_hash
        && a.tree_path == b.tree_path
        && a.image_urls == b.image_urls
}
pub fn diff_manifest(previous: &Manifest, next: &Manifest) -> ManifestDiff {
    let old: HashMap<&str, &ArticleRecord> = previous
        .articles
        .iter()
        .map(|a| (a.id.as_str(), a))
        .collect();
    let new: HashMap<&str, &ArticleRecord> =
        next.articles.iter().map(|a| (a.id.as_str(), a)).collect();
    let mut d = ManifestDiff::default();
    for a in &next.articles {
        match old.get(a.id.as_str()) {
            None => d.created.push(a.clone()),
            Some(prev) if !equivalent(prev, a) => d.updated.push(a.clone()),
            _ => {}
        }
    }
    for a in &previous.articles {
        if !new.contains_key(a.id.as_str()) {
            d.deleted.push(a.clone());
        }
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_stable() {
        assert_eq!(hash_content("hello"), hash_content("hello"));
        assert_ne!(hash_content("hello"), hash_content("world"));
    }
    #[test]
    fn diff() {
        let a = ArticleRecord {
            id: "1".into(),
            title: "old".into(),
            output_path: "1.md".into(),
            content_hash: "a".into(),
            ..Default::default()
        };
        let b = ArticleRecord {
            id: "1".into(),
            title: "old".into(),
            output_path: "1.md".into(),
            content_hash: "b".into(),
            ..Default::default()
        };
        let c = ArticleRecord {
            id: "2".into(),
            ..Default::default()
        };
        let old = Manifest {
            articles: vec![a.clone(), c],
            ..Default::default()
        };
        let next = Manifest {
            articles: vec![b],
            ..Default::default()
        };
        let d = diff_manifest(&old, &next);
        assert_eq!(d.updated.len(), 1);
        assert_eq!(d.deleted.len(), 1);
    }
}
