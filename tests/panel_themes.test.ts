import assert from "node:assert/strict";
import {
  DEFAULT_PANEL_THEME_ID,
  PANEL_THEMES,
  findPanelTheme,
  isPanelThemeId,
} from "../src/lib/panel_themes";
import {
  renderMarkdown,
  wrapCodeForClipboard,
} from "../src/lib/markdown_renderer";

// --- registry ---------------------------------------------------------------

assert.equal(DEFAULT_PANEL_THEME_ID, "neon-log");
assert.equal(findPanelTheme(undefined).id, "neon-log", "по умолчанию — вариант 2");
assert.equal(findPanelTheme("unknown").id, "neon-log");
assert.equal(findPanelTheme("aurora").label, "Glass Aurora");
assert.equal(isPanelThemeId("frost"), true);
assert.equal(isPanelThemeId("nope"), false);

assert.ok(PANEL_THEMES.length >= 6, "должно быть минимум 6 тем для выбора");
assert.ok(
  PANEL_THEMES.some((theme) => theme.id === "neon-log" && theme.mode === "log"),
  "neon-log должен быть в режиме журнала",
);

const requiredApVars = [
  "--ap-bg0",
  "--ap-fg",
  "--ap-accent",
  "--ap-card-bg",
  "--ap-radius",
  "--ap-code-bg",
  "--ap-syn-keyword",
  "--ap-syn-string",
  "--ap-lang-json",
];

for (const theme of PANEL_THEMES) {
  for (const key of requiredApVars) {
    assert.ok(
      typeof theme.vars[key] === "string" && theme.vars[key].length > 0,
      `тема ${theme.id}: нет переменной ${key}`,
    );
  }
}

for (const theme of PANEL_THEMES.filter((item) => item.id !== "tabby")) {
  for (const key of ["--theme-bg", "--theme-fg", "--theme-primary", "--theme-primary-rgb", "--bs-success"]) {
    assert.ok(
      typeof theme.vars[key] === "string" && theme.vars[key].length > 0,
      `тема ${theme.id}: нет переменной ${key}`,
    );
  }
}

assert.equal(
  findPanelTheme("tabby").vars["--ap-bg0"],
  "var(--theme-bg)",
  "тема Tabby следует переменным терминала",
);

// --- wrap for clipboard -----------------------------------------------------

assert.equal(
  wrapCodeForClipboard('{\n  "a": 1\n}\n'),
  '```\n{\n  "a": 1\n}\n```',
);
assert.equal(wrapCodeForClipboard("Get-Date"), "```\nGet-Date\n```");

// --- markdown renderer ------------------------------------------------------

const rendered = renderMarkdown(
  "# Заголовок\n\n```json\n{\"service\": \"gateway\", \"port\": 8083}\n```\n\n```powershell\nGet-Service\n```",
);
assert.match(rendered, /class="codeblock"/);
assert.match(rendered, /class="code-copy"/);
assert.match(rendered, /data-lang="json"/);
assert.match(rendered, /class="hljs-keyword"|hljs-string/, "код должен быть подсвечен");
assert.match(rendered, /data-lang="powershell"/);
assert.match(rendered, /<h1>/);

const empty = renderMarkdown("");
assert.equal(empty, "");

console.log("panel_themes tests passed");
