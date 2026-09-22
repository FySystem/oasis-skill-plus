use regex::Regex;
use sha1::{Digest as Sha1Digest, Sha1};
use std::collections::{HashMap, HashSet};
use url::Url;

/// Replace characters that cannot safely occur in a Windows path segment.
pub fn sanitize_path_segment(input: impl AsRef<str>) -> String {
    let mut out = String::new();
    for c in input.as_ref().chars() {
        let invalid =
            matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control();
        if invalid {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = out.trim().trim_matches(|c| c == '.' || c == ' ').to_owned();
    if out.is_empty() {
        "未命名".to_owned()
    } else {
        out
    }
}

pub fn build_article_file_name(id: impl AsRef<str>, title: impl AsRef<str>) -> String {
    format!("{}_{}.md", id.as_ref(), sanitize_path_segment(title))
}

pub fn build_image_file_name(image_url: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(image_url.as_bytes());
    let hash = hex::encode(hasher.finalize());
    let hash = &hash[..8];
    let candidate = Url::parse(image_url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|mut s| s.next_back())
                .map(str::to_owned)
        })
        .and_then(|s| {
            percent_encoding::percent_decode_str(&s)
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image.png".to_owned());
    let mut file_name = sanitize_path_segment(candidate);
    if !file_name.contains('.') {
        file_name.push_str(".png");
    }
    format!("{}_{}", hash, file_name)
}

/// Compute a portable Markdown relative path. Input paths use `/` separators.
pub fn relative_markdown_path(from_file: &str, to_file: &str) -> String {
    let from_dir: Vec<&str> = from_file.split('/').collect();
    let from_dir = &from_dir[..from_dir.len().saturating_sub(1)];
    let target: Vec<&str> = to_file.split('/').filter(|s| !s.is_empty()).collect();
    let mut common = 0;
    while common < from_dir.len() && common < target.len() && from_dir[common] == target[common] {
        common += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in common..from_dir.len() {
        parts.push("..".to_owned());
    }
    parts.extend(target[common..].iter().map(|s| (*s).to_owned()));
    if parts.is_empty() {
        return "./".to_owned();
    }
    let result = parts.join("/");
    if result.starts_with('.') {
        result
    } else {
        format!("./{result}")
    }
}

pub fn normalize_markdown(body: impl AsRef<str>) -> String {
    let mut s = body
        .as_ref()
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let br = Regex::new(r"(?im)^[ \t]*<br\s*/?>[ \t]*$").unwrap();
    s = br.replace_all(&s, "").into_owned();
    let trailing = Regex::new(r"[ \t]+\n").unwrap();
    s = trailing.replace_all(&s, "\n").into_owned();
    let many = Regex::new(r"\n{3,}").unwrap();
    many.replace_all(&s, "\n\n").trim_end().to_owned()
}

fn find_matching_paren(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (idx, ch) in text[open..].char_indices() {
        let at = open + idx;
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                return Some(at);
            }
        }
    }
    None
}

fn transform_markdown_images<F>(body: &str, mut transform: F) -> String
where
    F: FnMut(&str, &str, &str) -> String,
{
    let mut cursor = 0;
    let mut output = String::with_capacity(body.len());
    while cursor < body.len() {
        let Some(rel) = body[cursor..].find("![") else {
            output.push_str(&body[cursor..]);
            break;
        };
        let start = cursor + rel;
        let Some(alt_rel) = body[start..].find("](") else {
            output.push_str(&body[cursor..]);
            break;
        };
        let alt_end = start + alt_rel;
        let open = alt_end + 1;
        let Some(close) = find_matching_paren(body, open) else {
            output.push_str(&body[cursor..]);
            break;
        };
        let alt = &body[start + 2..alt_end];
        let target = body[open + 1..close].trim();
        output.push_str(&body[cursor..start]);
        output.push_str(&transform(&body[start..=close], alt, target));
        cursor = close + 1;
    }
    output
}

pub fn collect_image_urls(body: impl AsRef<str>) -> Vec<String> {
    let body = body.as_ref();
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    transform_markdown_images(body, |full, _, target| {
        if (target.starts_with("http://") || target.starts_with("https://"))
            && seen.insert(target.to_owned())
        {
            urls.push(target.to_owned());
        }
        full.to_owned()
    });
    let html = Regex::new(
        r#"(?is)<img\b([^>]*?)src=(?:"(https?://[^"<>]+)"|'(https?://[^'<>]+)')([^>]*)>"#,
    )
    .unwrap();
    for caps in html.captures_iter(body) {
        let url = caps.get(2).or_else(|| caps.get(3)).unwrap().as_str();
        if seen.insert(url.to_owned()) {
            urls.push(url.to_owned());
        }
    }
    urls
}

pub fn rewrite_official_wiki_links(
    body: impl AsRef<str>,
    output_path: &str,
    article_paths: &HashMap<String, String>,
) -> String {
    let re = Regex::new(r"https?://developer\.gp\.qq\.com/wikieditor/?(?:\?[^#)\s]*)?#/catalog/(\d+)(?:\?([^)\s#]+))?").unwrap();
    re.replace_all(body.as_ref(), |caps: &regex::Captures| {
        let id = caps.get(1).unwrap().as_str();
        let Some(target) = article_paths.get(id) else {
            return caps.get(0).unwrap().as_str().to_owned();
        };
        let mut href = relative_markdown_path(output_path, target);
        if let Some(query) = caps.get(2) {
            for (key, value) in url::form_urlencoded::parse(query.as_str().as_bytes()) {
                if key == "autoJump" {
                    href.push('#');
                    href.push_str(&value);
                    break;
                }
            }
        }
        href
    })
    .into_owned()
}

pub fn rewrite_image_links(
    body: impl AsRef<str>,
    output_path: &str,
    image_paths: &HashMap<String, String>,
) -> String {
    let mut rewritten = transform_markdown_images(body.as_ref(), |full, alt, target| {
        image_paths
            .get(target)
            .map(|local| format!("![{alt}]({})", relative_markdown_path(output_path, local)))
            .unwrap_or_else(|| full.to_owned())
    });
    let html = Regex::new(
        r#"(?is)<img\b([^>]*?)src=(?:"(https?://[^"<>]+)"|'(https?://[^'<>]+)')([^>]*)>"#,
    )
    .unwrap();
    rewritten = html
        .replace_all(&rewritten, |caps: &regex::Captures| {
            let url_match = caps.get(2).or_else(|| caps.get(3)).unwrap();
            let url = url_match.as_str();
            image_paths
                .get(url)
                .map(|local| {
                    let quote = if caps.get(2).is_some() { '"' } else { '\'' };
                    format!(
                        "<img{}src={}{}{}{}>",
                        caps.get(1).unwrap().as_str(),
                        quote,
                        relative_markdown_path(output_path, local),
                        quote,
                        caps.get(4).unwrap().as_str()
                    )
                })
                .unwrap_or_else(|| caps.get(0).unwrap().as_str().to_owned())
        })
        .into_owned();
    rewritten
}

pub fn rewrite_markdown_content(
    body: impl AsRef<str>,
    output_path: &str,
    article_paths: &HashMap<String, String>,
    image_paths: &HashMap<String, String>,
) -> (String, Vec<String>) {
    let normalized = normalize_markdown(body);
    let linked = rewrite_official_wiki_links(&normalized, output_path, article_paths);
    let urls = collect_image_urls(&linked);
    let localized = rewrite_image_links(&linked, output_path, image_paths);
    let out = if localized.ends_with('\n') {
        localized
    } else {
        format!("{localized}\n")
    };
    (out, urls)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sanitize_and_names() {
        assert_eq!(
            sanitize_path_segment("  技能:Task?查询*手册.  "),
            "技能_Task_查询_手册"
        );
        assert_eq!(sanitize_path_segment("..."), "未命名");
        assert_eq!(
            build_article_file_name("20094", "商业化系统"),
            "20094_商业化系统.md"
        );
    }
    #[test]
    fn links_and_images() {
        let body = "查看 [属性绑定](https://developer.gp.qq.com/wikieditor/#/catalog/20108)\n![图](https://example.com/a%20(2).png)";
        let mut articles = HashMap::new();
        articles.insert("20108".into(), "docs/wiki/x/20108_属性.md".into());
        let mut images = HashMap::new();
        images.insert(
            "https://example.com/a%20(2).png".into(),
            "docs/wiki/_assets/images/a.png".into(),
        );
        let (out, urls) = rewrite_markdown_content(body, "docs/wiki/x/1.md", &articles, &images);
        assert!(out.contains("./20108_属性.md"));
        assert!(out.contains("../_assets/images/a.png"));
        assert_eq!(urls.len(), 1);
    }
}
