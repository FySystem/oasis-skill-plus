//! TSV index helpers used by the Rust documentation synchronizer.
//!
//! The JavaScript implementation writes deliberately simple, tab separated
//! files.  Keeping the representation here small and deterministic makes the
//! index useful to both the synchronizer and the local search command.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const API_BASE_URL: &str = "https://developer.gp.qq.com/api";
pub const WIKI_BASE_URL: &str = "https://developer.gp.qq.com/wikieditor/#/catalog";

/// A row whose keys are the TSV header names.
pub type TsvRow = BTreeMap<String, String>;

/// Normalize one TSV cell in the same way as the original implementation.
pub fn escape_tsv_cell(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\t', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned()
}

/// Render rows using the supplied header order.
pub fn render_tsv(headers: &[impl AsRef<str>], rows: &[TsvRow]) -> String {
    let mut output = String::new();
    output.push_str(
        &headers
            .iter()
            .map(|header| header.as_ref())
            .collect::<Vec<_>>()
            .join("\t"),
    );
    output.push('\n');

    for row in rows {
        let cells = headers
            .iter()
            .map(|header| {
                row.get(header.as_ref())
                    .map(escape_tsv_cell)
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        output.push_str(&cells.join("\t"));
        output.push('\n');
    }

    output
}

/// Parse a TSV document. Empty lines are ignored, as in the JavaScript code.
pub fn parse_tsv(text: &str) -> Vec<TsvRow> {
    let mut lines = text.lines().filter(|line| !line.is_empty());
    let Some(header_line) = lines.next() else {
        return Vec::new();
    };
    let headers = header_line.split('\t').collect::<Vec<_>>();
    lines
        .map(|line| {
            let cells = line.split('\t').collect::<Vec<_>>();
            headers
                .iter()
                .enumerate()
                .map(|(index, header)| {
                    (
                        (*header).to_owned(),
                        cells.get(index).copied().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .collect()
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct WikiArticleRecord {
    pub id: String,
    pub title: String,
    #[serde(default, rename = "treePath", alias = "tree_path")]
    pub tree_path: Vec<String>,
    #[serde(rename = "outputPath", alias = "output_path")]
    pub output_path: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ApiSymbolRecord {
    pub family: String,
    pub name: String,
    #[serde(default, rename = "bucketPath", alias = "bucket_path")]
    pub bucket_path: Vec<String>,
    #[serde(rename = "sourcePath", alias = "source_path")]
    pub source_path: String,
    #[serde(rename = "outputPath", alias = "output_path")]
    pub output_path: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct WikiArticleIndexRow {
    pub id: String,
    pub title: String,
    pub wiki_path: String,
    pub url: String,
    pub file: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ApiSymbolIndexRow {
    pub kind: String,
    pub name: String,
    pub symbol_path: String,
    pub source_json_path: String,
    pub source_json_url: String,
    pub markdown_file: String,
    pub description: String,
}

impl WikiArticleIndexRow {
    pub fn to_tsv_row(&self) -> TsvRow {
        [
            ("id".to_owned(), self.id.clone()),
            ("title".to_owned(), self.title.clone()),
            ("wiki_path".to_owned(), self.wiki_path.clone()),
            ("url".to_owned(), self.url.clone()),
            ("file".to_owned(), self.file.clone()),
        ]
        .into_iter()
        .collect()
    }
}

impl ApiSymbolIndexRow {
    pub fn to_tsv_row(&self) -> TsvRow {
        [
            ("kind".to_owned(), self.kind.clone()),
            ("name".to_owned(), self.name.clone()),
            ("symbol_path".to_owned(), self.symbol_path.clone()),
            ("source_json_path".to_owned(), self.source_json_path.clone()),
            ("source_json_url".to_owned(), self.source_json_url.clone()),
            ("markdown_file".to_owned(), self.markdown_file.clone()),
            ("description".to_owned(), self.description.clone()),
        ]
        .into_iter()
        .collect()
    }
}

pub fn build_wiki_article_index_rows(articles: &[WikiArticleRecord]) -> Vec<WikiArticleIndexRow> {
    articles
        .iter()
        .map(|article| WikiArticleIndexRow {
            id: article.id.clone(),
            title: article.title.clone(),
            wiki_path: article.tree_path.join(" / "),
            url: format!("{WIKI_BASE_URL}/{}", article.id),
            file: article.output_path.clone(),
        })
        .collect()
}

pub fn build_api_symbol_index_rows(records: &[ApiSymbolRecord]) -> Vec<ApiSymbolIndexRow> {
    records
        .iter()
        .map(|record| {
            let mut path = record.bucket_path.join(" / ");
            if !path.is_empty() {
                path.push_str(" / ");
            }
            path.push_str(&record.name);
            ApiSymbolIndexRow {
                kind: record.family.clone(),
                name: record.name.clone(),
                symbol_path: path,
                source_json_path: record.source_path.clone(),
                source_json_url: format!("{API_BASE_URL}/{}", record.source_path),
                markdown_file: record.output_path.clone(),
                description: record.description.clone(),
            }
        })
        .collect()
}

pub fn render_wiki_article_index(rows: &[WikiArticleIndexRow]) -> String {
    let tsv_rows = rows
        .iter()
        .map(WikiArticleIndexRow::to_tsv_row)
        .collect::<Vec<_>>();
    render_tsv(&["id", "title", "wiki_path", "url", "file"], &tsv_rows)
}

pub fn render_api_symbol_index(rows: &[ApiSymbolIndexRow]) -> String {
    let tsv_rows = rows
        .iter()
        .map(ApiSymbolIndexRow::to_tsv_row)
        .collect::<Vec<_>>();
    render_tsv(
        &[
            "kind",
            "name",
            "symbol_path",
            "source_json_path",
            "source_json_url",
            "markdown_file",
            "description",
        ],
        &tsv_rows,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_whitespace_and_tabs() {
        assert_eq!(escape_tsv_cell("  a\t b\r\nc  "), "a b c");
    }

    #[test]
    fn renders_and_parses_rows() {
        let mut row = TsvRow::new();
        row.insert("name".into(), "Thing\tOne".into());
        row.insert("kind".into(), "class".into());
        let text = render_tsv(&["kind", "name"], &[row]);
        assert_eq!(text, "kind\tname\nclass\tThing One\n");
        let parsed = parse_tsv(&text);
        assert_eq!(parsed[0]["name"], "Thing One");
    }

    #[test]
    fn builds_index_urls_and_paths() {
        let wiki = build_wiki_article_index_rows(&[WikiArticleRecord {
            id: "7".into(),
            title: "Intro".into(),
            tree_path: vec!["Guide".into(), "Start".into()],
            output_path: "docs/wiki/007_intro.md".into(),
        }]);
        assert_eq!(wiki[0].wiki_path, "Guide / Start");
        assert_eq!(
            wiki[0].url,
            "https://developer.gp.qq.com/wikieditor/#/catalog/7"
        );

        let api = build_api_symbol_index_rows(&[ApiSymbolRecord {
            family: "class".into(),
            name: "Actor".into(),
            bucket_path: vec!["Engine".into()],
            source_path: "class/Actor.json".into(),
            output_path: "docs/api/class/Actor.md".into(),
            description: "base".into(),
        }]);
        assert_eq!(api[0].symbol_path, "Engine / Actor");
        assert_eq!(
            api[0].source_json_url,
            "https://developer.gp.qq.com/api/class/Actor.json"
        );
    }
}
