import crypto from 'node:crypto';
import path from 'node:path';

const WINDOWS_INVALID_SEGMENT_PATTERN = /[<>:"/\\|?*\u0000-\u001f]/g;
const HTML_IMAGE_PATTERN = /<img\b([^>]*?)src=(["'])(https?:\/\/[^"'<>]+)\2([^>]*)>/gi;
const OFFICIAL_WIKI_URL_PATTERN =
  /https?:\/\/developer\.gp\.qq\.com\/wikieditor\/?(?:\?[^#)\s]*)?#\/catalog\/(\d+)(?:\?([^)\s#]+))?/g;

function findMatchingParen(text, openParenIndex) {
  let depth = 0;

  for (let index = openParenIndex; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
      continue;
    }

    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function transformMarkdownImageLinks(body, transformer) {
  let cursor = 0;
  let output = '';

  while (cursor < body.length) {
    const imageStart = body.indexOf('![', cursor);
    if (imageStart === -1) {
      output += body.slice(cursor);
      break;
    }

    const altEnd = body.indexOf('](', imageStart);
    if (altEnd === -1) {
      output += body.slice(cursor);
      break;
    }

    const openParenIndex = altEnd + 1;
    const closeParenIndex = findMatchingParen(body, openParenIndex);
    if (closeParenIndex === -1) {
      output += body.slice(cursor);
      break;
    }

    const altText = body.slice(imageStart + 2, altEnd);
    const target = body.slice(openParenIndex + 1, closeParenIndex).trim();

    output += body.slice(cursor, imageStart);
    output += transformer({
      fullMatch: body.slice(imageStart, closeParenIndex + 1),
      altText,
      target
    });
    cursor = closeParenIndex + 1;
  }

  return output;
}

export function sanitizePathSegment(input) {
  const normalized = String(input ?? '')
    .replace(WINDOWS_INVALID_SEGMENT_PATTERN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/g, '');

  return normalized || '未命名';
}

export function buildArticleFileName(id, title) {
  return `${String(id)}_${sanitizePathSegment(title)}.md`;
}

export function buildImageFileName(url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  let fileName = 'image.png';

  try {
    const parsedUrl = new URL(url);
    const candidate = decodeURIComponent(path.posix.basename(parsedUrl.pathname));
    fileName = candidate || fileName;
  } catch {
    fileName = 'image.png';
  }

  fileName = sanitizePathSegment(fileName);
  if (!path.posix.extname(fileName)) {
    fileName = `${fileName}.png`;
  }

  return `${hash}_${fileName}`;
}

export function relativeMarkdownPath(fromFile, toFile) {
  const relativePath = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
  if (relativePath.startsWith('.')) {
    return relativePath;
  }

  return `./${relativePath}`;
}

export function normalizeMarkdown(body) {
  return String(body ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function collectImageUrls(body) {
  const urls = [];
  const seen = new Set();
  const normalizedBody = String(body ?? '');

  transformMarkdownImageLinks(normalizedBody, ({ fullMatch, target }) => {
    if (/^https?:\/\//i.test(target) && !seen.has(target)) {
      seen.add(target);
      urls.push(target);
    }

    return fullMatch;
  });

  let match;
  HTML_IMAGE_PATTERN.lastIndex = 0;
  while ((match = HTML_IMAGE_PATTERN.exec(normalizedBody)) !== null) {
    const url = match[3];
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

export function rewriteOfficialWikiLinks(body, outputPath, articlePathById) {
  const normalizedBody = String(body ?? '');

  return normalizedBody.replace(OFFICIAL_WIKI_URL_PATTERN, (fullMatch, articleId, queryString = '') => {
    const targetPath = articlePathById.get(String(articleId));
    if (!targetPath) {
      return fullMatch;
    }

    let localHref = relativeMarkdownPath(outputPath, targetPath);
    const params = new URLSearchParams(queryString);
    const autoJump = params.get('autoJump');

    if (autoJump) {
      localHref += `#${decodeURIComponent(autoJump)}`;
    }

    return localHref;
  });
}

export function rewriteImageLinks(body, outputPath, imagePathByUrl) {
  let rewrittenBody = transformMarkdownImageLinks(String(body ?? ''), ({ fullMatch, altText, target }) => {
    const localPath = imagePathByUrl.get(target);
    if (!localPath) {
      return fullMatch;
    }

    return `![${altText}](${relativeMarkdownPath(outputPath, localPath)})`;
  });

  rewrittenBody = rewrittenBody.replace(
    HTML_IMAGE_PATTERN,
    (fullMatch, beforeSrc, quote, imageUrl, afterSrc) => {
      const localPath = imagePathByUrl.get(imageUrl);
      if (!localPath) {
        return fullMatch;
      }

      return `<img${beforeSrc}src=${quote}${relativeMarkdownPath(outputPath, localPath)}${quote}${afterSrc}>`;
    }
  );

  return rewrittenBody;
}

export function rewriteMarkdownContent({ body, outputPath, articlePathById, imagePathByUrl }) {
  const normalized = normalizeMarkdown(body);
  const linked = rewriteOfficialWikiLinks(normalized, outputPath, articlePathById);
  const imageUrls = collectImageUrls(linked);
  const localized = rewriteImageLinks(linked, outputPath, imagePathByUrl);

  return {
    body: localized.endsWith('\n') ? localized : `${localized}\n`,
    imageUrls
  };
}
