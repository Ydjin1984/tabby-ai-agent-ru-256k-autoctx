/**
 * Рендер Markdown для панели агента: GFM + подсветка синтаксиса highlight.js.
 *
 * Блоки кода оборачиваются в `figure.codeblock` с шапкой языка и кнопкой
 * копирования — панель ловит клик по `.code-copy` делегированием и копирует код,
 * обёрнутый в тройные кавычки (удобно вставлять в Telegram и т.п.).
 */

import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  json,
  xml,
  css,
  javascript,
  typescript,
  bash,
  powershell,
  python,
  yaml,
  sql,
  markdown,
  diff,
  ini,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

/** Псевдонимы языков из info-string к зарегистрированному языку. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ps: "powershell",
  ps1: "powershell",
  pwsh: "powershell",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  jsx: "javascript",
  node: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  yml: "yaml",
  html: "xml",
  htm: "xml",
  vue: "xml",
  svelte: "xml",
  svg: "xml",
  md: "markdown",
  toml: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
};

/** Человекочитаемые подписи для шапки блока кода. */
const LANGUAGE_LABELS: Record<string, string> = {
  json: "JSON",
  xml: "HTML / XML",
  css: "CSS",
  javascript: "JavaScript",
  typescript: "TypeScript",
  bash: "Shell",
  powershell: "PowerShell",
  python: "Python",
  yaml: "YAML",
  sql: "SQL",
  markdown: "Markdown",
  diff: "Diff",
  ini: "Config",
};

export function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/`/g, "");
}

function resolveLanguage(rawLang: string): string {
  const key = rawLang.toLowerCase();
  return LANGUAGE_ALIASES[key] ?? key;
}

function languageLabel(rawLang: string, resolved: string): string {
  const key = rawLang.toLowerCase();
  return LANGUAGE_LABELS[key] ?? LANGUAGE_LABELS[resolved] ?? (rawLang || "текст").toUpperCase();
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

marked.use({
  renderer: {
    code(code: string, infostring: string | undefined): string {
      const rawLang = (infostring ?? "").trim().split(/\s+/)[0];
      const resolved = resolveLanguage(rawLang);
      let highlighted: string;
      try {
        highlighted =
          resolved && hljs.getLanguage(resolved)
            ? hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
            : hljs.highlightAuto(code).value;
      } catch {
        highlighted = escapeHtml(code);
      }
      const display = escapeHtml(languageLabel(rawLang, resolved));
      const langAttr = escapeAttr(rawLang || "text");
      return (
        `<figure class="codeblock" data-lang="${langAttr}">` +
        `<figcaption class="code-head">` +
        `<span class="code-lang">${display}</span>` +
        `<button type="button" class="code-copy" data-copy="code">Копировать</button>` +
        `</figcaption>` +
        `<pre><code class="hljs">${highlighted}</code></pre>` +
        `</figure>`
      );
    },
  },
});

/** Markdown → HTML с подсветкой кода. Никогда не бросает. */
export function renderMarkdown(content: string): string {
  if (!content) {
    return "";
  }
  try {
    return marked.parse(content, { async: false }) as string;
  } catch (error) {
    console.error("Markdown parsing error:", error);
    return `<p>${escapeHtml(content)}</p>`;
  }
}

/**
 * Обёртка кода в тройные кавычки для копирования: вставленный текст сразу
 * распознаётся как блок кода в Telegram и большинстве чатов.
 */
export function wrapCodeForClipboard(code: string): string {
  const body = String(code ?? "").replace(/\n+$/, "");
  return `\`\`\`\n${body}\n\`\`\``;
}
