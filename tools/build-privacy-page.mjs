// Generate a script-free public policy page from the two canonical Markdown policies.
import { fromMarkdown } from '../extension/node_modules/mdast-util-from-markdown/index.js';
import { readFile, writeFile } from 'node:fs/promises';

const docs = new URL('../docs/', import.meta.url);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function render(node) {
  const children = () => (node.children ?? []).map(render).join('');
  switch (node.type) {
    case 'root': return children();
    case 'text': return escape(node.value);
    case 'paragraph': return `<p>${children()}</p>`;
    case 'heading': return `<h${node.depth}>${children()}</h${node.depth}>`;
    case 'strong': return `<strong>${children()}</strong>`;
    case 'emphasis': return `<em>${children()}</em>`;
    case 'inlineCode': return `<code>${escape(node.value)}</code>`;
    case 'list': return `<${node.ordered ? 'ol' : 'ul'}>${children()}</${node.ordered ? 'ol' : 'ul'}>`;
    case 'listItem': return `<li>${children()}</li>`;
    case 'link': {
      let url = node.url;
      if (url === 'privacy.en.md') url = '#english';
      else if (url === 'privacy.md') url = '#chinese';
      else if (!/^(https:\/\/|mailto:)/.test(url)) url = `https://github.com/AiYeyeye/smartSave/blob/HEAD/docs/${url}`;
      return `<a href="${escape(url)}">${children()}</a>`;
    }
    default: throw new Error(`Unsupported policy Markdown: ${node.type}`);
  }
}
const zh = render(fromMarkdown(await readFile(new URL('privacy.md', docs), 'utf8')));
const en = render(fromMarkdown(await readFile(new URL('privacy.en.md', docs), 'utf8')));
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="智栏 Zhilan privacy policy — bookmarks, user-configured AI, local storage and your controls.">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>智栏 Zhilan · 隐私政策 / Privacy Policy</title>
<style>html{scroll-behavior:smooth}body{margin:0;background:#f4f5f7;color:#17191e;font:16px/1.8 system-ui,'Microsoft YaHei',sans-serif}main{max-width:860px;margin:auto;padding:32px 24px 80px;background:white}nav{display:flex;gap:24px;border-bottom:1px solid #e5e7eb;padding-bottom:16px}h1{font-size:28px}h2{font-size:21px;margin-top:32px}a{color:#4141ad;overflow-wrap:anywhere}p,li{overflow-wrap:anywhere}code{background:#f0f1f4;padding:2px 4px}section+section{margin-top:72px;border-top:2px solid #e5e7eb;padding-top:24px}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}</style>
</head><body><main><nav aria-label="Language"><a href="#chinese">简体中文</a><a href="#english">English</a><a href="https://github.com/AiYeyeye/smartSave">GitHub</a></nav>
<section id="chinese" lang="zh-CN">${zh}</section><section id="english" lang="en">${en}</section>
</main></body></html>\n`;
await writeFile(new URL('privacy.html', docs), html);
console.log('docs/privacy.html generated; no deployment performed.');
