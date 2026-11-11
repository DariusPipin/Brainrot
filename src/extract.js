// Turns raw HTML into clean, LLM-ready markdown.
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { fetchPage } from "./safeFetch.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "form"]);

export async function extract(rawUrl) {
  const page = await fetchPage(rawUrl);

  if (!/html|xml/i.test(page.contentType) && !/^\s*</.test(page.text)) {
    // Plain text / JSON: return as-is.
    const text = page.text.trim();
    return { url: page.finalUrl, title: null, byline: null, excerpt: null, markdown: text, wordCount: countWords(text) };
  }

  const { document } = parseHTML(page.text);
  // Make relative links absolute so the markdown is usable on its own.
  for (const [sel, attr] of [["a[href]", "href"], ["img[src]", "src"]]) {
    for (const el of document.querySelectorAll(sel)) {
      try {
        el.setAttribute(attr, new URL(el.getAttribute(attr), page.finalUrl).href);
      } catch {}
    }
  }

  const pageTitle = document.querySelector("title")?.textContent?.trim() || null;
  let article = null;
  try {
    article = new Readability(document).parse();
  } catch {}

  const html = article?.content || document.body?.innerHTML || "";
  const markdown = turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();

  return {
    url: page.finalUrl,
    title: article?.title?.trim() || pageTitle,
    byline: article?.byline?.trim() || null,
    excerpt: article?.excerpt?.trim() || null,
    markdown,
    wordCount: countWords(markdown),
  };
}

function countWords(s) {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}
