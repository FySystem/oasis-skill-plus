use anyhow::Result;
use async_trait::async_trait;
use oasis_skill_plus::{
    api::{ApiClient, CategoryTree, ImageDownload, WikiClient},
    api_sync::{sync_api, ApiManifest, ApiSyncOptions},
    manifest::Manifest,
    sync::{sync_wiki, SyncOptions},
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};
use wiremock::{
    matchers::{method, path, query_param},
    Mock, MockServer, ResponseTemplate,
};

struct WikiFixture;

#[async_trait]
impl WikiClient for WikiFixture {
    async fn fetch_category_tree(&self) -> Result<CategoryTree> {
        Ok(CategoryTree {
            tree: json!([{
                "label": "Getting Started",
                "type": 0,
                "children": [{"id": "42", "label": "Hello", "type": 1}]
            }]),
            version: 7,
            update_time: 8,
        })
    }

    async fn fetch_article(&self, id: &str) -> Result<oasis_skill_plus::Article> {
        Ok(oasis_skill_plus::Article {
            id: id.to_owned(),
            title: "Hello".to_owned(),
            body:
                "# Hello\n\nSee [the guide](https://developer.gp.qq.com/wikieditor/#/article/42)."
                    .to_owned(),
            update_time: 8,
            add_time: 7,
        })
    }

    async fn download_image(&self, _url: &str) -> Result<ImageDownload> {
        Ok(ImageDownload {
            bytes: b"png".to_vec(),
            content_type: "image/png".to_owned(),
        })
    }
}

struct EmptyWikiFixture;

#[async_trait]
impl WikiClient for EmptyWikiFixture {
    async fn fetch_category_tree(&self) -> Result<CategoryTree> {
        Ok(CategoryTree {
            tree: json!([]),
            version: 8,
            update_time: 9,
        })
    }

    async fn fetch_article(&self, id: &str) -> Result<oasis_skill_plus::Article> {
        Err(anyhow::anyhow!("unexpected article request: {id}"))
    }

    async fn download_image(&self, url: &str) -> Result<ImageDownload> {
        Err(anyhow::anyhow!("unexpected image request: {url}"))
    }
}

struct ApiFixture;

#[async_trait]
impl ApiClient for ApiFixture {
    async fn fetch_class_catalog(&self) -> Result<Value> {
        Ok(json!([{
            "Type": "class",
            "Name": "AActor",
            "Path": "class/detail/AActor.json"
        }]))
    }

    async fn fetch_sorted_catalog(&self, family: &str) -> Result<Value> {
        Ok(json!({
            "Gameplay": {
                format!("{family}Symbol"): format!("{family}/detail/{family}Symbol.json")
            }
        }))
    }

    async fn fetch_detail(&self, family: &str, source_path: &str) -> Result<Value> {
        let name = Path::new(source_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Unknown");
        Ok(match family {
            "class" => {
                json!({"Name": name, "Description": "Base class", "Variables": [], "Functions": []})
            }
            "cppenum" => {
                json!({"Name": name, "Variables": [{"Name": "None", "Value": "0", "Description": "Empty"}]})
            }
            "cppstruct" => json!({"Name": name, "Variables": []}),
            "globalfunc" => json!({"Name": name, "Params": [], "Return": null}),
            _ => json!({"Name": name}),
        })
    }
}

#[tokio::test]
async fn wiki_sync_writes_documents_indexes_and_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let result = sync_wiki(
        Arc::new(WikiFixture),
        SyncOptions {
            root_dir: temp.path().to_path_buf(),
            article_concurrency: 2,
            image_concurrency: 2,
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.total_articles, 1);
    assert_eq!(result.created_count, 1);
    assert!(temp
        .path()
        .join("docs/wiki/Getting Started/42_Hello.md")
        .is_file());
    assert!(temp.path().join("docs/wiki/000_索引.md").is_file());
    let index = fs::read_to_string(temp.path().join("docs/wiki/article-index.tsv")).unwrap();
    assert!(index.starts_with("id\ttitle\twiki_path\turl\tfile\n"));
    let manifest = fs::read_to_string(temp.path().join(".oasis-sync/manifest.json")).unwrap();
    assert!(manifest.contains("schemaVersion"));
}

#[tokio::test]
async fn wiki_sync_removes_documents_removed_from_remote_tree() {
    let temp = tempfile::tempdir().unwrap();
    sync_wiki(
        Arc::new(WikiFixture),
        SyncOptions::in_dir(temp.path()),
        None,
    )
    .await
    .unwrap();
    let document = temp.path().join("docs/wiki/Getting Started/42_Hello.md");
    assert!(document.is_file());

    let result = sync_wiki(
        Arc::new(EmptyWikiFixture),
        SyncOptions::in_dir(temp.path()),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.deleted_count, 1);
    assert!(!document.exists());
}

#[tokio::test]
async fn wiki_sync_repairs_missing_documents_and_indexes_from_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let options = SyncOptions::in_dir(temp.path());
    sync_wiki(Arc::new(WikiFixture), options.clone(), None)
        .await
        .unwrap();
    let document = temp.path().join("docs/wiki/Getting Started/42_Hello.md");
    fs::remove_file(&document).unwrap();
    fs::remove_file(temp.path().join("docs/wiki/000_索引.md")).unwrap();
    fs::remove_file(temp.path().join("docs/wiki/article-index.tsv")).unwrap();

    let result = sync_wiki(Arc::new(WikiFixture), options, None)
        .await
        .unwrap();
    assert_eq!(result.created_count, 0);
    assert_eq!(result.updated_count, 0);
    assert!(document.is_file());
    assert!(temp.path().join("docs/wiki/000_索引.md").is_file());
    assert!(temp.path().join("docs/wiki/article-index.tsv").is_file());

    let manifest: Manifest = serde_json::from_str(
        &fs::read_to_string(temp.path().join(".oasis-sync/manifest.json")).unwrap(),
    )
    .unwrap();
    for article in manifest.articles {
        assert!(temp.path().join(article.output_path).is_file());
    }
}

#[tokio::test]
async fn api_sync_writes_all_families_and_searchable_symbol_index() {
    let temp = tempfile::tempdir().unwrap();
    let result = sync_api(
        Arc::new(ApiFixture),
        ApiSyncOptions {
            root_dir: temp.path().to_path_buf(),
            detail_concurrency: 4,
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(result.total_entities, 4);
    assert_eq!(result.created_count, 4);
    assert!(temp.path().join("docs/api/000_索引.md").is_file());
    for family in ["class", "cppenum", "cppstruct", "globalfunc"] {
        assert!(temp
            .path()
            .join(format!("docs/api/{family}/000_索引.md"))
            .is_file());
    }
    let symbols = fs::read_to_string(temp.path().join("docs/api/symbol-index.tsv")).unwrap();
    assert!(symbols.starts_with(
        "kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n"
    ));
    assert!(symbols.contains("AActor"));
    let manifest = fs::read_to_string(temp.path().join(".oasis-sync/api-manifest.json")).unwrap();
    assert!(manifest.contains("schemaVersion"));
}

#[tokio::test]
async fn api_sync_repairs_missing_documents_and_indexes_from_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let options = ApiSyncOptions {
        root_dir: temp.path().to_path_buf(),
        detail_concurrency: 4,
    };
    sync_api(Arc::new(ApiFixture), options.clone(), None)
        .await
        .unwrap();
    let manifest_path = temp.path().join(".oasis-sync/api-manifest.json");
    let manifest: ApiManifest =
        serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
    let document = temp.path().join(&manifest.entities[0].output_path);
    fs::remove_file(&document).unwrap();
    fs::remove_file(temp.path().join("docs/api/000_索引.md")).unwrap();
    fs::remove_file(temp.path().join("docs/api/symbol-index.tsv")).unwrap();

    let result = sync_api(Arc::new(ApiFixture), options, None).await.unwrap();
    // API 摘要把恢复缺失实体计入 created，正文和索引必须实际恢复。
    assert_eq!(result.created_count, 1);
    assert_eq!(result.updated_count, 0);
    assert!(document.is_file());
    assert!(temp.path().join("docs/api/000_索引.md").is_file());
    assert!(temp.path().join("docs/api/symbol-index.tsv").is_file());
    for entity in manifest.entities {
        assert!(temp.path().join(entity.output_path).is_file());
    }
}

#[tokio::test]
async fn http_clients_validate_envelopes_and_encode_parameters() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/_api/look-Category"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "data": [{"Body": "[{\"label\":\"Root\",\"type\":0}]", "Version": 3, "UpdateTime": 4}]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/_api/query-articles"))
        .and(query_param("Id", "A B"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "code": 0,
            "data": [{"Id": "A B", "Title": "Encoded", "Body": "body", "UpdateTime": 5}]
        })))
        .mount(&server)
        .await;

    let client = oasis_skill_plus::WikiHttpClient::new(server.uri());
    let tree = client.fetch_category_tree().await.unwrap();
    assert_eq!(tree.version, 3);
    let article = client.fetch_article("A B").await.unwrap();
    assert_eq!(article.title, "Encoded");
}
