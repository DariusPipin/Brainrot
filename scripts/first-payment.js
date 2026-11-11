// Makes ONE paid call to the live API, exactly as an AI agent would.
// Purpose: prove payments settle end to end and trigger the Bazaar listing.
//
// The paying wallet's key is read from the file `.payer.env` (never committed):
//   PAYER_PRIVATE_KEY=0x...
// Use a separate wallet holding a few cents of USDC on Base, not your main one.
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

try {
  process.loadEnvFile(".payer.env");
} catch {}

const API = (process.env.API_URL || "https://agent-extract.onrender.com").replace(/\/$/, "");
const TARGET = `${API}/extract?url=${encodeURIComponent("https://example.com")}`;
const MAX_UNITS = 10_000n; // hard cap: 0.01 USDC
const BASE_MAINNET = "eip155:8453";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const key = (process.env.PAYER_PRIVATE_KEY || "").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Put the paying wallet's key in .payer.env as PAYER_PRIVATE_KEY=0x... (64 hex characters).");
  process.exit(1);
}
const account = privateKeyToAccount(key);

// 1. Read what the server asks for, and refuse anything unexpected.
const probe = await fetch(TARGET, { headers: { accept: "application/json" } });
if (probe.status !== 402) {
  console.error(`Expected HTTP 402 from the API, got ${probe.status}.`);
  process.exit(1);
}
const required = JSON.parse(Buffer.from(probe.headers.get("payment-required") || "", "base64").toString("utf8"));
const ask = required.accepts?.[0];
if (
  !ask ||
  required.accepts.length !== 1 ||
  ask.network !== BASE_MAINNET ||
  ask.asset.toLowerCase() !== USDC_BASE ||
  BigInt(ask.amount) > MAX_UNITS
) {
  console.error("The payment request is not what this script expects; nothing was paid.\n", ask);
  process.exit(1);
}
console.log(`Paying ${Number(ask.amount) / 1e6} USDC on Base`);
console.log(`  from ${account.address}`);
console.log(`  to   ${ask.payTo}`);
if (account.address.toLowerCase() === ask.payTo.toLowerCase()) {
  console.error("The paying wallet is the receiving wallet. Use a different wallet to pay.");
  process.exit(1);
}

// 2. Pay and call.
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: BASE_MAINNET, client: new ExactEvmScheme(account) }],
});
const res = await fetchWithPayment(TARGET, { method: "GET", headers: { accept: "application/json" } });

if (!res.ok) {
  console.error(`\nNot paid. The server answered HTTP ${res.status}.`);
  const header = res.headers.get("payment-required");
  if (header) {
    try {
      console.error("Reason:", JSON.parse(Buffer.from(header, "base64").toString("utf8")).error);
    } catch {}
  }
  console.error((await res.text()).slice(0, 300));
  process.exit(1);
}

const body = await res.json();
console.log(`\nPaid call succeeded: "${body.title}" (${body.wordCount} words)`);
const receipt = res.headers.get("payment-response");
if (receipt) {
  const r = decodePaymentResponseHeader(receipt);
  console.log(`Settled: ${r.success}`);
  if (r.transaction) console.log(`Transaction: https://basescan.org/tx/${r.transaction}`);
}
