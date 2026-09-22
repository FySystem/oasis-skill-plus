//! Local, dependency-free documentation search.
//!
//! This module replaces the old `rg --json` runner.  It searches the generated
//! TSV indexes first and Markdown files as a fallback, while keeping the JSON
//! shape and text rendering used by the command line tool.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fmt::{Display, Formatter};
use std::fs;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::thread;

const API_INDEX_PATH: &str = "docs/api/symbol-index.tsv";
const WIKI_INDEX_PATH: &str = "docs/wiki/article-index.tsv";
const SUPPORTED_FAMILIES: [&str; 4] = ["class", "cppenum", "cppstruct", "globalfunc"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchOptions {
    #[serde(rename = "projectRoot", alias = "project_root")]
    pub project_root: PathBuf,
    pub mode: String,
    pub scope: String,
    pub format: String,
    pub query: String,
    pub family: Option<String>,
    pub limit: usize,
    pub exact: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            project_root: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            mode: "search".to_owned(),
            scope: "all".to_owned(),
            format: "json".to_owned(),
            query: String::new(),
            family: None,
            limit: 20,
            exact: false,
        }
    }
}

impl SearchOptions {
    pub fn new(
        project_root: impl Into<PathBuf>,
        mode: impl Into<String>,
        scope: impl Into<String>,
        query: impl Into<String>,
    ) -> Self {
        Self {
            project_root: project_root.into(),
            mode: mode.into(),
            scope: scope.into(),
            query: query.into(),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchWarning {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchMatch {
    #[serde(rename = "type")]
    pub match_type_scope: String,
    #[serde(rename = "matchType")]
    pub match_type: String,
    pub title: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    #[serde(rename = "absolutePath")]
    pub absolute_path: String,
    pub excerpt: String,
    #[serde(rename = "lineNumber")]
    pub line_number: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(rename = "sourceJsonUrl", skip_serializing_if = "Option::is_none")]
    pub source_json_url: Option<String>,
    #[serde(rename = "sourceUrl", skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueryResult {
    pub ok: bool,
    pub mode: String,
    pub scope: String,
    pub format: String,
    pub query: String,
    #[serde(rename = "oasisRepoRoot")]
    pub oasis_repo_root: String,
    pub warnings: Vec<SearchWarning>,
    pub matches: Vec<SearchMatch>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl SearchError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Some(details),
        }
    }
}

impl Display for SearchError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SearchError {}

pub fn create_search_error(code: impl Into<String>, message: impl Into<String>) -> SearchError {
    SearchError::new(code, message)
}

/// Resolve the repository in the same two layouts accepted by the original
/// command: `<project-root>/oasis-skill-plus` and a direct repo path.
pub fn resolve_oasis_repo_root(project_root: &Path) -> Result<PathBuf, SearchError> {
    let root = absolute_path(project_root);
    let nested = root.join("oasis-skill-plus");
    if nested.join("docs").is_dir() {
        return Ok(nested);
    }
    if root.file_name().and_then(|name| name.to_str()) == Some("oasis-skill-plus")
        && root.join("docs").is_dir()
    {
        return Ok(root);
    }
    Err(SearchError::with_details(
        "OASIS_REPO_NOT_FOUND",
        format!(
            "未找到 oasis-skill-plus 文档目录：已检查 {}",
            nested.join("docs").display()
        ),
        json!({ "projectRoot": root, "expectedPath": nested }),
    ))
}

struct MatchCollector {
    matches: Vec<SearchMatch>,
    seen: HashSet<(String, usize, String)>,
    limit: usize,
}

impl MatchCollector {
    fn new(limit: usize) -> Self {
        Self {
            matches: Vec::with_capacity(limit.min(64)),
            seen: HashSet::new(),
            limit,
        }
    }

    fn is_full(&self) -> bool {
        self.matches.len() >= self.limit
    }

    fn push(&mut self, item: SearchMatch) {
        if self.is_full() {
            return;
        }
        let key = (
            item.relative_path.clone(),
            item.line_number,
            item.excerpt.clone(),
        );
        if self.seen.insert(key) {
            self.matches.push(item);
        }
    }
}

/// Search generated indexes and Markdown files.
pub fn run_docs_query(options: &SearchOptions) -> Result<QueryResult, SearchError> {
    let options = normalize_options(options)?;
    let repo_root = resolve_oasis_repo_root(&options.project_root)?;
    let mut warnings = Vec::new();
    let mut collector = MatchCollector::new(options.limit);

    let include_api =
        options.mode == "verify-api" || options.scope == "api" || options.scope == "all";
    let include_wiki =
        options.mode != "verify-api" && (options.scope == "wiki" || options.scope == "all");

    if include_api {
        let index_path = repo_root.join(API_INDEX_PATH);
        let has_index = index_path.is_file();
        if has_index {
            search_api_index(&index_path, &repo_root, &options, &mut collector)?;
        } else {
            warnings.push(index_warning(API_INDEX_PATH, options.exact));
        }

        let search_markdown = !options.exact && !(options.mode == "verify-api" && has_index);
        let target = options
            .family
            .as_deref()
            .map(|family| format!("docs/api/{family}"))
            .unwrap_or_else(|| "docs/api".to_owned());
        if search_markdown && !collector.is_full() && repo_root.join(&target).is_dir() {
            search_markdown_files(&repo_root, &target, &options.query, &mut collector)?;
        }
    }

    if include_wiki {
        let index_path = repo_root.join(WIKI_INDEX_PATH);
        let has_index = index_path.is_file();
        if has_index {
            search_wiki_index(&index_path, &repo_root, &options, &mut collector)?;
        } else {
            warnings.push(index_warning(WIKI_INDEX_PATH, options.exact));
        }
        if !options.exact && !collector.is_full() && repo_root.join("docs/wiki").is_dir() {
            search_markdown_files(&repo_root, "docs/wiki", &options.query, &mut collector)?;
        }
    }

    Ok(QueryResult {
        ok: true,
        mode: options.mode,
        scope: options.scope,
        format: options.format,
        query: options.query,
        oasis_repo_root: repo_root.display().to_string(),
        warnings,
        matches: collector.matches,
    })
}

/// Convenience wrapper for callers that own the options value.
pub fn query_docs(options: SearchOptions) -> Result<QueryResult, SearchError> {
    run_docs_query(&options)
}

pub fn format_text_result(payload: &QueryResult) -> String {
    let mut lines = vec![
        format!("ok: {}", payload.ok),
        format!("scope: {}", payload.scope),
        format!("mode: {}", payload.mode),
        format!("query: {}", payload.query),
    ];
    if !payload.warnings.is_empty() {
        lines.push("warnings:".to_owned());
        lines.extend(
            payload
                .warnings
                .iter()
                .map(|warning| format!("- {}: {}", warning.code, warning.message)),
        );
    }
    if payload.matches.is_empty() {
        lines.push("No matches.".to_owned());
        return lines.join("\n");
    }
    lines.push("matches:".to_owned());
    for (index, item) in payload.matches.iter().enumerate() {
        lines.push(format!(
            "{}. [{}] {}",
            index + 1,
            item.match_type_scope,
            item.title
        ));
        lines.push(format!("   file: {}", item.relative_path));
        lines.push(format!("   line: {}", item.line_number));
        lines.push(format!("   excerpt: {}", item.excerpt));
    }
    lines.join("\n")
}

pub fn result_as_json(payload: &QueryResult) -> Result<String, SearchError> {
    serde_json::to_string_pretty(payload)
        .map_err(|error| SearchError::new("SERIALIZE_FAILED", error.to_string()))
}

/// Render failures in the same structured shape as successful CLI responses.
pub fn error_as_json(error: &SearchError) -> Result<String, SearchError> {
    serde_json::to_string_pretty(&json!({
        "ok": false,
        "error": error,
    }))
    .map_err(|serialize_error| SearchError::new("SERIALIZE_FAILED", serialize_error.to_string()))
}

/// Select the requested output format from a successful query result.
pub fn format_result(payload: &QueryResult) -> Result<String, SearchError> {
    match payload.format.as_str() {
        "text" => Ok(format_text_result(payload)),
        _ => result_as_json(payload),
    }
}

fn normalize_options(input: &SearchOptions) -> Result<SearchOptions, SearchError> {
    let mut options = input.clone();
    options.mode = options.mode.trim().to_owned();
    options.scope = options.scope.trim().to_owned();
    options.format = if options.format.trim().is_empty() {
        "json".to_owned()
    } else {
        options.format.trim().to_owned()
    };
    options.query = options.query.trim().to_owned();
    if options.limit == 0 {
        options.limit = 20;
    }
    if !matches!(options.mode.as_str(), "verify-api" | "search") {
        return Err(SearchError::with_details(
            "INVALID_ARGUMENTS",
            "mode 只支持 verify-api / search。",
            json!({ "mode": options.mode }),
        ));
    }
    if !matches!(options.scope.as_str(), "api" | "wiki" | "all") {
        return Err(SearchError::with_details(
            "INVALID_ARGUMENTS",
            "scope 只支持 api / wiki / all。",
            json!({ "scope": options.scope }),
        ));
    }
    if !matches!(options.format.as_str(), "json" | "text") {
        return Err(SearchError::with_details(
            "INVALID_ARGUMENTS",
            "format 只支持 json / text。",
            json!({ "format": options.format }),
        ));
    }
    if options.query.is_empty() {
        return Err(SearchError::new(
            "INVALID_ARGUMENTS",
            "query 必填且不能为空。",
        ));
    }
    if options.mode == "verify-api" && options.scope == "wiki" {
        return Err(SearchError::with_details(
            "INVALID_ARGUMENTS",
            "verify-api 不允许 scope=wiki。",
            json!({ "mode": options.mode, "scope": options.scope }),
        ));
    }
    if let Some(family) = &options.family {
        if !SUPPORTED_FAMILIES.contains(&family.as_str()) {
            return Err(SearchError::with_details(
                "INVALID_ARGUMENTS",
                "family 只支持 class / cppenum / cppstruct / globalfunc。",
                json!({ "family": family }),
            ));
        }
    }
    Ok(options)
}

fn index_warning(index_path: &str, exact: bool) -> SearchWarning {
    let message = if exact {
        format!("{index_path} is missing; exact search requires the index, so Markdown fallback was skipped.")
    } else {
        format!("{index_path} is missing; searched Markdown files directly.")
    };
    SearchWarning {
        code: "INDEX_MISSING".to_owned(),
        message,
    }
}

fn search_api_index(
    path: &Path,
    root: &Path,
    options: &SearchOptions,
    output: &mut MatchCollector,
) -> Result<(), SearchError> {
    let file = File::open(path).map_err(|error| io_error(path, error))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut line_number = 0;
    while reader
        .read_line(&mut line)
        .map_err(|error| io_error(path, error))?
        > 0
    {
        line_number += 1;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if line_number == 1 || !index_line_matches(trimmed, options) {
            line.clear();
            continue;
        }
        let cells = trimmed.split('\t').collect::<Vec<_>>();
        if cells.len() < 7
            || options
                .family
                .as_deref()
                .is_some_and(|family| cells[0] != family)
        {
            line.clear();
            continue;
        }
        let Some((relative, absolute)) = safe_relative_path(cells[5], root) else {
            line.clear();
            continue;
        };
        output.push(SearchMatch {
            match_type_scope: "api".to_owned(),
            match_type: "symbol-index".to_owned(),
            title: cells[1].to_owned(),
            relative_path: relative,
            absolute_path: absolute.display().to_string(),
            excerpt: if cells[6..].join("\t").is_empty() {
                cells[2].to_owned()
            } else {
                cells[6..].join("\t")
            },
            line_number,
            family: Some(cells[0].to_owned()),
            source_json_url: Some(cells[4].to_owned()),
            source_url: None,
        });
        if output.is_full() {
            break;
        }
        line.clear();
    }
    Ok(())
}

fn search_wiki_index(
    path: &Path,
    root: &Path,
    options: &SearchOptions,
    output: &mut MatchCollector,
) -> Result<(), SearchError> {
    let file = File::open(path).map_err(|error| io_error(path, error))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut line_number = 0;
    while reader
        .read_line(&mut line)
        .map_err(|error| io_error(path, error))?
        > 0
    {
        line_number += 1;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if line_number == 1 || !index_line_matches(trimmed, options) {
            line.clear();
            continue;
        }
        let cells = trimmed.split('\t').collect::<Vec<_>>();
        if cells.len() < 5 {
            line.clear();
            continue;
        }
        let Some((relative, absolute)) = safe_relative_path(cells[4], root) else {
            line.clear();
            continue;
        };
        output.push(SearchMatch {
            match_type_scope: "wiki".to_owned(),
            match_type: "article-index".to_owned(),
            title: cells[1].to_owned(),
            relative_path: relative,
            absolute_path: absolute.display().to_string(),
            excerpt: if cells[2].is_empty() {
                cells[1].to_owned()
            } else {
                cells[2].to_owned()
            },
            line_number,
            family: None,
            source_json_url: None,
            source_url: Some(cells[3].to_owned()),
        });
        if output.is_full() {
            break;
        }
        line.clear();
    }
    Ok(())
}

fn index_line_matches(line: &str, options: &SearchOptions) -> bool {
    if options.mode == "verify-api" {
        let cells = line.split('\t').collect::<Vec<_>>();
        return cells.len() >= 2
            && options
                .family
                .as_deref()
                .is_none_or(|family| cells[0].eq_ignore_ascii_case(family))
            && cells[1].eq_ignore_ascii_case(&options.query);
    }
    if options.exact {
        let cells = line.split('\t').collect::<Vec<_>>();
        return cells.iter().enumerate().any(|(index, cell)| {
            index > 0 && index + 1 < cells.len() && cell.eq_ignore_ascii_case(&options.query)
        });
    }
    contains_case_insensitive(line, &options.query)
}

fn search_markdown_files(
    root: &Path,
    target: &str,
    query: &str,
    output: &mut MatchCollector,
) -> Result<(), SearchError> {
    let target_path = root.join(target);
    let mut files = Vec::new();
    collect_markdown_files(&target_path, &mut files)?;
    files.sort();
    if files.is_empty() {
        return Ok(());
    }
    // 按稳定排序后的路径分块并行扫描，主线程按块顺序合并，保证 limit 和结果顺序可复现。
    let worker_count = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .min(32)
        .min(files.len());
    if worker_count == 1 {
        let matches = scan_markdown_chunk(root, query, &files, output.limit)?;
        for item in matches {
            output.push(item);
            if output.is_full() {
                break;
            }
        }
        return Ok(());
    }

    let chunk_size = files.len().div_ceil(worker_count);
    let chunks = files
        .chunks(chunk_size)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let results = thread::scope(|scope| {
        chunks
            .iter()
            .map(|chunk| scope.spawn(|| scan_markdown_chunk(root, query, chunk, output.limit)))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| {
                handle.join().map_err(|_| {
                    SearchError::new("SEARCH_FAILED", "Markdown 搜索工作线程异常退出。")
                })?
            })
            .collect::<Result<Vec<_>, SearchError>>()
    })?;
    for chunk_matches in results {
        for item in chunk_matches {
            output.push(item);
            if output.is_full() {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn scan_markdown_chunk(
    root: &Path,
    query: &str,
    files: &[PathBuf],
    local_limit: usize,
) -> Result<Vec<SearchMatch>, SearchError> {
    let mut matches = Vec::with_capacity(local_limit.min(64));
    for path in files {
        let Some(relative) = path.strip_prefix(root).ok().map(path_to_slash) else {
            continue;
        };
        let title = markdown_title(&relative);
        let kind = if relative.starts_with("docs/api/") {
            "api"
        } else {
            "wiki"
        };
        // 并行 worker 内按文件一次读取，减少逐行系统调用；每个 worker
        // 只持有当前文件内容，整体内存仍受 chunk 并发数限制。
        let content = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
        for (line_index, line) in content.lines().enumerate() {
            let excerpt = line.trim_end_matches('\r');
            if contains_case_insensitive(excerpt, query) {
                matches.push(SearchMatch {
                    match_type_scope: kind.to_owned(),
                    match_type: "content".to_owned(),
                    title: title.clone(),
                    relative_path: relative.clone(),
                    absolute_path: path.display().to_string(),
                    excerpt: excerpt.to_owned(),
                    line_number: line_index + 1,
                    family: None,
                    source_json_url: None,
                    source_url: None,
                });
                if matches.len() >= local_limit {
                    return Ok(matches);
                }
            }
        }
    }
    Ok(matches)
}

fn collect_markdown_files(path: &Path, output: &mut Vec<PathBuf>) -> Result<(), SearchError> {
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| io_error(&directory, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&directory, error))?;
            let child = entry.path();
            if child.is_dir() {
                pending.push(child);
            } else if child
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                && child
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_none_or(|name| !name.starts_with("000_"))
            {
                output.push(child);
            }
        }
    }
    Ok(())
}

fn io_error(path: &Path, error: std::io::Error) -> SearchError {
    SearchError::with_details(
        "SEARCH_FAILED",
        format!("读取文档失败：{}", path.display()),
        json!({ "cause": error.to_string(), "path": path }),
    )
}

fn contains_case_insensitive(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.is_ascii() && needle.is_ascii() {
        return haystack
            .as_bytes()
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()));
    }
    if haystack.contains(needle) {
        return true;
    }
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn safe_relative_path(input: &str, root: &Path) -> Option<(String, PathBuf)> {
    let normalized = input.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(":/")
        || normalized.as_bytes().get(1) == Some(&b':')
    {
        return None;
    }
    let mut components = Vec::<String>::new();
    for component in normalized.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            value => components.push(value.to_owned()),
        }
    }
    if components.is_empty() {
        return None;
    }
    let relative = components.join("/");
    let absolute = components
        .iter()
        .fold(root.to_path_buf(), |path, component| path.join(component));
    Some((relative, absolute))
}

fn path_to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn markdown_title(relative: &str) -> String {
    let filename = relative.rsplit('/').next().unwrap_or(relative);
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let bytes = stem.as_bytes();
    let mut index = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    while index < bytes.len() && bytes[index] == b'_' {
        index += 1;
    }
    stem[index..].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use tempfile::tempdir;

    fn fixture() -> tempfile::TempDir {
        let temp = tempdir().unwrap();
        let docs = temp.path().join("oasis-skill-plus/docs");
        create_dir_all(docs.join("api/class")).unwrap();
        create_dir_all(docs.join("wiki/guide")).unwrap();
        write(docs.join("api/symbol-index.tsv"), "kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\nclass\tActor\tEngine / Actor\tclass/Actor.json\thttp://source\tdocs/api/class/001_actor.md\tbase class\n").unwrap();
        write(docs.join("wiki/article-index.tsv"), "id\ttitle\twiki_path\turl\tfile\n7\tGetting Started\tGuide\thttp://wiki\tdocs/wiki/guide/007_start.md\n").unwrap();
        write(
            docs.join("api/class/001_actor.md"),
            "# Actor\nBase class content\n",
        )
        .unwrap();
        write(
            docs.join("wiki/guide/007_start.md"),
            "# Getting Started\nWelcome guide\n",
        )
        .unwrap();
        temp
    }

    #[test]
    fn searches_indexes_and_markdown_with_stable_shape() {
        let temp = fixture();
        let mut options = SearchOptions::new(temp.path(), "search", "all", "base");
        let result = run_docs_query(&options).unwrap();
        assert_eq!(result.matches[0].match_type, "symbol-index");
        assert_eq!(
            result.matches[0].relative_path,
            "docs/api/class/001_actor.md"
        );
        options.exact = true;
        options.query = "Actor".into();
        let exact = run_docs_query(&options).unwrap();
        assert_eq!(exact.matches.len(), 1);
        assert_eq!(exact.matches[0].title, "Actor");
    }

    #[test]
    fn searches_wiki_and_formats_text() {
        let temp = fixture();
        let options = SearchOptions::new(temp.path(), "search", "wiki", "guide");
        let result = run_docs_query(&options).unwrap();
        assert!(result
            .matches
            .iter()
            .any(|item| item.match_type == "article-index"));
        let text = format_text_result(&result);
        assert!(text.contains("matches:"));
        assert!(text.contains("Getting Started"));
    }

    #[test]
    fn validates_mode_and_rejects_unsafe_paths() {
        let temp = fixture();
        let mut options = SearchOptions::new(temp.path(), "bad", "all", "x");
        let error = run_docs_query(&options).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENTS");
        options.mode = "search".into();
        options.scope = "wiki".into();
        assert!(
            safe_relative_path("../../outside.md", &temp.path().join("oasis-skill-plus")).is_none()
        );
    }

    #[test]
    fn stops_index_scan_before_markdown_when_limit_is_reached() {
        let temp = tempdir().unwrap();
        let docs = temp.path().join("oasis-skill-plus/docs/api/class");
        create_dir_all(&docs).unwrap();
        let mut index =
            "kind\tname\tsymbol_path\tsource_json_path\tsource_json_url\tmarkdown_file\tdescription\n"
                .to_owned();
        for number in 0..100 {
            index.push_str(&format!(
                "class\tActor{number}\tActor{number}\tclass/Actor{number}.json\thttp://source\tdocs/api/class/Actor{number}.md\tmatching\n"
            ));
        }
        write(docs.parent().unwrap().join("symbol-index.tsv"), index).unwrap();
        write(docs.join("body.md"), "matching markdown body\n").unwrap();

        let mut options = SearchOptions::new(temp.path(), "search", "api", "matching");
        options.limit = 2;
        let result = run_docs_query(&options).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert!(result
            .matches
            .iter()
            .all(|item| item.match_type == "symbol-index"));
    }

    #[test]
    fn parallel_markdown_scan_merges_sorted_paths_deterministically() {
        let temp = tempdir().unwrap();
        let docs = temp.path().join("oasis-skill-plus/docs/wiki");
        create_dir_all(docs.join("z")).unwrap();
        create_dir_all(docs.join("a")).unwrap();
        write(docs.join("z/002_later.md"), "needle later\n").unwrap();
        write(docs.join("a/001_earlier.md"), "needle earlier\n").unwrap();

        let options = SearchOptions::new(temp.path(), "search", "wiki", "needle");
        let result = run_docs_query(&options).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(
            result.matches[0].relative_path,
            "docs/wiki/a/001_earlier.md"
        );
        assert_eq!(result.matches[1].relative_path, "docs/wiki/z/002_later.md");
    }
}
