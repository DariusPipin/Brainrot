// Turns raw HTML into clean, LLM-ready output: markdown, metadata, or links.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { fetchPage, FetchError } from "./safeFetch.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "form"]);

const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() || null : null);
const countWords = (s) => (s ? s.split(/\s+/).filter(Boolean).length : 0);
const absolute = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

async function loadHtml(rawUrl) {
  const page = await fetchPage(rawUrl);
  const isHtml = /html|xml/i.test(page.contentType) || /^\s*</.test(page.text);
  return { page, isHtml, document: isHtml ? parseHTML(page.text).document : null };
}

/** Main content of a page as markdown. */
export async function extract(rawUrl) {
  const { page, isHtml, document } = await loadHtml(rawUrl);

  if (!isHtml) {
    // Plain text / JSON: return as-is.
    const text = page.text.trim();
    return { url: page.finalUrl, title: null, byline: null, excerpt: null, markdown: text, wordCount: countWords(text) };
  }

  // Make relative links absolute so the markdown is usable on its own.
  for (const [sel, attr] of [["a[href]", "href"], ["img[src]", "src"]]) {
    for (const el of document.querySelectorAll(sel)) {
      const abs = absolute(el.getAttribute(attr), page.finalUrl);
      if (abs) el.setAttribute(attr, abs);
    }
  }

  const pageTitle = clean(document.querySelector("title")?.textContent);
  let article = null;
  try {
    article = new Readability(document).parse();
  } catch {}

  const html = article?.content || document.body?.innerHTML || "";
  const markdown = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();

  return {
    url: page.finalUrl,
    title: clean(article?.title) || pageTitle,
    byline: clean(article?.byline),
    excerpt: clean(article?.excerpt),
    markdown,
    wordCount: countWords(markdown),
  };
}

/** Title, description, social-card and feed metadata of a page. */
export async function metadata(rawUrl) {
  const { page, isHtml, document } = await loadHtml(rawUrl);
  if (!isHtml) throw new FetchError("That URL is not an HTML page.", 422);

  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
      const v = clean(el?.getAttribute("content"));
      if (v) return v;
    }
    return null;
  };
  const link = (rel) => {
    const href = document.querySelector(`link[rel~="${rel}"]`)?.getAttribute("href");
    return href ? absolute(href, page.finalUrl) : null;
  };
  const image = meta("og:image", "twitter:image");

  return {
    url: page.finalUrl,
    title: clean(document.querySelector("title")?.textContent) || meta("og:title", "twitter:title"),
    description: meta("description", "og:description", "twitter:description"),
    siteName: meta("og:site_name", "application-name"),
    author: meta("author", "article:author"),
    publishedTime: meta("article:published_time", "date"),
    type: meta("og:type"),
    language: clean(document.documentElement?.getAttribute("lang")),
    canonical: link("canonical"),
    image: image ? absolute(image, page.finalUrl) : null,
    favicon: link("icon") || absolute("/favicon.ico", page.finalUrl),
    feeds: [...document.querySelectorAll('link[rel~="alternate"][type*="rss"], link[rel~="alternate"][type*="atom"]')]
      .map((el) => absolute(el.getAttribute("href"), page.finalUrl))
      .filter(Boolean),
  };
}

/** Every distinct http(s) link on a page, with its anchor text. */
export async function links(rawUrl) {
  const { page, isHtml, document } = await loadHtml(rawUrl);
  if (!isHtml) throw new FetchError("That URL is not an HTML page.", 422);

  const host = new URL(page.finalUrl).hostname;
  const seen = new Map();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = absolute(a.getAttribute("href"), page.finalUrl);
    if (!href || !/^https?:/i.test(href)) continue;
    const url = href.replace(/#.*$/, "");
    if (!url || url === page.finalUrl.replace(/#.*$/, "")) continue;
    const text = clean(a.textContent);
    if (!seen.has(url)) seen.set(url, { url, text, internal: new URL(url).hostname === host });
    else if (!seen.get(url).text && text) seen.get(url).text = text;
    if (seen.size >= 2000) break;
  }
  const list = [...seen.values()];
  return { url: page.finalUrl, count: list.length, links: list };
}
