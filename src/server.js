// AgentExtract: pay-per-call web page tools for AI agents.
// Each paid endpoint takes ?url=<page>; the calling agent pays in USDC
// automatically via the x402 protocol (HTTP 402).
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { extract, metadata, links } from "./extract.js";
import { FetchError } from "./safeFetch.js";

try {
  process.loadEnvFile();
} catch {}

const NETWORKS = {
  "base-sepolia": { id: "eip155:84532", label: "Base Sepolia (testnet, no real money)", name: "Base Sepolia testnet" },
  base: { id: "eip155:8453", label: "Base mainnet (real USDC)", name: "Base" },
};

const PORT = Number(process.env.PORT || 4021);
const PAY_TO = (process.env.PAY_TO || "").trim();
const NETWORK = (process.env.NETWORK || "base-sepolia").trim();
const PRICE = (process.env.PRICE || "$0.005").trim();
const PRICE_LIGHT = (process.env.PRICE_LIGHT || "$0.002").trim();
const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, FACILITATOR_URL } = process.env;
// Public, non-secret key that proves site ownership to IndexNow search engines.
const INDEXNOW_KEY = "7b1e4c9a2f6d4e0b8a35c1d97f20e6b4";

function fail(msg) {
  console.error(`\nConfiguration error: ${msg}\nSee README.md.\n`);
  process.exit(1);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) fail("PAY_TO must be your wallet address (0x + 40 hex characters). Payments are sent there.");
if (/^0x0{40}$/.test(PAY_TO)) fail("PAY_TO is the zero address; money sent there is lost.");
if (!NETWORKS[NETWORK]) fail(`NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}`);
for (const [k, v] of [["PRICE", PRICE], ["PRICE_LIGHT", PRICE_LIGHT]]) {
  if (!/^\$\d+(\.\d+)?$/.test(v) || Number(v.slice(1)) <= 0) fail(`${k} must look like "$0.01".`);
}

let facilitatorConfig;
if (FACILITATOR_URL) {
  facilitatorConfig = { url: FACILITATOR_URL };
} else if (NETWORK === "base") {
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    fail("NETWORK=base needs CDP_API_KEY_ID and CDP_API_KEY_SECRET (free at portal.cdp.coinbase.com), or a FACILITATOR_URL.");
  }
  facilitatorConfig = createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET);
} else {
  facilitatorConfig = { url: "https://x402.org/facilitator" };
}

const network = NETWORKS[NETWORK];
const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient(facilitatorConfig))
  .register(network.id, new ExactEvmScheme())
  .registerExtension(bazaarResourceServerExtension);

const TAGLINE = "Web page tools for AI agents: clean markdown, metadata and links from any public URL. No API key, pay per call in USDC.";

const URL_PARAM = { type: "string", description: "Absolute http(s) URL of the page (URL-encoded)" };
const str = { type: ["string", "null"] };

// One entry per paid endpoint. Everything else (payment gate, OpenAPI,
// discovery files, landing page) is generated from this table.
const ENDPOINTS = [
  {
    path: "/extract",
    operationId: "extractUrlToMarkdown",
    summary: "Web page to clean markdown",
    description:
      "Fetch any public web page and get clean, LLM-ready markdown (main article content, title, byline, excerpt). No API key: pay per call in USDC.",
    price: PRICE,
    handler: extract,
    isEmpty: (r) => !r.markdown,
    schema: {
      type: "object",
      required: ["url", "markdown", "wordCount"],
      properties: {
        url: { type: "string", description: "Final URL after redirects" },
        title: str, byline: str, excerpt: str,
        markdown: { type: "string", description: "Main content as markdown" },
        wordCount: { type: "integer" },
      },
    },
    example: {
      url: "https://example.com/",
      title: "Example Domain",
      byline: null,
      excerpt: "This domain is for use in documentation examples.",
      markdown: "# Example Domain\n\nThis domain is for use in documentation examples...",
      wordCount: 17,
    },
  },
  {
    path: "/metadata",
    operationId: "getPageMetadata",
    summary: "Web page metadata (title, description, social card, feeds)",
    description:
      "Get structured metadata for any public web page: title, description, site name, author, publish date, language, canonical URL, social-card image, favicon and RSS/Atom feeds. No API key: pay per call in USDC.",
    price: PRICE_LIGHT,
    handler: metadata,
    isEmpty: () => false,
    schema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" }, title: str, description: str, siteName: str, author: str, publishedTime: str,
        type: str, language: str, canonical: str, image: str, favicon: str,
        feeds: { type: "array", items: { type: "string" } },
      },
    },
    example: {
      url: "https://example.com/blog/post",
      title: "Example post",
      description: "A short description of the post.",
      siteName: "Example Blog",
      author: "Jane Doe",
      publishedTime: "2026-01-15T09:00:00Z",
      type: "article",
      language: "en",
      canonical: "https://example.com/blog/post",
      image: "https://example.com/card.png",
      favicon: "https://example.com/favicon.ico",
      feeds: ["https://example.com/feed.xml"],
    },
  },
  {
    path: "/links",
    operationId: "listPageLinks",
    summary: "All links on a web page",
    description:
      "List every distinct link on any public web page as absolute URLs with anchor text, each flagged internal or external. Useful for crawling and site mapping. No API key: pay per call in USDC.",
    price: PRICE_LIGHT,
    handler: links,
    isEmpty: () => false,
    schema: {
      type: "object",
      required: ["url", "count", "links"],
      properties: {
        url: { type: "string" },
        count: { type: "integer" },
        links: {
          type: "array",
          items: { type: "object", properties: { url: { type: "string" }, text: str, internal: { type: "boolean" } } },
        },
      },
    },
    example: {
      url: "https://example.com/",
      count: 1,
      links: [{ url: "https://www.iana.org/domains/example", text: "Learn more", internal: false }],
    },
  },
];

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

const stats = { startedAt: new Date().toISOString(), paidCalls: 0 };
const publicBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Free, machine- and human-readable descriptions of the service ---

function landingPage(base) {
  const rows = ENDPOINTS.map(
    (e) => `<tr><td><code>GET ${e.path}?url=…</code></td><td>${esc(e.summary)}</td><td>${esc(e.price)}</td></tr>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentExtract: pay-per-call web page tools for AI agents (x402)</title>
<meta name="description" content="${esc(TAGLINE)}">
<link rel="canonical" href="${base}/">
<meta property="og:title" content="AgentExtract"><meta property="og:description" content="${esc(TAGLINE)}"><meta property="og:type" content="website"><meta property="og:url" content="${base}/">
<link rel="alternate" type="application/json" href="${base}/openapi.json" title="OpenAPI">
<style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#5f5b53;--line:#e2ded5;--code:#f1eee7;--accent:#0b5d4b}
@media(prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ece9e2;--muted:#a39e93;--line:#34312c;--code:#22201d;--accent:#6fd1b6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 16px 64px}h1{font-size:2rem;line-height:1.2;margin:0 0 8px}h2{font-size:1.15rem;margin:40px 0 12px}
p{margin:0 0 14px}.lead{font-size:1.1rem;color:var(--muted)}a{color:var(--accent)}
code,pre{font:14px/1.5 ui-monospace,Consolas,monospace;background:var(--code);border-radius:6px}code{padding:2px 5px}pre{padding:14px;overflow-x:auto}pre code{padding:0;background:none}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:520px}td,th{text-align:left;padding:10px 12px 10px 0;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:.9rem}
</style></head><body><main>
<h1>AgentExtract</h1>
<p class="lead">${esc(TAGLINE)}</p>
<h2>Endpoints</h2>
<div class="scroll"><table><thead><tr><th>Call</th><th>Returns</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>How payment works</h2>
<p>There are no accounts and no API keys. Call an endpoint and it answers <code>402 Payment Required</code> with the price. An <a href="https://x402.org">x402</a> client signs a USDC payment on ${esc(network.name)} and retries; the response then carries the result. Calls that fail are not charged.</p>
<pre><code>import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "${network.id}", client: new ExactEvmScheme(account) }],
});
const res = await pay("${base}/extract?url=" + encodeURIComponent("https://example.com"));
const { title, markdown } = await res.json();</code></pre>
<h2>Example response</h2>
<pre><code>${esc(JSON.stringify(ENDPOINTS[0].example, null, 2))}</code></pre>
<h2>For agents and crawlers</h2>
<p><a href="/openapi.json">OpenAPI description</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/x402">x402 discovery</a></p>
</main></body></html>`;
}

app.get("/", (req, res) => {
  const base = publicBase(req);
  if (req.accepts(["json", "html"]) === "html") return res.type("html").send(landingPage(base));
  res.json({
    name: "AgentExtract",
    description: TAGLINE,
    payment: { protocol: "x402", price: PRICE, currency: "USDC", network: network.id },
    endpoints: {
      ...Object.fromEntries(ENDPOINTS.map((e) => [`GET ${base}${e.path}?url={url}`, `Paid (${e.price} per call). ${e.summary}.`])),
      [`GET ${base}/llms.txt`]: "Free. Plain-text usage guide for agents.",
      [`GET ${base}/openapi.json`]: "Free. OpenAPI description with pricing.",
      [`GET ${base}/health`]: "Free. Liveness check.",
    },
    exampleOutput: ENDPOINTS[0].example,
    note: "Failed calls return a 4xx/5xx status and are not charged.",
  });
});

app.get("/llms.txt", (req, res) => {
  const base = publicBase(req);
  res.type("text/plain").send(
    [
      "# AgentExtract",
      "",
      `> ${TAGLINE}`,
      "",
      "## Endpoints",
      ...ENDPOINTS.map((e) => `- GET ${base}${e.path}?url=<absolute http(s) URL, URL-encoded> : ${e.summary}. ${e.price} USDC per successful call.`),
      "",
      "## Payment",
      `USDC on ${network.id}, via the x402 protocol. No account or API key.`,
      "Call an endpoint; you receive HTTP 402 with payment requirements. Retry with a signed",
      "payment header using any x402 client (@x402/fetch, @x402/axios, x402 Python SDK).",
      "Failed calls are not charged.",
      "",
      "## Responses (JSON)",
      ...ENDPOINTS.map((e) => `- ${e.path}: ${Object.keys(e.schema.properties).join(", ")}`),
      "",
      "## More",
      `- OpenAPI: ${base}/openapi.json`,
      "",
    ].join("\n"),
  );
});

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "AgentExtract",
      version: "1.1.0",
      description: `${TAGLINE} Payment via x402 on ${network.id}. Failed calls are not charged.`,
    },
    servers: [{ url: publicBase(req) }],
    paths: Object.fromEntries(
      ENDPOINTS.map((e) => [
        e.path,
        {
          get: {
            operationId: e.operationId,
            summary: e.summary,
            description: e.description,
            tags: ["web", "scraping", "extraction"],
            parameters: [{ name: "url", in: "query", required: true, description: URL_PARAM.description, schema: { type: "string", format: "uri" }, example: "https://example.com" }],
            "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: e.price.slice(1) } },
            responses: {
              200: { description: "Success", content: { "application/json": { schema: e.schema, example: e.example } } },
              400: { description: "Missing or invalid `url` (not charged)" },
              402: { description: "Payment Required (x402 challenge in the PAYMENT-REQUIRED header)" },
              502: { description: "Target site could not be fetched (not charged)" },
            },
          },
        },
      ]),
    ),
  });
});

const wellKnown = (req, res) =>
  res.json({
    version: 1,
    resources: ENDPOINTS.map((e) => `${publicBase(req)}${e.path}`),
    instructions: "Each endpoint takes ?url=<absolute http(s) URL>. Paid per successful call in USDC via x402. See /openapi.json and /llms.txt.",
  });
app.get("/.well-known/x402", wellKnown);
app.get("/.well-known/x402.json", wellKnown);

app.get("/robots.txt", (req, res) => {
  const base = publicBase(req);
  res.type("text/plain").send(
    `User-agent: *\nAllow: /\n${ENDPOINTS.map((e) => `Disallow: ${e.path}`).join("\n")}\n\nSitemap: ${base}/sitemap.xml\n# Agents: see ${base}/llms.txt and ${base}/openapi.json\n`,
  );
});

app.get("/sitemap.xml", (req, res) => {
  const base = publicBase(req);
  const urls = ["/", "/llms.txt", "/openapi.json"].map((p) => `<url><loc>${base}${p}</loc></url>`).join("");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

app.get(`/${INDEXNOW_KEY}.txt`, (_req, res) => res.type("text/plain").send(INDEXNOW_KEY));

// --- Payment gate ---

app.use(
  paymentMiddleware(
    Object.fromEntries(
      ENDPOINTS.map((e) => [
        `GET ${e.path}`,
        {
          accepts: [{ scheme: "exact", price: e.price, network: network.id, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
          description: e.description,
          mimeType: "application/json",
          extensions: {
            ...declareDiscoveryExtension({
              input: { url: "https://example.com" },
              inputSchema: { properties: { url: URL_PARAM }, required: ["url"] },
              output: { example: e.example },
            }),
          },
        },
      ]),
    ),
    resourceServer,
  ),
);

// Only reached once a valid payment has been verified. Errors return >= 400,
// which makes the middleware skip settlement, so the caller is not charged.
for (const e of ENDPOINTS) {
  app.get(e.path, async (req, res) => {
    const url = typeof req.query.url === "string" ? req.query.url : "";
    if (!url) return res.status(400).json({ error: "Missing required query parameter `url`." });
    try {
      const result = await e.handler(url);
      if (e.isEmpty(result)) return res.status(422).json({ error: "No readable content found at that URL." });
      stats.paidCalls++;
      console.log(`[paid] ${new Date().toISOString()} ${e.path} ${result.url} total=${stats.paidCalls}`);
      res.json(result);
    } catch (err) {
      const status = err instanceof FetchError ? err.status : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: err instanceof FetchError ? err.message : "Request failed." });
    }
  });
}

app.use((_req, res) => res.status(404).json({ error: "Not found. See GET / for usage." }));

app.listen(PORT, () => {
  console.log(`AgentExtract listening on :${PORT}`);
  console.log(`  network : ${network.label}`);
  console.log(`  prices  : ${ENDPOINTS.map((e) => `${e.path} ${e.price}`).join(", ")}`);
  console.log(`  pay to  : ${PAY_TO}`);
});
