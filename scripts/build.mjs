#!/usr/bin/env node
/**
 * Build index.html from jev-tape's wiki. The wiki's source of truth is manutej/jev-tape/wiki;
 * this repo only publishes it. Zero dependencies, deterministic output.
 *
 *   node scripts/build.mjs ../jev-tape        # writes index.html
 *
 * Broken [[links]] are rendered visibly (not dropped) and counted in the footer.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const src = resolve(process.argv[2] ?? "../jev-tape");
const wiki = join(src, "wiki");
const sha = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: src, encoding: "utf8" }).trim(); } catch { return "unknown"; } })();

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parse(file) {
  const raw = readFileSync(file, "utf8");
  const fm = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
    body = raw.slice(m[0].length);
  }
  return { fm, body };
}

const pages = new Map();
for (const f of readdirSync(join(wiki, "pages")).filter((f) => f.endsWith(".md")).sort()) {
  const slug = f.replace(/\.md$/, "");
  const { fm, body } = parse(join(wiki, "pages", f));
  const h1 = body.match(/^#\s+(.+)$/m);
  pages.set(slug, { slug, title: fm.title || (h1 ? h1[1] : slug), type: fm.type || "", body });
}

const broken = new Set();
function inline(s) {
  const code = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const t = target.trim();
    if (pages.has(t)) return `<a href="#${t}">${label ?? pages.get(t).title}</a>`;
    broken.add(t);
    return `<span class="broken" title="No page named ${t}">${label ?? t}</span>`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ""}>${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(code[+i])}</code>`);
}

function render(md) {
  const out = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); i++; continue;
    }
    const h = l.match(/^(#{1,4})\s+(.+)$/);
    if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^\|/.test(l)) {
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|?$/.test(r));
      const [head, ...rest] = body;
      out.push(`<div class="tbl"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^>\s?/.test(l)) {
      const buf = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
    }
    if (!l.trim() || /^---+$/.test(l.trim())) { i++; continue; }
    const buf = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) buf.push(lines[i]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

// Sidebar from INDEX.md sections; pages it does not list go under "Other pages".
const nav = [];
const listed = new Set();
let section = null;
for (const line of readFileSync(join(wiki, "INDEX.md"), "utf8").split("\n")) {
  const h = line.match(/^##\s+(.+)$/);
  if (h) { section = { title: h[1], slugs: [] }; nav.push(section); continue; }
  for (const m of line.matchAll(/\[\[([^\]|]+)\]\]/g)) {
    const t = m[1].trim();
    if (!pages.has(t)) { broken.add(t); continue; }
    if (section && !listed.has(t)) { section.slugs.push(t); listed.add(t); }
  }
}
const other = [...pages.keys()].filter((s) => !listed.has(s));
if (other.length) nav.push({ title: "Other pages", slugs: other });

const articles = [...pages.values()].map((p) => {
  const body = render(p.body.replace(/^#\s+.+\n?/m, ""));
  return `<article id="${p.slug}"><div class="kicker">${esc(p.type || "page")} · ${p.slug}.md</div><h1>${esc(p.title)}</h1>${body}</article>`;
}).join("\n");
const navHtml = nav.map((s) => `<div class="sec"><h3>${esc(s.title)}</h3><ul>${s.slugs.map((x) => `<li><a href="#${x}">${esc(pages.get(x).title)}</a></li>`).join("")}</ul></div>`).join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>jev-tape wiki</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;800&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{--paper:#FAF7F2;--ink:#1C1A15;--soft:#4A453C;--faint:#7A7468;--rule:#D4CBBA;--blue:#2C4F6B;--fill:#F0EDE6;--bad:#A2362B}
*{box-sizing:border-box}
html,body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "DM Sans",system-ui,sans-serif}
a{color:var(--blue)}
header{max-width:1180px;margin:0 auto;padding:1.2rem 1.2rem .8rem;border-bottom:1px solid var(--rule)}
header h1{font:800 1.5rem/1.1 "Bricolage Grotesque",Georgia,serif;margin:.2rem 0 0}
.kicker{font:11px/1.3 "JetBrains Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.layout{max-width:1180px;margin:0 auto;padding:1.2rem;display:grid;grid-template-columns:250px minmax(0,1fr);gap:1.5rem}
nav{position:sticky;top:1rem;align-self:start;max-height:calc(100vh - 2rem);overflow:auto;font-size:14px}
nav h3{font:600 12px "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:1rem 0 .3rem}
nav ul{list-style:none;margin:0;padding:0}
nav li{padding:2px 0}
article{display:none;background:#fff;border:1px solid var(--rule);border-radius:8px;padding:1.4rem 1.6rem 2rem;max-width:74ch}
article:target,article.show{display:block}
article h1{font:800 1.8rem/1.15 "Bricolage Grotesque",Georgia,serif;margin:.3rem 0 1rem}
article h2,article h3{font-family:"Bricolage Grotesque",Georgia,serif;margin:1.4rem 0 .4rem}
code{font:13px "JetBrains Mono",monospace;background:var(--fill);padding:1px 4px;border-radius:3px}
pre{background:var(--fill);padding:.8rem 1rem;border-radius:6px;overflow-x:auto}
pre code{background:none;padding:0}
.tbl{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;margin:.6rem 0}
th,td{border-bottom:1px solid var(--rule);padding:.4rem .5rem;text-align:left;vertical-align:top}
blockquote{margin:.8rem 0;padding:.2rem 1rem;border-left:3px solid var(--rule);color:var(--soft)}
.broken{color:var(--bad);text-decoration:underline dotted}
footer{max-width:1180px;margin:0 auto;padding:1rem 1.2rem 2rem;color:var(--faint);font-size:13px;border-top:1px solid var(--rule)}
@media (max-width:760px){.layout{grid-template-columns:1fr}nav{position:static;max-height:none}}
</style>
</head>
<body>
<header>
  <div class="kicker">Built from manutej/jev-tape/wiki @ ${sha} · not a live TypeSafe qualifier · no API keys</div>
  <h1>jev-tape wiki</h1>
</header>
<div class="layout">
<nav aria-label="Pages">${navHtml}</nav>
<main>
${articles}
</main>
</div>
<footer>${pages.size} pages · ${broken.size} broken link target${broken.size === 1 ? "" : "s"}${broken.size ? ` (${[...broken].sort().map(esc).join(", ")})` : ""} · regenerate with <code>node scripts/build.mjs ../jev-tape</code></footer>
<script>
(function(){
  function show(){var id=location.hash.slice(1);var a=id&&document.getElementById(id);document.querySelectorAll("article.show").forEach(function(x){x.classList.remove("show")});(a&&a.tagName==="ARTICLE"?a:document.getElementById("home")||document.querySelector("article")).classList.add("show");}
  addEventListener("hashchange",show);show();
})();
</script>
</body>
</html>
`;
writeFileSync("index.html", html);
console.log(`index.html: ${pages.size} pages from jev-tape@${sha}, ${broken.size} broken link targets`);
