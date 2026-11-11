// AgentExtract: a pay-per-call API for AI agents.
// GET /extract?url=<page> returns clean markdown; each call costs PRICE in USDC,
// paid automatically by the calling agent via the x402 protocol (HTTP 402).
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { extract } from "./extract.js";
import { FetchError } from "./safeFetch.js";

try {
  process.loadEnvFile();
} catch {}

const NETWORKS = {
  "base-sepolia": { id: "eip155:84532", label: "Base Sepolia (testnet, no real money)" },
  base: { id: "eip155:8453", label: "Base mainnet (real USDC)" },
};

const PORT = Number(process.env.PORT || 4021);
const PAY_TO = (process.env.PAY_TO || "").trim();
const NETWORK = (process.env.NETWORK || "base-sepolia").trim();
const PRICE = (process.env.PRICE || "$0.01").trim();
const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, FACILITATOR_URL } = process.env;

function fail(msg) {
  console.error(`\nConfiguration error: ${msg}\nSee README.md.\n`);
  process.exit(1);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) fail("PAY_TO must be your wallet address (0x + 40 hex characters). Payments are sent there.");
if (/^0x0{40}$/.test(PAY_TO)) fail("PAY_TO is the zero address; money sent there is lost.");
if (!NETWORKS[NETWORK]) fail(`NETWORK must be one of: ${Object.keys(NETWORKS).join(", ")}`);
if (!/^\$\d+(\.\d+)?$/.test(PRICE) || Number(PRICE.slice(1)) <= 0) fail('PRICE must look like "$0.01".');

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

const DESCRIPTION =
  "Fetch any public web page and get clean, LLM-ready markdown (main article content, title, byline, excerpt). No API key: pay per call in USDC.";

const EXAMPLE_OUTPUT = {
  url: "https://example.com/",
  title: "Example Domain",
  byline: null,
  excerpt: "This domain is for use in documentation examples.",
  markdown: "# Example Domain\n\nThis domain is for use in documentation examples...",
  wordCount: 17,
};

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

const stats = { startedAt: new Date().toISOString(), paidCalls: 0 };

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    name: "AgentExtract",
    description: DESCRIPTION,
    payment: { protocol: "x402", price: PRICE, currency: "USDC", network: network.id },
    endpoints: {
      [`GET ${base}/extract?url={url}`]: `Paid (${PRICE} per call). Returns JSON: url, title, byline, excerpt, markdown, wordCount.`,
      [`GET ${base}/llms.txt`]: "Free. Plain-text usage guide for agents.",
      [`GET ${base}/openapi.json`]: "Free. OpenAPI description with pricing.",
      [`GET ${base}/health`]: "Free. Liveness check.",
    },
    exampleOutput: EXAMPLE_OUTPUT,
    note: "Failed extractions return a 4xx/5xx status and are not charged.",
  });
});

app.get("/llms.txt", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.type("text/plain").send(
    [
      "# AgentExtract",
      "",
      DESCRIPTION,
      "",
      "## Usage",
      `GET ${base}/extract?url=<absolute http(s) URL, URL-encoded>`,
      "",
      "## Payment",
      `${PRICE} USDC per successful call on ${network.id}, via the x402 protocol.`,
      "Call the endpoint; you receive HTTP 402 with payment requirements. Retry with a signed",
      "payment header using any x402 client (@x402/fetch, @x402/axios, x402 Python SDK).",
      "Failed extractions are not charged.",
      "",
      "## Response (JSON)",
      "url, title, byline, excerpt, markdown, wordCount",
      "",
    ].join("\n"),
  );
});

// --- Machine-readable discovery, so crawlers and agent directories can index the service ---

const publicBase = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

app.get("/openapi.json", (req, res) => {
  res.json({
    openapi: "3.1.0",
    info: {
      title: "AgentExtract",
      version: "1.0.0",
      description: `${DESCRIPTION} Payment: ${PRICE} USDC per successful call via x402 on ${network.id}. Failed extractions are not charged.`,
    },
    servers: [{ url: publicBase(req) }],
    paths: {
      "/extract": {
        get: {
          operationId: "extractUrlToMarkdown",
          summary: "Web page to clean markdown",
          description: DESCRIPTION,
          tags: ["web", "scraping", "markdown", "extraction"],
          parameters: [
            {
              name: "url",
              in: "query",
              required: true,
              description: "Absolute http(s) URL of the page to extract (URL-encoded).",
              schema: { type: "string", format: "uri" },
              example: "https://example.com",
            },
          ],
          "x-payment-info": {
            protocols: ["x402"],
            price: { mode: "fixed", currency: "USD", amount: PRICE.slice(1) },
          },
          responses: {
            200: {
              description: "Extracted content",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["url", "markdown", "wordCount"],
                    properties: {
                      url: { type: "string", description: "Final URL after redirects" },
                      title: { type: ["string", "null"] },
                      byline: { type: ["string", "null"] },
                      excerpt: { type: ["string", "null"] },
                      markdown: { type: "string", description: "Main content as markdown" },
                      wordCount: { type: "integer" },
                    },
                  },
                  example: EXAMPLE_OUTPUT,
                },
              },
            },
            400: { description: "Missing or invalid `url` (not charged)" },
            402: { description: "Payment Required (x402 challenge in the PAYMENT-REQUIRED header)" },
            502: { description: "Target site could not be fetched (not charged)" },
          },
        },
      },
    },
  });
});

const wellKnown = (req, res) =>
  res.json({
    version: 1,
    resources: [`${publicBase(req)}/extract`],
    instructions: `GET /extract?url=<absolute http(s) URL>. ${PRICE} USDC per successful call via x402. See /openapi.json and /llms.txt.`,
  });
app.get("/.well-known/x402", wellKnown);
app.get("/.well-known/x402.json", wellKnown);

app.get("/robots.txt", (req, res) =>
  res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /extract\n\n# Agents: see ${publicBase(req)}/llms.txt and ${publicBase(req)}/openapi.json\n`),
);

app.use(
  paymentMiddleware(
    {
      "GET /extract": {
        accepts: [{ scheme: "exact", price: PRICE, network: network.id, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
        description: DESCRIPTION,
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { url: "https://example.com" },
            inputSchema: {
              properties: { url: { type: "string", description: "Absolute http(s) URL of the page to extract" } },
              required: ["url"],
            },
            output: { example: EXAMPLE_OUTPUT },
          }),
        },
      },
    },
    resourceServer,
  ),
);

// Only reached once a valid payment has been verified. Errors return >= 400,
// which makes the middleware skip settlement, so the caller is not charged.
app.get("/extract", async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) return res.status(400).json({ error: "Missing required query parameter `url`." });
  try {
    const result = await extract(url);
    if (!result.markdown) return res.status(422).json({ error: "No readable content found at that URL." });
    stats.paidCalls++;
    console.log(`[paid] ${new Date().toISOString()} ${result.url} (${result.wordCount} words) total=${stats.paidCalls}`);
    res.json(result);
  } catch (e) {
    const status = e instanceof FetchError ? e.status : 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: e instanceof FetchError ? e.message : "Extraction failed." });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Not found. See GET / for usage." }));

app.listen(PORT, () => {
  console.log(`AgentExtract listening on :${PORT}`);
  console.log(`  network : ${network.label}`);
  console.log(`  price   : ${PRICE} USDC per call`);
  console.log(`  pay to  : ${PAY_TO}`);
});
