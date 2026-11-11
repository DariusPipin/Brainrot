// Smoke test: address guards, extraction, and the 402 payment gate.
// Uses the testnet facilitator and a throwaway address; no money moves.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isPublicAddress, parseTarget } from "../src/safeFetch.js";
import { extract, metadata, links } from "../src/extract.js";

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

await check("blocks private / loopback / metadata addresses", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0",
    "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(a), true, a);
});

await check("rejects bad target URLs", () => {
  for (const u of ["notaurl", "ftp://example.com", "file:///etc/passwd", "http://localhost/", "http://127.0.0.1:8080/",
    "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://user:pw@example.com/", "http://2130706433/", "http://0x7f.1/"]) {
    assert.throws(() => parseTarget(u), u);
  }
  assert.equal(parseTarget("https://example.com/a?b=1").href, "https://example.com/a?b=1");
});

await check("refuses a hostname that resolves to loopback", async () => {
  await assert.rejects(() => extract("http://localtest.me/"), /non-public/);
});

await check("extracts markdown from a live page", async () => {
  const r = await extract("https://example.com");
  assert.match(r.title, /Example Domain/);
  assert.match(r.markdown, /documentation/i);
  assert.ok(r.wordCount > 5);
});

await check("metadata and links work on a live page", async () => {
  const m = await metadata("https://www.iana.org/help/example-domains");
  assert.match(m.title, /Example Domains/i);
  assert.ok(m.favicon.startsWith("https://"));
  const l = await links("https://www.iana.org/help/example-domains");
  assert.ok(l.count > 5 && l.links.length === l.count);
  assert.ok(l.links.every((x) => x.url.startsWith("http") && typeof x.internal === "boolean"));
  assert.ok(l.links.some((x) => x.internal) );
});

// --- payment gate, against a real server process ---
const PORT = 4599;
const PAY_TO = "0x1111111111111111111111111111111111111111";
const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), PAY_TO, NETWORK: "base-sepolia", PRICE: "$0.01", FACILITATOR_URL: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${PORT}`;

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  await check("free endpoints respond", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const info = await (await fetch(`${base}/`)).json();
    assert.equal(info.payment.price, "$0.01");
    assert.match(await (await fetch(`${base}/llms.txt`)).text(), /x402/);
  });

  await check("discovery documents are served", async () => {
    const api = await (await fetch(`${base}/openapi.json`)).json();
    const op = api.paths["/extract"].get;
    assert.deepEqual(op["x-payment-info"], { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: "0.01" } });
    assert.ok(op.responses["402"]);
    for (const p of ["/.well-known/x402", "/.well-known/x402.json"]) {
      const wk = await (await fetch(`${base}${p}`)).json();
      assert.equal(wk.version, 1);
      assert.deepEqual(wk.resources, [`${base}/extract`, `${base}/metadata`, `${base}/links`]);
    }
    assert.match(await (await fetch(`${base}/robots.txt`)).text(), /llms\.txt/);
    assert.equal(api.paths["/metadata"].get["x-payment-info"].price.amount, "0.002");
    assert.ok((await (await fetch(`${base}/sitemap.xml`)).text()).includes(`<loc>${base}/llms.txt</loc>`));
    const html = await (await fetch(`${base}/`, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } })).text();
    assert.ok(html.includes("<title>AgentExtract") && html.includes("/links?url"));
    const key = "7b1e4c9a2f6d4e0b8a35c1d97f20e6b4";
    assert.equal(await (await fetch(`${base}/${key}.txt`)).text(), key);
    for (const p of ["/metadata", "/links"]) {
      const r = await fetch(`${base}${p}?url=https%3A%2F%2Fexample.com`);
      assert.equal(r.status, 402, p);
      const a = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString("utf8")).accepts[0];
      assert.equal(String(a.amount), "2000", p);
    }
    assert.equal((await fetch(`${base}/extract`)).status, 402, "probe without params must reach the 402");
  });

  await check("unpaid call gets HTTP 402 with correct payment requirements", async () => {
    const res = await fetch(`${base}/extract?url=https%3A%2F%2Fexample.com`, { headers: { accept: "application/json" } });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header, "PAYMENT-REQUIRED header missing");
    const req = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const a = req.accepts[0];
    assert.equal(a.scheme, "exact");
    assert.equal(a.network, "eip155:84532");
    assert.equal(a.payTo.toLowerCase(), PAY_TO);
    assert.equal(String(a.amount), "10000", "expected 0.01 USDC = 10000 base units");
    assert.ok(req.extensions?.bazaar, "bazaar discovery metadata missing");
    console.log(`     requirements: ${a.amount} units of ${a.asset} -> ${a.payTo}`);
  });

  await check("forged payment header is rejected, content not served", async () => {
    const fake = Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString("base64");
    const res = await fetch(`${base}/extract?url=https%3A%2F%2Fexample.com`, { headers: { "payment-signature": fake, "x-payment": fake } });
    assert.ok(res.status === 402 || res.status === 400, `status ${res.status}`);
    assert.doesNotMatch(await res.text(), /Example Domain/);
  });
} finally {
  server.kill();
}

await check("refuses to start without a wallet address", async () => {
  const p = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PAY_TO: "", PORT: "4600" }, stdio: "ignore" });
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 1);
});

console.log(`\n${passed} checks passed${process.exitCode ? ", some FAILED" : ""}`);
if (process.exitCode) console.log("\nserver log:\n" + log);
