import { normalizeMarkdown, relativeMarkdownPath } from './markdown.mjs';

function normalizeText(value) {
  return normalizeMarkdown(String(value ?? ''));
}

function escapeMarkdownTableCell(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br>')
    .trim();
}

function resolveReferenceTarget({
  name,
  redirect,
  outputPath,
  outputPathBySourcePath,
  uniqueOutputPathByName
}) {
  if (redirect && outputPathBySourcePath.has(redirect)) {
    return relativeMarkdownPath(outputPath, outputPathBySourcePath.get(redirect));
  }

  if (name && uniqueOutputPathByName.has(name)) {
    return relativeMarkdownPath(outputPath, uniqueOutputPathByName.get(name));
  }

  return null;
}

function renderInlineReference(options, codeStyle = true) {
  const label = String(options.name ?? '').trim();
  if (!label) {
    return '';
  }

  const target = resolveReferenceTarget(options);
  if (target) {
    return `[${label}](${target})`;
  }

  return codeStyle ? `\`${label}\`` : label;
}

function pushSection(lines, title, bodyLines) {
  lines.push(`## ${title}`);
  lines.push('');
  if (bodyLines.length === 0) {
    lines.push('_None_');
    lines.push('');
    return;
  }

  lines.push(...bodyLines);
  lines.push('');
}

function renderDescriptionBlock(text) {
  const normalized = normalizeText(text);
  return normalized ? [normalized, ''] : [];
}

function renderSimpleTable(headers, rows) {
  if (rows.length === 0) {
    return ['_None_'];
  }

  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownTableCell).join(' | ')} |`)
  ];
}

function renderClassMarkdown(context) {
  const { detail } = context;
  const lines = [`# ${detail.Name}`, ''];
  lines.push(...renderDescriptionBlock(detail.Description));

  pushSection(
    lines,
    'Parents',
    (detail.Parents ?? []).map((parent) => `- ${renderInlineReference({ ...context, name: parent }, false)}`)
  );

  pushSection(
    lines,
    'Variables',
    renderSimpleTable(
      ['Name', 'Type', 'Description'],
      (detail.Variables ?? []).map((item) => [
        item.Name,
        renderInlineReference({
          ...context,
          name: item.Type,
          redirect: item.Redirect
        }),
        normalizeText(item.Description)
      ])
    )
  );

  const functionLines = [];
  for (const item of detail.Functions ?? []) {
    functionLines.push(`### ${item.Name}`);
    functionLines.push('');
    const description = normalizeText(item.Description);
    if (description) {
      functionLines.push(description, '');
    }

    functionLines.push('**Parameters**', '');
    functionLines.push(
      ...renderSimpleTable(
        ['Name', 'Type', 'Description'],
        (item.Params ?? []).map((param) => [
          param.Name,
          renderInlineReference({
            ...context,
            name: param.Type,
            redirect: param.Redirect
          }),
          normalizeText(param.Description)
        ])
      )
    );
    functionLines.push('');
    functionLines.push('**Return**', '');
    if (item.Return) {
      functionLines.push(
        `- Type: ${renderInlineReference({
          ...context,
          name: item.Return.Type,
          redirect: item.Return.Redirect
        })}`
      );
      functionLines.push(`- Description: ${normalizeText(item.Return.Description) || '_None_'}`);
    } else {
      functionLines.push('_None_');
    }
    functionLines.push('');
  }
  pushSection(lines, 'Functions', functionLines);

  pushSection(
    lines,
    'Event',
    renderSimpleTable(
      ['Name', 'Type', 'Description'],
      (detail.Event ?? []).map((item) => [
        item.Name,
        renderInlineReference({
          ...context,
          name: item.Type,
          redirect: item.Redirect
        }),
        normalizeText(item.Description)
      ])
    )
  );

  pushSection(
    lines,
    'Delegate',
    renderSimpleTable(
      ['Name', 'Type', 'Description'],
      (detail.Delegate ?? []).map((item) => [
        item.Name,
        renderInlineReference({
          ...context,
          name: item.Type,
          redirect: item.Redirect
        }),
        normalizeText(item.Description)
      ])
    )
  );

  pushSection(lines, 'Language', detail.Language ? [normalizeText(detail.Language)] : []);
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderEnumMarkdown(context) {
  const { detail } = context;
  const lines = [`# ${detail.Name}`, ''];
  lines.push(...renderDescriptionBlock(detail.Description));
  pushSection(
    lines,
    'Values',
    renderSimpleTable(
      ['Name', 'Value', 'Description'],
      (detail.Variables ?? []).map((item) => [item.Name, item.Value, normalizeText(item.Description)])
    )
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderStructMarkdown(context) {
  const { detail } = context;
  const lines = [`# ${detail.Name}`, ''];
  lines.push(...renderDescriptionBlock(detail.Description));
  pushSection(
    lines,
    'Fields',
    renderSimpleTable(
      ['Name', 'Type', 'Description'],
      (detail.Variables ?? []).map((item) => [
        item.Name,
        renderInlineReference({
          ...context,
          name: item.Type,
          redirect: item.Redirect
        }),
        normalizeText(item.Description)
      ])
    )
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderGlobalFunctionMarkdown(context) {
  const { detail } = context;
  const lines = [`# ${detail.Name}`, ''];
  lines.push(...renderDescriptionBlock(detail.Description));
  pushSection(
    lines,
    'Parameters',
    renderSimpleTable(
      ['Name', 'Type', 'Description'],
      (detail.Params ?? []).map((item) => [
        item.Name,
        renderInlineReference({
          ...context,
          name: item.Type,
          redirect: item.Redirect
        }),
        normalizeText(item.Description)
      ])
    )
  );

  const returnLines = [];
  if (detail.Return) {
    returnLines.push(
      `- Type: ${renderInlineReference({
        ...context,
        name: detail.Return.Type,
        redirect: detail.Return.Redirect
      })}`
    );
    returnLines.push(`- Description: ${normalizeText(detail.Return.Description) || '_None_'}`);
  }
  pushSection(lines, 'Return', returnLines);
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderApiMarkdown(context) {
  switch (context.family) {
    case 'class':
      return renderClassMarkdown(context);
    case 'cppenum':
      return renderEnumMarkdown(context);
    case 'cppstruct':
      return renderStructMarkdown(context);
    case 'globalfunc':
      return renderGlobalFunctionMarkdown(context);
    default:
      throw new Error(`Unsupported API family: ${context.family}`);
  }
}
