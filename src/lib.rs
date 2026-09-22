pub mod api;
pub mod api_markdown;
pub mod api_sync;
pub mod index;
pub mod manifest;
pub mod markdown;
pub mod search;
pub mod sync;

pub use api::{
    ApiClient, ApiHttpClient, Article, CategoryTree, ImageDownload, WikiClient, WikiHttpClient,
};
pub use api_markdown::{render_api_markdown, ApiMarkdownContext};
pub use api_sync::{
    build_api_output_path, create_empty_api_manifest, diff_api_manifest,
    get_default_api_detail_concurrency, load_api_manifest, normalize_api_source_path,
    save_api_manifest, sync_api, ApiEntity, ApiManifest, ApiManifestDiff, ApiProgress,
    ApiSyncOptions, ApiSyncResult, API_FAMILIES, API_MANIFEST_PATH, API_OUTPUT_ROOT,
    API_SYMBOL_INDEX_PATH,
};
pub use index::{
    build_api_symbol_index_rows, build_wiki_article_index_rows, escape_tsv_cell, parse_tsv,
    render_api_symbol_index, render_tsv, render_wiki_article_index, ApiSymbolIndexRow,
    ApiSymbolRecord, TsvRow, WikiArticleIndexRow, WikiArticleRecord,
};
pub use manifest::{
    create_empty_manifest, diff_manifest, hash_content, load_manifest, save_manifest,
    ArticleRecord, Manifest, ManifestDiff,
};
pub use markdown::*;
pub use search::{
    create_search_error, error_as_json, format_result, format_text_result, query_docs,
    resolve_oasis_repo_root, result_as_json, run_docs_query, QueryResult, SearchError, SearchMatch,
    SearchOptions, SearchWarning,
};
pub use sync::{sync_wiki, ProgressEvent, SyncOptions, SyncResult};
