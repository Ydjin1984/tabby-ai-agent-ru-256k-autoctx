import assert from "node:assert/strict";
import {
  decodeBingUrl,
  decodeDuckDuckGoUrl,
  decodeHtmlEntities,
  extractTitle,
  formatSearchResults,
  htmlToText,
  isSafePublicUrl,
  normalizeHttpUrl,
  parseBingResults,
  parseBraveResults,
  parseDuckDuckGo,
  parseMwmbl,
  stripHtml,
} from "../src/lib/web_client";

// --- entities ---------------------------------------------------------------

assert.equal(decodeHtmlEntities("a &amp; b &lt;c&gt; &quot;d&quot;"), 'a & b <c> "d"');
assert.equal(decodeHtmlEntities("&#1058;&#1077;&#1089;&#1090;"), "Тест");
assert.equal(decodeHtmlEntities("&hellip;&nbsp;&mdash;"), "\u2026 \u2014");
assert.equal(decodeHtmlEntities("&unknown;"), "&unknown;");

// --- strip / text -----------------------------------------------------------

assert.equal(stripHtml("<b>Привет</b> <i>мир</i>"), "Привет мир");
assert.equal(
  stripHtml("<script>evil()</script>безопасно"),
  "безопасно",
);

const text = htmlToText(
  "<html><head><style>.a{}</style></head><body><h1>Заголовок</h1><p>Первый абзац</p><ul><li>Один</li><li>Два</li></ul></body></html>",
);
assert.match(text, /Заголовок/);
assert.match(text, /Первый абзац/);
assert.match(text, /- Один/);
assert.ok(!text.includes("<"), "HTML-теги должны быть удалены");

assert.equal(extractTitle("<title>  Tabby  </title>"), "Tabby");

// --- url helpers ------------------------------------------------------------

assert.equal(
  decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Ftabby.sh%2F&rut=abc"),
  "https://tabby.sh/",
);
assert.equal(decodeDuckDuckGoUrl("https://tabby.sh/"), "https://tabby.sh/");
assert.equal(normalizeHttpUrl("tabby.sh"), "https://tabby.sh");
assert.equal(normalizeHttpUrl("//example.com/x"), "https://example.com/x");
assert.equal(normalizeHttpUrl("http://example.com"), "http://example.com");

// --- SSRF guard -------------------------------------------------------------

assert.equal(isSafePublicUrl("https://tabby.sh/"), true);
assert.equal(isSafePublicUrl("http://example.com"), true);
assert.equal(isSafePublicUrl("http://127.0.0.1/admin"), false);
assert.equal(isSafePublicUrl("http://localhost:8080"), false);
assert.equal(isSafePublicUrl("http://192.168.0.1"), false);
assert.equal(isSafePublicUrl("http://10.1.2.3"), false);
assert.equal(isSafePublicUrl("http://[::1]/"), false);
assert.equal(isSafePublicUrl("file:///etc/passwd"), false);
assert.equal(isSafePublicUrl("ftp://example.com"), false);
assert.equal(isSafePublicUrl("not a url"), false);

// --- DuckDuckGo parsing (html) ----------------------------------------------

const ddgHtml = `
<div class="result results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftabby.sh%2F">Tabby &amp; terminal</a></h2>
  <a class="result__snippet" href="https://tabby.sh/">A modern <b>terminal</b> app.</a>
</div>
<div class="result results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://github.com/Eugeny/tabby">GitHub — Tabby</a></h2>
  <a class="result__snippet" href="https://github.com/Eugeny/tabby">Source code.</a>
</div>
<div class="result results_links">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://tabby.sh/">Дубликат</a></h2>
  <a class="result__snippet" href="https://tabby.sh/">Duplicate.</a>
</div>`;

const htmlResults = parseDuckDuckGo(ddgHtml, 10);
assert.equal(htmlResults.length, 2, "дубликаты URL должны схлопываться");
assert.deepEqual(htmlResults[0], {
  title: "Tabby & terminal",
  url: "https://tabby.sh/",
  snippet: "A modern terminal app.",
});
assert.equal(htmlResults[1].url, "https://github.com/Eugeny/tabby");
assert.equal(htmlResults[1].snippet, "Source code.");

// --- DuckDuckGo parsing (lite) ----------------------------------------------

const liteHtml = `
<table>
  <tr><td>1.</td><td><a rel="nofollow" href="https://tabby.sh/" class='result-link'>Tabby - terminal</a></td></tr>
  <tr><td></td><td class='result-snippet'>Cross-platform terminal.</td></tr>
  <tr><td>2.</td><td><a rel="nofollow" href="https://example.com/doc" class='result-link'>Example Docs</a></td></tr>
  <tr><td></td><td class='result-snippet'>Some documentation.</td></tr>
</table>`;

const liteResults = parseDuckDuckGo(liteHtml, 5);
assert.equal(liteResults.length, 2);
assert.deepEqual(liteResults[0], {
  title: "Tabby - terminal",
  url: "https://tabby.sh/",
  snippet: "Cross-platform terminal.",
});
assert.equal(liteResults[1].snippet, "Some documentation.");

// --- limit ------------------------------------------------------------------

assert.equal(parseDuckDuckGo(ddgHtml, 1).length, 1);

// --- formatting -------------------------------------------------------------

const formatted = formatSearchResults("tabby", [
  { title: "Tabby", url: "https://tabby.sh/", snippet: "Terminal app." },
]);
assert.match(formatted, /tabby/);
assert.match(formatted, /1\. Tabby/);
assert.match(formatted, /URL: https:\/\/tabby\.sh\//);
assert.match(formatted, /Terminal app\./);

// --- Brave Search parsing (fallback engine) --------------------------------

const braveHtml = `
<div class="snippet" data-type="web">
  <a href="https://example.com/a" class="s l1">
    <cite class="snippet-url">example.com<span> &gt; a</span></cite>
    <div class="title search-snippet-title line-clamp-1" title="Example Title A">Example Title A</div>
  </a>
  <div class="generic-snippet"><div class="content">Some description A.</div></div>
</div>
<div class="snippet" data-type="web">
  <a href="https://example.org/b" class="s l1">
    <div class="title search-snippet-title" title="Example Title B">Example Title B</div>
  </a>
  <div class="generic-snippet"><div class="content">Some description B.</div></div>
</div>`;

const brave = parseBraveResults(braveHtml, 10);
assert.equal(brave.length, 2);
assert.deepEqual(brave[0], {
  title: "Example Title A",
  url: "https://example.com/a",
  snippet: "Some description A.",
});
assert.equal(brave[1].url, "https://example.org/b");
assert.match(brave[1].snippet, /description B/);

const nodeUrl = "https://nodejs.org/";
const bingToken = Buffer.from(nodeUrl).toString("base64");
assert.equal(
  decodeBingUrl(`https://www.bing.com/ck/a?&u=a1${bingToken}&ntb=1`),
  nodeUrl,
);

const bingHtml = `
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?&amp;u=a1${bingToken}&amp;ntb=1">Node.js</a></h2>
  <p class="b_lineclamp2">JavaScript runtime.</p>
</li>`;
const bing = parseBingResults(bingHtml, 5);
assert.equal(bing.length, 1);
assert.equal(bing[0].url, nodeUrl);
assert.equal(bing[0].title, "Node.js");
assert.match(bing[0].snippet, /JavaScript runtime/);
assert.equal(
  parseBingResults(`<h1>There are no results for <strong>x</strong></h1><li class="b_algo"><h2><a href="https://example.com">X</a></h2></li>`, 5).length,
  0,
);

const mwmbl = parseMwmbl(
  JSON.stringify([
    {
      url: "https://nodejs.org/en",
      title: [{ value: "Node.js" }, { value: " LTS" }],
      extract: [{ value: "Current release." }],
    },
    { url: "http://127.0.0.1/secret", title: "local", extract: "no" },
    { url: "https://nodejs.org/en", title: "duplicate", extract: "dup" },
  ]),
  10,
);
assert.equal(mwmbl.length, 1);
assert.equal(mwmbl[0].url, "https://nodejs.org/en");
assert.equal(mwmbl[0].title, "Node.js LTS");
assert.equal(mwmbl[0].snippet, "Current release.");

console.log("web_client tests passed");
