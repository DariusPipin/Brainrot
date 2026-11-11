// Fetches a public web page while refusing anything that points at private,
// loopback, link-local or cloud-metadata addresses (SSRF protection).
// The address check runs inside the socket's DNS lookup, so the address that
// is validated is the address that is connected to (no DNS-rebinding gap).
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
]) blocked.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [
  ["::", 127], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(addr, bits, "ipv6");

export class FetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function isPublicAddress(address) {
  let addr = address;
  let family = net.isIP(addr);
  if (!family) return false;
  if (family === 6) {
    // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh).
    const m = /^::ffff:(.+)$/i.exec(addr);
    if (m) {
      if (net.isIPv4(m[1])) {
        addr = m[1];
        family = 4;
      } else {
        const parts = m[1].split(":");
        if (parts.length === 2) {
          const hi = parseInt(parts[0], 16);
          const lo = parseInt(parts[1], 16);
          addr = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
          family = 4;
        }
      }
    }
  }
  return !blocked.check(addr, family === 4 ? "ipv4" : "ipv6");
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(new FetchError("URL resolves to a non-public address", 400));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export function parseTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError("`url` must be an absolute http(s) URL", 400);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchError("Only http and https URLs are supported", 400);
  }
  if (u.username || u.password) throw new FetchError("URLs with credentials are not supported", 400);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new FetchError("URL points to a non-public address", 400);
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new FetchError("URL points to a non-public host", 400);
  }
  return u;
}

function requestOnce(u) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        lookup: guardedLookup,
        timeout: TIMEOUT_MS,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; AgentExtract/1.0; +x402 paid extraction API)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "accept-language": "en;q=0.9,*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new FetchError(`Target site responded with HTTP ${status}`, 502));
        }
        const type = String(res.headers["content-type"] || "");
        if (type && !/text\/|html|xml|json/i.test(type)) {
          res.destroy();
          return reject(new FetchError(`Unsupported content type: ${type}`, 415));
        }
        let stream = res;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        let size = 0;
        stream.on("data", (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new FetchError("Page is larger than the 3 MB limit", 413));
          } else chunks.push(c);
        });
        stream.on("error", () => reject(new FetchError("Failed to read the page body", 502)));
        stream.on("end", () => resolve({ body: Buffer.concat(chunks), contentType: type }));
      },
    );
    req.on("timeout", () => req.destroy(new FetchError("Target site timed out", 504)));
    req.on("error", (e) =>
      reject(e instanceof FetchError ? e : new FetchError(`Could not reach target site (${e.code || e.message})`, 502)),
    );
    req.end();
  });
}

function decode(body, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

export async function fetchPage(rawUrl) {
  let u = parseTarget(rawUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await requestOnce(u);
    if (r.redirect) {
      u = parseTarget(new URL(r.redirect, u).href);
      continue;
    }
    return { finalUrl: u.href, contentType: r.contentType, text: decode(r.body, r.contentType) };
  }
  throw new FetchError("Too many redirects", 502);
}
