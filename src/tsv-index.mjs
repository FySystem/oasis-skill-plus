const API_BASE_URL = 'https://developer.gp.qq.com/api';
const WIKI_BASE_URL = 'https://developer.gp.qq.com/wikieditor/#/catalog';

export function escapeTsvCell(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderTsv(headers, rows) {
  const lines = [
    headers.join('\t'),
    ...rows.map((row) => headers.map((header) => escapeTsvCell(row[header])).join('\t'))
  ];

  return `${lines.join('\n')}\n`;
}

export function parseTsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

export function buildWikiArticleIndexRows(articles) {
  return articles.map((article) => ({
    id: String(article.id),
    title: article.title,
    wiki_path: (article.treePath ?? []).join(' / '),
    url: `${WIKI_BASE_URL}/${article.id}`,
    file: article.outputPath
  }));
}

export function buildApiSymbolIndexRows(records) {
  return records.map((record) => ({
    kind: record.family,
    name: record.name,
    symbol_path: [...(record.bucketPath ?? []), record.name].join(' / '),
    source_json_path: record.sourcePath,
    source_json_url: `${API_BASE_URL}/${record.sourcePath}`,
    markdown_file: record.outputPath,
    description: record.description ?? ''
  }));
}
