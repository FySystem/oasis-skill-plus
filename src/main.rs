use anyhow::{anyhow, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use oasis_skill_plus::{
    api::{ApiHttpClient, WikiHttpClient, DEFAULT_API_BASE_URL, DEFAULT_WIKI_BASE_URL},
    api_sync::{get_default_api_detail_concurrency, sync_api, ApiSyncOptions, ApiSyncResult},
    search::{create_search_error, error_as_json, format_result, run_docs_query, SearchOptions},
    sync::{sync_wiki, SyncOptions, SyncResult},
};
use std::{path::PathBuf, process::ExitCode, sync::Arc, time::Instant};
mod progress;
use progress::Reporter;

#[derive(Debug, Parser)]
#[command(
    name = "oasis-skill-plus",
    version,
    about = "绿洲官方 Wiki/API 同步与本地检索工具"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(name = "sync")]
    Sync(SyncCommand),
    #[command(name = "sync-api")]
    SyncApi(SyncApiCommand),
    #[command(name = "sync-all")]
    SyncAll(SyncAllCommand),
    #[command(name = "query")]
    Query(QueryCommand),
}

#[derive(Debug, Args, Clone)]
struct SyncCommand {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = DEFAULT_WIKI_BASE_URL)]
    base_url: String,
    #[arg(long, default_value_t = 16)]
    article_concurrency: usize,
    #[arg(long, default_value_t = 24)]
    image_concurrency: usize,
}

#[derive(Debug, Args, Clone)]
struct SyncApiCommand {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = DEFAULT_API_BASE_URL)]
    base_url: String,
    #[arg(long, default_value_t = get_default_api_detail_concurrency())]
    detail_concurrency: usize,
}

#[derive(Debug, Args, Clone)]
struct SyncAllCommand {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = DEFAULT_WIKI_BASE_URL)]
    wiki_base_url: String,
    #[arg(long, default_value = DEFAULT_API_BASE_URL)]
    api_base_url: String,
    #[arg(long, default_value_t = 16)]
    article_concurrency: usize,
    #[arg(long, default_value_t = 24)]
    image_concurrency: usize,
    #[arg(long, default_value_t = get_default_api_detail_concurrency())]
    detail_concurrency: usize,
}

#[derive(Debug, Clone, ValueEnum, PartialEq, Eq)]
enum QueryFormat {
    Json,
    Text,
}

#[derive(Debug, Args, Clone)]
struct QueryCommand {
    #[arg(long, default_value = ".")]
    project_root: PathBuf,
    #[arg(long, default_value = "all")]
    scope: String,
    #[arg(long, default_value = "search")]
    mode: String,
    #[arg(long)]
    query: String,
    #[arg(long, default_value_t = 20)]
    limit: usize,
    #[arg(long, value_enum, default_value_t = QueryFormat::Json)]
    format: QueryFormat,
    #[arg(long)]
    family: Option<String>,
    #[arg(long)]
    exact: bool,
}

fn format_duration(duration_ms: u128) -> String {
    let tenths = duration_ms.saturating_add(50) / 100;
    if tenths < 600 {
        if tenths.is_multiple_of(10) {
            return format!("{}秒", tenths / 10);
        }
        return format!("{:.1}秒", tenths as f64 / 10.0);
    }
    let hours = tenths / 36_000;
    let remaining = tenths % 36_000;
    let minutes = remaining / 600;
    let seconds = remaining % 600;
    let mut parts = Vec::new();
    if hours > 0 {
        parts.push(format!("{hours}小时"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}分"));
    }
    if seconds > 0 || parts.is_empty() {
        parts.push(format_duration(seconds * 100));
    }
    parts.join(" ")
}

fn print_wiki_summary(result: &SyncResult) {
    println!("Wiki 同步完成。");
    println!(
        "  词条数：{:<4}  新增：{}  更新：{}  删除：{}  耗时：{}",
        result.total_articles,
        result.created_count,
        result.updated_count,
        result.deleted_count,
        format_duration(result.duration_ms)
    );
    println!("  下载图片：{}", result.images_downloaded);
}

fn print_api_summary(result: &ApiSyncResult) {
    println!("API 同步完成。");
    println!(
        "  实体数：{:<4}  新增：{}  更新：{}  删除：{}  耗时：{}",
        result.total_entities,
        result.created_count,
        result.updated_count,
        result.deleted_count,
        format_duration(result.duration_ms)
    );
}

fn validate_query_directories(
    options: &SearchOptions,
    repo_root: &std::path::Path,
) -> std::result::Result<(), oasis_skill_plus::SearchError> {
    let scopes: Vec<&str> = if options.mode == "verify-api" {
        vec!["api"]
    } else if options.scope == "all" {
        vec!["api", "wiki"]
    } else {
        vec![options.scope.as_str()]
    };
    for scope in scopes {
        let expected = repo_root.join("docs").join(scope);
        if !expected.is_dir() {
            return Err(create_search_error(
                "DOCS_SCOPE_MISSING",
                format!(
                    "Expected docs/{scope} to exist under {}.",
                    repo_root.display()
                ),
            ));
        }
    }
    Ok(())
}

async fn run_command(command: Command) -> Result<()> {
    match command {
        Command::Sync(args) => {
            let reporter = Reporter::new(false);
            let result = sync_wiki(
                Arc::new(WikiHttpClient::new(args.base_url)),
                SyncOptions {
                    root_dir: args.root,
                    article_concurrency: args.article_concurrency,
                    image_concurrency: args.image_concurrency,
                },
                Some(Reporter::wiki_callback(&reporter)),
            )
            .await;
            reporter.lock().unwrap().end();
            let result = result?;
            print_wiki_summary(&result);
        }
        Command::SyncApi(args) => {
            let reporter = Reporter::new(false);
            let result = sync_api(
                Arc::new(ApiHttpClient::new(args.base_url)),
                ApiSyncOptions {
                    root_dir: args.root,
                    detail_concurrency: args.detail_concurrency,
                },
                Some(Reporter::api_callback(&reporter)),
            )
            .await;
            reporter.lock().unwrap().end();
            let result = result?;
            print_api_summary(&result);
        }
        Command::SyncAll(args) => {
            let reporter = Reporter::new(true);
            let started = Instant::now();
            let wiki = sync_wiki(
                Arc::new(WikiHttpClient::new(args.wiki_base_url)),
                SyncOptions {
                    root_dir: args.root.clone(),
                    article_concurrency: args.article_concurrency,
                    image_concurrency: args.image_concurrency,
                },
                Some(Reporter::wiki_callback(&reporter)),
            );
            let api = sync_api(
                Arc::new(ApiHttpClient::new(args.api_base_url)),
                ApiSyncOptions {
                    root_dir: args.root,
                    detail_concurrency: args.detail_concurrency,
                },
                Some(Reporter::api_callback(&reporter)),
            );
            let (wiki_result, api_result) = tokio::join!(wiki, api);
            reporter.lock().unwrap().end();
            println!();
            if let Ok(result) = &wiki_result {
                print_wiki_summary(result);
            }
            if let Ok(result) = &api_result {
                print_api_summary(result);
            }
            let errors: Vec<String> = [wiki_result.err(), api_result.err()]
                .into_iter()
                .flatten()
                .map(|error| format!("{error:#}"))
                .collect();
            if !errors.is_empty() {
                return Err(anyhow!(errors.join("；")));
            }
            println!(
                "全部同步完成。 总耗时：{}",
                format_duration(started.elapsed().as_millis())
            );
        }
        Command::Query(args) => {
            if args.query.trim().is_empty() {
                return Err(anyhow!("--query 不能为空"));
            }
            if args.limit == 0 {
                return Err(anyhow!("--limit 必须大于 0"));
            }
            let options = SearchOptions {
                project_root: args.project_root,
                mode: args.mode,
                scope: args.scope,
                format: match args.format {
                    QueryFormat::Json => "json".into(),
                    QueryFormat::Text => "text".into(),
                },
                query: args.query,
                family: args.family,
                limit: args.limit,
                exact: args.exact,
            };
            match run_docs_query(&options) {
                Ok(payload) => {
                    if let Err(error) = validate_query_directories(
                        &options,
                        std::path::Path::new(&payload.oasis_repo_root),
                    ) {
                        println!("{}", error_as_json(&error)?);
                        return Err(anyhow!(error.to_string()));
                    }
                    println!("{}", format_result(&payload)?);
                }
                Err(error) => {
                    if options.format == "json" {
                        println!("{}", error_as_json(&error)?);
                    }
                    return Err(anyhow!(error.to_string()));
                }
            }
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run_command(cli.command).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("错误：{error:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display_width(text: &str) -> usize {
        text.chars()
            .map(|character| usize::from(character > '\u{00ff}') + 1)
            .sum()
    }

    #[test]
    fn progress_line_keeps_the_legacy_label_column_width() {
        let line = progress::format_progress_line(1, 4, "正在抓取词条", 5, 10);
        let bar_start = line
            .find('[')
            .and_then(|start| line[start + 1..].find('[').map(|offset| start + 1 + offset))
            .unwrap();
        assert_eq!(display_width(&line[..bar_start]), 33);
        assert!(line.ends_with("    5/  10 ( 50%)"));
    }

    #[test]
    fn duration_matches_the_legacy_rounding() {
        assert_eq!(format_duration(1_250), "1.3秒");
        assert_eq!(format_duration(60_000), "1分");
        assert_eq!(format_duration(61_000), "1分 1秒");
    }
}
