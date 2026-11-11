# AgentExtract

A pay-per-call API for AI agents. An agent calls `GET /extract?url=<page>` and gets the
page back as clean markdown. Each successful call costs **$0.01 in USDC**, paid
automatically by the agent through the [x402](https://x402.org) protocol (HTTP 402).
The money goes straight to your wallet; there is no middleman account holding it.

100 paid calls = $1.

## What is verified and what is not

`npm test` passes 8 checks: private-address blocking, live extraction, free endpoints,
the 402 response (0.01 USDC to your address, with Bazaar discovery metadata), rejection
of a forged payment, and refusal to start without a wallet address.

Not verified: a real paid call end to end. That needs a funded wallet and a deployed
server, which are steps only you can do (below).

## Going live (your steps)

1. **Wallet.** Create a wallet you control on Base (Coinbase Wallet, MetaMask, or a
   Coinbase account's Base USDC deposit address). Copy its `0x...` address.
   Double-check it: payments to a wrong address cannot be recovered.
2. **Coinbase Developer Platform keys.** Sign up at <https://portal.cdp.coinbase.com>
   and create an API key. These let the server settle real payments on Base mainnet and
   list the API in the x402 Bazaar, where agents discover paid services.
3. **Deploy.** Put this folder on any Node host (Render, Railway, Fly.io; a `Dockerfile`
   is included). Set these environment variables on the host:

   ```
   PAY_TO=0xYourWalletAddress
   NETWORK=base
   CDP_API_KEY_ID=...
   CDP_API_KEY_SECRET=...
   ```

4. **Check it.** Open `https://your-host/` (free info) and `https://your-host/extract?url=https://example.com`
   (should answer 402 Payment Required).
5. **Get it found.** The first settled payment through the CDP facilitator lists the
   endpoint in the Bazaar. Also submit the URL to x402 directories such as x402scan.

## Collecting the money

There is nothing to withdraw from this app. Each payment is a USDC transfer on Base
directly into the `PAY_TO` wallet, visible at `https://basescan.org/address/<your address>`.
To turn it into cash, send the USDC from your wallet to an exchange account and sell it.

## Try it locally first (testnet, no real money)

```
cp .env.example .env      # then put your address in PAY_TO
npm install
npm start
```

With `NETWORK=base-sepolia` (the default) no keys are needed and payments use test USDC.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PAY_TO` | required | Wallet address that receives payments |
| `NETWORK` | `base-sepolia` | `base-sepolia` (test) or `base` (real USDC) |
| `PRICE` | `$0.01` | Price per successful call |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | none | Required when `NETWORK=base` |
| `FACILITATOR_URL` | none | Use a different x402 facilitator instead |
| `PORT` | `4021` | Listening port |

Failed extractions return an error status and are not charged.
