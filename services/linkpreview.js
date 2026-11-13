// Link previews (title / description / image) fetched by the server.
// SSRF-safe: only http(s), every hop is resolved and rejected when it points to a private / loopback address.
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const MAX_BYTES = 400 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT = 5000;
const cache = new Map(); // url -> { at, value }
const TTL = 60 * 60 * 1000;

const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? isPrivateIp(m[1]) : false;
  }
  return true;
};

// dns lookup that refuses private addresses (also protects against DNS rebinding: the checked address is the one connected to)
const safeLookup = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(new Error('blocked address'));
    if (options && options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
};

function fetchHtml(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad url')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('bad protocol'));
    if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) return reject(new Error('blocked address'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      timeout: TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EChatLinkPreview/1.0)', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,ar;q=0.8' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('bad redirect')); }
        return resolve(fetchHtml(next, redirects + 1));
      }
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200 || !/text\/html|application\/xhtml/.test(type)) { res.resume(); return reject(new Error('not html')); }
      const chunks = []; let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BYTES) { res.destroy(); return resolve({ html: Buffer.concat(chunks).toString('utf8'), url: u.toString() }); }
        chunks.push(d);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: u.toString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim();

function meta(html, ...names) {
  for (const n of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = re1.exec(html) || re2.exec(html);
    if (m && m[1]) return decode(m[1]);
  }
  return '';
}

async function getPreview(urlStr) {
  const hit = cache.get(urlStr);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value = null;
  try {
    const { html, url } = await fetchHtml(urlStr);
    const head = html.slice(0, 200000);
    const title = meta(head, 'og:title', 'twitter:title') || decode((/<title[^>]*>([^<]*)<\/title>/i.exec(head) || [])[1]);
    const description = meta(head, 'og:description', 'twitter:description', 'description');
    let image = meta(head, 'og:image', 'twitter:image');
    if (image) { try { image = new URL(image, url).toString(); } catch { image = ''; } }
    if (!/^https?:/i.test(image)) image = '';
    const site = meta(head, 'og:site_name') || new URL(url).hostname.replace(/^www\./, '');
    if (title || description || image) value = { url, title: title.slice(0, 160), description: description.slice(0, 240), image: image || null, site };
  } catch { /* unreachable / blocked / not html -> no preview */ }
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(urlStr, { at: Date.now(), value });
  return value;
}

module.exports = { getPreview, isPrivateIp };
