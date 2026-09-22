use crate::markdown::{normalize_markdown, relative_markdown_path};
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

#[derive(Debug, Clone)]
pub struct ApiMarkdownContext {
    pub family: String,
    pub detail: Value,
    pub output_path: String,
    /// 共享目录映射，避免大型 API 同步中每个详情任务复制完整目录。
    pub output_path_by_source_path: Arc<HashMap<String, String>>,
    pub unique_output_path_by_name: Arc<HashMap<String, String>>,
}
fn text(v: Option<&Value>) -> String {
    v.map(|x| {
        x.as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| x.to_string())
    })
    .unwrap_or_default()
}
fn field<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k)
}
fn normalize(v: Option<&Value>) -> String {
    normalize_markdown(text(v))
}
fn escape_cell(v: impl AsRef<str>) -> String {
    v.as_ref()
        .replace('\r', "")
        .replace('\n', "<br>")
        .replace('|', "\\|")
        .trim()
        .to_owned()
}
fn arr(v: Option<&Value>) -> Vec<&Value> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

fn resolve_target(ctx: &ApiMarkdownContext, name: &str, redirect: &str) -> Option<String> {
    if !redirect.is_empty() {
        if let Some(path) = ctx.output_path_by_source_path.get(redirect) {
            return Some(relative_markdown_path(&ctx.output_path, path));
        }
    }
    if !name.is_empty() {
        if let Some(path) = ctx.unique_output_path_by_name.get(name) {
            return Some(relative_markdown_path(&ctx.output_path, path));
        }
    }
    None
}
fn inline(ctx: &ApiMarkdownContext, name: &str, redirect: &str, code: bool) -> String {
    let name = name.trim();
    if name.is_empty() {
        return String::new();
    }
    resolve_target(ctx, name, redirect)
        .map(|p| format!("[{name}]({p})"))
        .unwrap_or_else(|| {
            if code {
                format!("`{name}`")
            } else {
                name.to_owned()
            }
        })
}
fn section(lines: &mut Vec<String>, title: &str, body: Vec<String>) {
    lines.push(format!("## {title}"));
    lines.push(String::new());
    if body.is_empty() {
        lines.push("_None_".to_owned());
        lines.push(String::new());
    } else {
        lines.extend(body);
        lines.push(String::new());
    }
}
fn desc(v: Option<&Value>) -> Vec<String> {
    let d = normalize(v);
    if d.is_empty() {
        vec![]
    } else {
        vec![d, String::new()]
    }
}
fn table(headers: &[&str], rows: Vec<Vec<String>>) -> Vec<String> {
    if rows.is_empty() {
        return vec!["_None_".into()];
    }
    let mut out = vec![
        format!("| {} |", headers.join(" | ")),
        format!(
            "| {} |",
            headers
                .iter()
                .map(|_| "---")
                .collect::<Vec<_>>()
                .join(" | ")
        ),
    ];
    out.extend(rows.into_iter().map(|r| {
        format!(
            "| {} |",
            r.into_iter()
                .map(escape_cell)
                .collect::<Vec<_>>()
                .join(" | ")
        )
    }));
    out
}
fn name(v: &Value) -> String {
    text(v.get("Name"))
}
fn typ(v: &Value) -> String {
    text(v.get("Type"))
}
fn redirect(v: &Value) -> String {
    text(v.get("Redirect"))
}

fn render_class(ctx: &ApiMarkdownContext) -> String {
    let d = &ctx.detail;
    let mut lines = vec![format!("# {}", name(d)), String::new()];
    lines.extend(desc(field(d, "Description")));
    let parents = arr(field(d, "Parents"))
        .into_iter()
        .map(|v| format!("- {}", inline(ctx, &text(Some(v)), "", false)))
        .collect();
    section(&mut lines, "Parents", parents);
    let vars = arr(field(d, "Variables"))
        .into_iter()
        .map(|v| {
            vec![
                name(v),
                inline(ctx, &typ(v), &redirect(v), true),
                normalize(v.get("Description")),
            ]
        })
        .collect();
    section(
        &mut lines,
        "Variables",
        table(&["Name", "Type", "Description"], vars),
    );
    let mut funcs = Vec::new();
    for item in arr(field(d, "Functions")) {
        funcs.push(format!("### {}", name(item)));
        funcs.push(String::new());
        let ds = normalize(item.get("Description"));
        if !ds.is_empty() {
            funcs.push(ds);
            funcs.push(String::new());
        }
        funcs.push("**Parameters**".into());
        funcs.push(String::new());
        let params = arr(item.get("Params"))
            .into_iter()
            .map(|v| {
                vec![
                    name(v),
                    inline(ctx, &typ(v), &redirect(v), true),
                    normalize(v.get("Description")),
                ]
            })
            .collect();
        funcs.extend(table(&["Name", "Type", "Description"], params));
        funcs.push(String::new());
        funcs.push("**Return**".into());
        funcs.push(String::new());
        if let Some(ret) = item.get("Return").filter(|v| !v.is_null()) {
            funcs.push(format!(
                "- Type: {}",
                inline(ctx, &typ(ret), &redirect(ret), true)
            ));
            funcs.push(format!(
                "- Description: {}",
                normalize(ret.get("Description")).if_empty_then("_None_")
            ));
        } else {
            funcs.push("_None_".into());
        }
        funcs.push(String::new());
    }
    section(&mut lines, "Functions", funcs);
    for (title, key) in [("Event", "Event"), ("Delegate", "Delegate")] {
        let rows = arr(field(d, key))
            .into_iter()
            .map(|v| {
                vec![
                    name(v),
                    inline(ctx, &typ(v), &redirect(v), true),
                    normalize(v.get("Description")),
                ]
            })
            .collect();
        section(
            &mut lines,
            title,
            table(&["Name", "Type", "Description"], rows),
        );
    }
    section(
        &mut lines,
        "Language",
        if field(d, "Language").is_some() {
            vec![normalize(field(d, "Language"))]
        } else {
            vec![]
        },
    );
    format!("{}\n", lines.join("\n").trim_end())
}
fn render_enum(ctx: &ApiMarkdownContext) -> String {
    let d = &ctx.detail;
    let mut l = vec![format!("# {}", name(d)), String::new()];
    l.extend(desc(field(d, "Description")));
    let rows = arr(field(d, "Variables"))
        .into_iter()
        .map(|v| {
            vec![
                name(v),
                text(v.get("Value")),
                normalize(v.get("Description")),
            ]
        })
        .collect();
    section(
        &mut l,
        "Values",
        table(&["Name", "Value", "Description"], rows),
    );
    format!("{}\n", l.join("\n").trim_end())
}
fn render_struct(ctx: &ApiMarkdownContext) -> String {
    let d = &ctx.detail;
    let mut l = vec![format!("# {}", name(d)), String::new()];
    l.extend(desc(field(d, "Description")));
    let rows = arr(field(d, "Variables"))
        .into_iter()
        .map(|v| {
            vec![
                name(v),
                inline(ctx, &typ(v), &redirect(v), true),
                normalize(v.get("Description")),
            ]
        })
        .collect();
    section(
        &mut l,
        "Fields",
        table(&["Name", "Type", "Description"], rows),
    );
    format!("{}\n", l.join("\n").trim_end())
}
fn render_global(ctx: &ApiMarkdownContext) -> String {
    let d = &ctx.detail;
    let mut l = vec![format!("# {}", name(d)), String::new()];
    l.extend(desc(field(d, "Description")));
    let rows = arr(field(d, "Params"))
        .into_iter()
        .map(|v| {
            vec![
                name(v),
                inline(ctx, &typ(v), &redirect(v), true),
                normalize(v.get("Description")),
            ]
        })
        .collect();
    section(
        &mut l,
        "Parameters",
        table(&["Name", "Type", "Description"], rows),
    );
    let mut ret = vec![];
    if let Some(r) = field(d, "Return").filter(|v| !v.is_null()) {
        ret.push(format!(
            "- Type: {}",
            inline(ctx, &typ(r), &redirect(r), true)
        ));
        ret.push(format!(
            "- Description: {}",
            normalize(r.get("Description")).if_empty_then("_None_")
        ));
    }
    section(&mut l, "Return", ret);
    format!("{}\n", l.join("\n").trim_end())
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

pub fn render_api_markdown(ctx: &ApiMarkdownContext) -> Result<String> {
    Ok(match ctx.family.as_str() {
        "class" => render_class(ctx),
        "cppenum" => render_enum(ctx),
        "cppstruct" => render_struct(ctx),
        "globalfunc" => render_global(ctx),
        _ => return Err(anyhow!("Unsupported API family: {}", ctx.family)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enum_render() {
        let c = ApiMarkdownContext {
            family: "cppenum".into(),
            detail: serde_json::json!({"Name":"AI_Phase","Variables":[{"Name":"Born","Value":"0","Description":"出生"}]}),
            output_path: "docs/api/cppenum/A/AI/AI_Phase.md".into(),
            output_path_by_source_path: Arc::new(HashMap::new()),
            unique_output_path_by_name: Arc::new(HashMap::new()),
        };
        let s = render_api_markdown(&c).unwrap();
        assert!(s.contains("## Values"));
        assert!(s.contains("| Born | 0 | 出生 |"));
    }
}
