
const express = require("express");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const app = express();

// Authentication integration point:
// Set req.auth = { userId: verifiedSubject } here after validating your session/JWT.
// Veyra intentionally does not accept X-Veyra-User-Id from the browser as identity proof.
app.use((req, res, next) => {
  req.auth = req.auth || null;
  next();
});
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES || 2 * 1024 * 1024 * 1024);
const JOB_RETENTION_MS = Number(process.env.JOB_RETENTION_MS || 30 * 60 * 1000);
const TEMP_DIR = process.env.VEYRA_TEMP_DIR || process.env.STREAMDROP_TEMP_DIR || path.join(require("node:os").tmpdir(), "veyra");
const jobs = new Map();
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const RATE_LIMIT_PER_IP = Number(process.env.RATE_LIMIT_PER_IP || 30);
const DOWNLOADS_PER_IP_WINDOW = Number(process.env.DOWNLOADS_PER_IP_WINDOW || 10);
const DOWNLOADS_PER_USER_WINDOW = Number(process.env.DOWNLOADS_PER_USER_WINDOW || 20);
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_BYTES || 16 * 1024);
const MAX_CONCURRENT_PER_IP = Number(process.env.MAX_CONCURRENT_PER_IP || 3);
const MAX_CONCURRENT_PER_USER = Number(process.env.MAX_CONCURRENT_PER_USER || 5);
const rateBuckets = new Map();
const quotaBuckets = new Map();
const activeByIp = new Map();
const activeByUser = new Map();
const ADMIN_STATUS_TOKEN = process.env.ADMIN_STATUS_TOKEN || "";
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false").toLowerCase() === "true";

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 180000);
const SOCIAL_HOSTS = [
  /(^|\.)youtube\.com$/i, /(^|\.)youtu\.be$/i,
  /(^|\.)tiktok\.com$/i, /(^|\.)instagram\.com$/i,
  /(^|\.)facebook\.com$/i, /(^|\.)fb\.watch$/i,
  /(^|\.)twitter\.com$/i, /(^|\.)x\.com$/i,
  /(^|\.)reddit\.com$/i, /(^|\.)vimeo\.com$/i,
  /(^|\.)dailymotion\.com$/i, /(^|\.)twitch\.tv$/i,
  /(^|\.)rumble\.com$/i
];
function isSocialUrl(raw) { try { const u = new URL(raw); return SOCIAL_HOSTS.some(r => r.test(u.hostname)); } catch { return false; } }
function detectSource(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const rules = [
      ['YouTube', ['youtube.com','youtu.be']],
      ['TikTok', ['tiktok.com']],
      ['Instagram', ['instagram.com']],
      ['Facebook', ['facebook.com','fb.watch']],
      ['X / Twitter', ['x.com','twitter.com']],
      ['Reddit', ['reddit.com','redd.it']],
      ['Vimeo', ['vimeo.com']],
      ['Dailymotion', ['dailymotion.com']],
      ['Twitch', ['twitch.tv']],
      ['Rumble', ['rumble.com']]
    ];
    for (const [name, hosts] of rules) if (hosts.some(h => host === h || host.endsWith('.' + h))) {
      return { provider:name, hostname:host, kind:'platform', handler:'yt-dlp' };
    }
    return { provider:host || 'Unknown source', hostname:host, kind:'direct-or-web', handler:'direct-first' };
  } catch { return { provider:'Unknown source', hostname:'', kind:'invalid', handler:'none' }; }
}
function getYouTubeId(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      if (['shorts','embed','live'].includes(parts[0])) return parts[1] || null;
    }
  } catch {}
  return null;
}
function youtubeEmbedUrl(id) {
  return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=0&controls=1&playsinline=1&rel=0&iv_load_policy=3&modestbranding=1` : null;
}
async function fetchYouTubeOEmbed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      headers: { 'User-Agent': 'Veyra/1.1' }, signal: controller.signal
    });
    if (!r.ok) throw new Error(`oEmbed HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
function ytdlpFormat(quality, format) {
  const q = String(quality || "best").match(/\d+/)?.[0];
  if (q) return format === "webm" ? `bv*[height<=${q}][ext=webm]+ba[ext=webm]/b[height<=${q}][ext=webm]/bv*[height<=${q}]+ba/b[height<=${q}]` : `bv*[height<=${q}][ext=mp4]+ba[ext=m4a]/b[height<=${q}][ext=mp4]/bv*[height<=${q}]+ba/b[height<=${q}]`;
  return format === "webm" ? "bv*[ext=webm]+ba[ext=webm]/b[ext=webm]/bv*+ba/b" : "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b";
}
function runYtdlp(args, timeout = YTDLP_TIMEOUT_MS) {
  const safeArgs = Array.isArray(args) ? args.slice() : [];
  if (!safeArgs.includes("--js-runtimes")) safeArgs.unshift("--js-runtimes", "deno:/usr/local/bin/deno");
  if (!safeArgs.includes("--remote-components")) safeArgs.unshift("--remote-components", "ejs:github");
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, safeArgs, { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} reject(new Error("The media extractor timed out.")); }, timeout);
    child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
    child.on("error", e => { clearTimeout(timer); reject(new Error(`yt-dlp is unavailable: ${e.message}`)); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve({stdout, stderr}); else reject(new Error((stderr || stdout).trim().split("\n").slice(-1)[0] || `Extractor exited with code ${code}`)); });
  });
}
function ytdlpInfoArgs(url) { return ["--dump-single-json", "--no-playlist", "--skip-download", "--no-warnings", url]; }

const DISCOVERY_CONFIG = {
  home:    { query: 'trending viral videos', prefix: 'ytsearch' },
  shorts:  { query: 'shorts viral videos', prefix: 'ytsearch' },
  new:     { query: 'latest videos', prefix: 'ytsearchdate' },
  popular: { query: 'most viewed popular videos', prefix: 'ytsearch' },
  music:   { query: 'official music videos', prefix: 'ytsearch' },
  gaming:  { query: 'gaming gameplay highlights', prefix: 'ytsearch' },
  sports:  { query: 'sports highlights', prefix: 'ytsearch' },
  movies:  { query: 'movie and TV trailers clips', prefix: 'ytsearch' },
  news:    { query: 'latest news video', prefix: 'ytsearchdate' }
};
const DISCOVERY_QUERIES = Object.fromEntries(Object.entries(DISCOVERY_CONFIG).map(([k,v]) => [k, v.query]));
function normalizeVideoResult(v) {
  const url = v.webpage_url || v.original_url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : null);
  const ytId = url ? getYouTubeId(url) : null;
  return {
    id: v.id || ytId || null,
    url,
    title: v.title || 'Video',
    thumbnail: v.thumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null),
    duration: Number.isFinite(Number(v.duration)) ? Number(v.duration) : null,
    channel: v.uploader || v.channel || null,
    channelId: v.uploader_id || v.channel_id || null,
    viewCount: Number.isFinite(Number(v.view_count)) ? Number(v.view_count) : null,
    uploadDate: v.upload_date || null,
    platform: v.extractor_key || v.extractor || (ytId ? 'YouTube' : 'Video'),
    embedUrl: ytId ? youtubeEmbedUrl(ytId) : null,
    playback: ytId ? 'youtube-embed' : 'extractor'
  };
}
function ytdlpSearchArgs(query, limit=12, prefix='ytsearch', offset=0) {
  // Paginate instead of imposing a small fixed UI result limit. The upstream
  // search provider still determines the actual number of available results.
  const n = Math.max(1, Math.min(Number(limit) || 12, 40));
  const start = Math.max(1, Number(offset) + 1);
  const end = start + n - 1;
  const safePrefix = ['ytsearch', 'ytsearchdate'].includes(prefix) ? prefix : 'ytsearch';
  return [`${safePrefix}all:${query}`, '--playlist-start', String(start), '--playlist-end', String(end), '--flat-playlist', '--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist'];
}

const metrics = {
  startedAt: Date.now(),
  requests: 0,
  downloadStarts: 0,
  throttled: 0,
  rejected: 0,
  completed: 0,
  failed: 0,
  canceled: 0,
  cleanupDeleted: 0,
  cleanupErrors: 0,
  bytesDownloaded: 0
};

function logEvent(event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    event,
    ...fields
  };
  // Structured JSON logs are easy to ingest with common log collectors.
  console.log(JSON.stringify(record));
}

function hashKey(value) {
  // Avoid putting raw IP/user identifiers in logs or admin output.
  let h = 2166136261;
  for (const ch of String(value || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function quotaUsage(map, prefix, limit) {
  const now = Date.now();
  let activeBuckets = 0;
  let consumed = 0;
  let resetsSoonest = null;

  for (const [key, bucket] of map.entries()) {
    if (!key.startsWith(prefix)) continue;
    if (now >= bucket.resetAt) continue;
    activeBuckets += 1;
    consumed += bucket.count;
    if (resetsSoonest === null || bucket.resetAt < resetsSoonest) {
      resetsSoonest = bucket.resetAt;
    }
  }

  return {
    buckets: activeBuckets,
    consumed,
    limit,
    resetAt: resetsSoonest ? Math.ceil(resetsSoonest / 1000) : null
  };
}



fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log(`[Veyra] IP detection: ${TRUST_PROXY ? "trusted proxy headers enabled" : "direct socket IPs only"}`);

app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));
app.get("/watch", (req, res) => res.sendFile(path.join(__dirname, "watch.html")));

function isPrivateIPv4(ip) {
  const [a,b,c,d] = ip.split(".").map(Number);
  return a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0;
}

function isPrivateIPv6(ip) {
  const x = ip.toLowerCase();
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") ||
    x.startsWith("fe80:");
}

async function assertPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Private/local hosts are not supported.");
  }
  if (net.isIP(host)) {
    if ((net.isIPv4(host) && isPrivateIPv4(host)) || (net.isIPv6(host) && isPrivateIPv6(host))) {
      throw new Error("Private/local network addresses are not supported.");
    }
    return;
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length) throw new Error("Host could not be resolved.");
  for (const r of records) {
    if ((net.isIPv4(r.address) && isPrivateIPv4(r.address)) ||
        (net.isIPv6(r.address) && isPrivateIPv6(r.address))) {
      throw new Error("The URL resolves to a private/local network address.");
    }
  }
}

function validateInput(raw) {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 4096) {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (u.username || u.password) throw new Error("URLs containing embedded credentials are not supported.");
  return u;
}

async function fetchWithSafeRedirects(startUrl, options = {}) {
  let current = new URL(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(current.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        method: options.method || "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Veyra/1.0 URL analyzer" }
      });
      clearTimeout(timer);

      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return { response, url: current };
        current = new URL(location, current);
        continue;
      }
      return { response, url: current };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
  throw new Error("Too many redirects.");
}

function bytesToHuman(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ["B","KB","MB","GB","TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function mediaFromContentType(type = "") {
  const t = type.toLowerCase().split(";")[0].trim();
  const map = {
    "video/mp4": ["video","mp4"], "video/webm": ["video","webm"],
    "video/quicktime": ["video","mov"], "video/x-matroska": ["video","mkv"],
    "audio/mpeg": ["audio","mp3"], "audio/mp4": ["audio","m4a"],
    "audio/wav": ["audio","wav"], "audio/ogg": ["audio","ogg"],
    "audio/flac": ["audio","flac"], "application/vnd.apple.mpegurl": ["stream","hls"],
    "application/x-mpegurl": ["stream","hls"], "application/dash+xml": ["stream","dash"]
  };
  return map[t] || null;
}

function mediaFromPath(url) {
  const ext = path.extname(url.pathname).slice(1).toLowerCase();
  const map = {
    mp4:["video","mp4"], webm:["video","webm"], mov:["video","mov"], m4v:["video","m4v"],
    mkv:["video","mkv"], avi:["video","avi"], mp3:["audio","mp3"], m4a:["audio","m4a"],
    wav:["audio","wav"], ogg:["audio","ogg"], flac:["audio","flac"], aac:["audio","aac"],
    m3u8:["stream","hls"], mpd:["stream","dash"]
  };
  return map[ext] ? {type:map[ext][0], format:map[ext][1], ext} : null;
}

function qualityFromText(text = "") {
  const found = [...text.matchAll(/(?:^|[^0-9])(2160|1440|1080|720|480|360|240)p(?:[^0-9]|$)/gi)]
    .map(m => `${m[1]}p`);
  return [...new Set(found)];
}

function qualitiesFor(info, responseUrl) {
  const text = `${responseUrl} ${info.contentType || ""}`;
  const found = qualityFromText(text);
  if (info.format === "hls" || info.format === "dash") {
    // The analyzer does not download or decrypt media. Quality discovery from
    // a manifest can be added with a dedicated parser when the source permits it.
    return found.length ? found : ["Available in source manifest"];
  }
  return found.length ? found : ["Original"];
}



function clientIp(req) {
  // Only trust X-Forwarded-For when the deployment explicitly opts into a trusted proxy.
  if (TRUST_PROXY) {
    const forwarded = req.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function verifiedUserId(req) {
  // Authentication middleware must verify the session/JWT and attach the resulting
  // stable subject to req.auth. Never use a client-supplied user ID as identity proof.
  const value = req.auth && req.auth.userId;
  return value ? String(value).slice(0, 128) : null;
}

function consumeBucket(map, key, limit, windowMs) {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    map.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function activeCount(map, key) {
  return map.get(key) || 0;
}

function incrementActive(map, key) {
  map.set(key, activeCount(map, key) + 1);
}

function decrementActive(map, key) {
  const next = Math.max(0, activeCount(map, key) - 1);
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

function rejectWith(res, status, code, message, retryAfter = 0) {
  if (retryAfter > 0) res.setHeader("Retry-After", String(retryAfter));
  return res.status(status).json({ ok: false, error: message, code, retryAfter });
}

function requestGuards(req, res, next) {
  metrics.requests += 1;
  const ip = clientIp(req);
  const rate = consumeBucket(rateBuckets, ip, RATE_LIMIT_PER_IP, RATE_WINDOW_MS);
  if (!rate.allowed) {
    return rejectWith(res, 429, "RATE_LIMITED", "Too many requests from this IP. Please wait and try again.", rate.retryAfter);
  }

  const contentLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    return rejectWith(res, 413, "REQUEST_TOO_LARGE", `Request is too large. Maximum request size is ${bytesToHuman(MAX_REQUEST_BODY_BYTES)}.`);
  }
  next();
}

function setQuotaHeaders(res, { limit, remaining, resetAt }) {
  res.setHeader("X-Veyra-Quota-Limit", String(limit));
  res.setHeader("X-Veyra-Quota-Remaining", String(Math.max(0, remaining)));
  res.setHeader("X-Veyra-Quota-Reset", String(Math.ceil(resetAt / 1000)));
}

function downloadQuotaGuard(req, res, next) {
  const ip = clientIp(req);
  const user = verifiedUserId(req);

  const ipQuotaKey = `ip:${ip}`;
  const ipQuota = consumeBucket(quotaBuckets, ipQuotaKey, DOWNLOADS_PER_IP_WINDOW, RATE_WINDOW_MS);
  const ipBucket = quotaBuckets.get(ipQuotaKey);
  setQuotaHeaders(res, {
    limit: DOWNLOADS_PER_IP_WINDOW,
    remaining: DOWNLOADS_PER_IP_WINDOW - (ipBucket?.count || 0),
    resetAt: ipBucket?.resetAt || (Date.now() + RATE_WINDOW_MS)
  });

  if (!ipQuota.allowed) {
    return rejectWith(res, 429, "IP_QUOTA_EXCEEDED", "Your IP download quota has been reached. Please try again later.", ipQuota.retryAfter);
  }

  if (user) {
    const userQuotaKey = `user:${user}`;
    const userQuota = consumeBucket(quotaBuckets, userQuotaKey, DOWNLOADS_PER_USER_WINDOW, RATE_WINDOW_MS);
    const userBucket = quotaBuckets.get(userQuotaKey);
    const userRemaining = DOWNLOADS_PER_USER_WINDOW - (userBucket?.count || 0);
    setQuotaHeaders(res, {
      limit: DOWNLOADS_PER_USER_WINDOW,
      remaining: userRemaining,
      resetAt: userBucket?.resetAt || (Date.now() + RATE_WINDOW_MS)
    });
    if (!userQuota.allowed) {
      return rejectWith(res, 429, "USER_QUOTA_EXCEEDED", "Your user download quota has been reached. Please try again later.", userQuota.retryAfter);
    }
    req.streamdropUserQuota = {
      limit: DOWNLOADS_PER_USER_WINDOW,
      remaining: userRemaining,
      resetAt: userBucket.resetAt
    };
  }

  if (activeCount(activeByIp, ip) >= MAX_CONCURRENT_PER_IP) {
    return rejectWith(res, 429, "IP_CONCURRENCY_LIMIT", "Too many downloads are already running from this IP. Finish or cancel one before starting another.", 5);
  }

  if (user && activeCount(activeByUser, user) >= MAX_CONCURRENT_PER_USER) {
    return rejectWith(res, 429, "USER_CONCURRENCY_LIMIT", "Too many downloads are already running for this user. Finish or cancel one before starting another.", 5);
  }

  req.streamdropIp = ip;
  req.streamdropUser = user;
  next();
}

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id, status: "starting", url: null, response: null, controller: null,
    bytes: 0, total: null, speed: 0, startedAt: Date.now(), updatedAt: Date.now(),
    error: null, filePath: null, contentType: null, fileName: null,
    expiresAt: Date.now() + JOB_RETENTION_MS
  };
  jobs.set(id, job);
  return job;
}

function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.expiresAt = Date.now() + JOB_RETENTION_MS;
  setTimeout(async () => {
    const current = jobs.get(id);
    if (!current) return;
    if (Date.now() < current.expiresAt) return;
    if (current.controller) {
      try { current.controller.abort(); } catch {}
    }
    if (current.filePath) {
      try { await fsp.unlink(current.filePath); } catch {}
    }
    releaseActiveSlot(current);
    jobs.delete(id);
  }, JOB_RETENTION_MS + 1000);
}


function releaseActiveSlot(job) {
  if (job.slotReleased) return;
  job.slotReleased = true;
  if (job.ownerIp) decrementActive(activeByIp, job.ownerIp);
  if (job.ownerUser) decrementActive(activeByUser, job.ownerUser);
}

async function startDownloadJob(job, rawUrl) {
  let output;
  try {
    const input = validateInput(rawUrl);
    const checked = await fetchWithSafeRedirects(input.href, { method: "HEAD" });
    let finalUrl = checked.url;
    let response = checked.response;

    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);

    const contentType = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`The file exceeds the ${bytesToHuman(MAX_DOWNLOAD_BYTES)} per-job limit.`);
    }

    await assertPublicHost(finalUrl.hostname);

    const controller = new AbortController();
    job.controller = controller;
    job.url = finalUrl.href;
    job.total = Number.isFinite(length) && length > 0 ? length : null;
    job.status = "downloading";
    job.startedAt = Date.now();
    job.expiresAt = Date.now() + JOB_RETENTION_MS;

    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const upstream = await fetch(finalUrl.href, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "Veyra/1.0 downloader" }
    });
    clearTimeout(timer);

    if (!upstream.ok) throw new Error(`Download source returned HTTP ${upstream.status}.`);
    const upstreamType = upstream.headers.get("content-type") || contentType || "application/octet-stream";
    const upstreamLength = Number(upstream.headers.get("content-length"));
    if (!job.total && Number.isFinite(upstreamLength) && upstreamLength > 0) job.total = upstreamLength;
    if (job.total && job.total > MAX_DOWNLOAD_BYTES) {
      throw new Error(`The file exceeds the ${bytesToHuman(MAX_DOWNLOAD_BYTES)} per-job limit.`);
    }

    job.response = upstream;
    job.contentType = upstreamType.split(";")[0];
    const baseName = decodeURIComponent(path.basename(finalUrl.pathname) || `streamdrop-${job.id}`);
    job.fileName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || `streamdrop-${job.id}`;
    job.filePath = path.join(TEMP_DIR, `${job.id}.download`);

    output = fs.createWriteStream(job.filePath, { flags: "wx", mode: 0o600 });
    const reader = upstream.body?.getReader();
    if (!reader) throw new Error("The source did not provide a readable media stream.");

    let totalBytes = 0;
    let lastSampleAt = Date.now(), lastSampleBytes = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;

      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error(`The file exceeded the ${bytesToHuman(MAX_DOWNLOAD_BYTES)} per-job limit.`);
      }

      if (!output.write(Buffer.from(value))) {
        await new Promise((resolve, reject) => {
          output.once("drain", resolve);
          output.once("error", reject);
        });
      }

      job.bytes = totalBytes;
      const now = Date.now();
      const elapsed = Math.max(1, now - lastSampleAt);
      if (elapsed >= 250) {
        job.speed = Math.max(0, (totalBytes - lastSampleBytes) / (elapsed / 1000));
        lastSampleAt = now;
        lastSampleBytes = totalBytes;
        job.updatedAt = now;
      }
    }

    await new Promise((resolve, reject) => {
      output.end(() => resolve());
      output.once("error", reject);
    });
    output = null;

    job.bytes = totalBytes;
    job.status = "complete";
    job.speed = 0;
    job.updatedAt = Date.now();
    job.expiresAt = Date.now() + JOB_RETENTION_MS;
  } catch (err) {
    try { await output?.close(); } catch {}
    if (job.filePath) {
      try { await fsp.unlink(job.filePath); } catch {}
    }
    job.filePath = null;
    if (job.status !== "canceled") {
      job.status = "error";
      job.error = err?.name === "AbortError" ? "Download canceled." : (err?.message || "Download failed.");
      job.updatedAt = Date.now();
    }
  } finally {
    releaseActiveSlot(job);
    cleanupJob(job.id);
  }
}

async function startSocialDownloadJob(job, rawUrl, quality, format) {
  let child;
  try {
    const input = validateInput(rawUrl);
    const outputTemplate = path.join(TEMP_DIR, `${job.id}.%(ext)s`);
    const args = ["--remote-components", "ejs:github", "--js-runtimes", "deno:/usr/local/bin/deno", "--no-playlist", "--no-warnings", "--newline", "--progress", "--format", ytdlpFormat(quality, format), "--merge-output-format", format === "webm" ? "webm" : "mp4", "--output", outputTemplate, input.href];
    job.status = "downloading"; job.startedAt = Date.now(); job.url = input.href; job.expiresAt = Date.now() + JOB_RETENTION_MS;
    child = spawn(YTDLP_BIN, args, { windowsHide:true }); job.controller = { abort: () => { try { child.kill("SIGTERM"); } catch {} } };
    let stderr = ""; let lastBytes = 0; let lastAt = Date.now();
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.stdout.on("data", d => {
      const text = d.toString();
      const m = text.match(/(\d+(?:\.\d+)?)%/);
      const b = text.match(/(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB)\/s/);
      if (m && job.total) job.bytes = Math.round(job.total * Number(m[1]) / 100);
      if (b) { const units={KiB:1024,MiB:1048576,GiB:1073741824}; job.speed = Number(b[1])*units[b[2]]; }
      job.updatedAt=Date.now();
    });
    const code = await new Promise((resolve,reject)=>{ child.on("error",reject); child.on("close",resolve); });
    if (job.status === "canceled") return;
    if (code !== 0) {
      const raw = stderr.trim().split("\n").slice(-1)[0] || `yt-dlp exited with code ${code}`;
      const lower = raw.toLowerCase();
      if (/bot|sign in|captcha|authentication|login|challenge/.test(lower)) {
        throw new Error("This source temporarily blocked server-side downloading. Try again later or use the source's official player.");
      }
      throw new Error(raw);
    }
    const files = (await fsp.readdir(TEMP_DIR)).filter(n=>n.startsWith(`${job.id}.`) && !n.endsWith(".part"));
    if (!files.length) throw new Error("The extractor completed but no media file was produced.");
    job.fileName = files[0].replace(`${job.id}.`, "") || `streamdrop-${job.id}.mp4`;
    job.filePath = path.join(TEMP_DIR, files[0]);
    const stat = await fsp.stat(job.filePath); job.bytes=stat.size; job.total=stat.size;
    job.contentType = format === "webm" ? "video/webm" : "video/mp4"; job.status="complete"; job.speed=0; job.updatedAt=Date.now(); job.expiresAt=Date.now()+JOB_RETENTION_MS;
  } catch (err) {
    if (job.status !== "canceled") { job.status="error"; job.error=err?.message || "Social video download failed."; job.updatedAt=Date.now(); }
    if (job.filePath) await fsp.unlink(job.filePath).catch(()=>{});
  } finally { releaseActiveSlot(job); cleanupJob(job.id); }
}


async function waitForJobCompletion(job, timeoutMs = DOWNLOAD_TIMEOUT_MS + 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (job.status === "complete" || job.status === "error" || job.status === "canceled") return job.status;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  try { job.controller?.abort?.(); } catch {}
  job.status = "error";
  job.error = "The browser download timed out while preparing the media.";
  return job.status;
}

// Browser-first download endpoint. The media is prepared server-side only as
// needed, but the resulting file is handed directly to the browser as an
// attachment. The Veyra page does not host a download/progress workflow.
app.get("/api/download/browser", downloadQuotaGuard, async (req, res) => {
  let job;
  try {
    const input = validateInput(req.query?.url);
    const quality = String(req.query?.quality || "Best available").slice(0, 40);
    const format = String(req.query?.format || "mp4").toLowerCase() === "webm" ? "webm" : "mp4";
    job = createJob();
    job.ownerIp = req.streamdropIp;
    job.ownerUser = req.streamdropUser;
    incrementActive(activeByIp, req.streamdropIp);
    if (req.streamdropUser) incrementActive(activeByUser, req.streamdropUser);

    if (isSocialUrl(input.href)) startSocialDownloadJob(job, input.href, quality, format);
    else startDownloadJob(job, input.href);

    const status = await waitForJobCompletion(job);
    if (status !== "complete" || !job.filePath) {
      return res.status(502).send(`Veyra could not prepare this browser download. ${job.error || "The source did not provide a downloadable file."}`);
    }

    const stat = await fsp.stat(job.filePath);
    res.setHeader("Content-Type", job.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName || `veyra-${job.id}.mp4`}"`);

    const stream = fs.createReadStream(job.filePath);
    stream.on("error", () => { if (!res.headersSent) res.status(500).end("Unable to read the download."); else res.destroy(); });
    stream.on("close", () => { job.expiresAt = Date.now() + JOB_RETENTION_MS; cleanupJob(job.id); });
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(400).send(err?.message || "Unable to start browser download.");
  }
});

app.post("/api/download/start", downloadQuotaGuard, async (req, res) => {
  try {
    const input = validateInput(req.body?.url);
    const job = createJob();
  job.ownerIp = req.streamdropIp;
  job.ownerUser = req.streamdropUser;
  incrementActive(activeByIp, req.streamdropIp);
  if (req.streamdropUser) incrementActive(activeByUser, req.streamdropUser);
    if (isSocialUrl(input.href)) {
      startSocialDownloadJob(job, input.href, req.body?.quality, req.body?.format);
    } else {
      startDownloadJob(job, input.href);
    }
    res.status(202).json({ jobId: job.id });
  } catch (err) {
    res.status(400).json({ error: err?.message || "Invalid download request." });
  }
});

app.get("/api/quota", (req, res) => {
  const user = verifiedUserId(req);
  if (!user) {
    return res.json({ authenticated: false, userQuota: null });
  }

  const key = `user:${user}`;
  const bucket = quotaBuckets.get(key);
  const now = Date.now();
  if (!bucket || now >= bucket.resetAt) {
    return res.json({
      authenticated: true,
      userQuota: {
        limit: DOWNLOADS_PER_USER_WINDOW,
        remaining: DOWNLOADS_PER_USER_WINDOW,
        resetAt: Math.ceil((now + RATE_WINDOW_MS) / 1000)
      }
    });
  }

  res.json({
    authenticated: true,
    userQuota: {
      limit: DOWNLOADS_PER_USER_WINDOW,
      remaining: Math.max(0, DOWNLOADS_PER_USER_WINDOW - bucket.count),
      resetAt: Math.ceil(bucket.resetAt / 1000)
    }
  });
});

app.get("/api/admin/status", (req, res) => {
  if (!ADMIN_STATUS_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "Admin status endpoint is disabled. Set ADMIN_STATUS_TOKEN."
    });
  }

  const supplied = req.get("authorization") || "";
  const token = supplied.startsWith("Bearer ") ? supplied.slice(7) : "";
  if (!token || token !== ADMIN_STATUS_TOKEN) {
    logEvent("admin.status_denied", { ip: hashKey(clientIp(req)) });
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  const jobsByStatus = {};
  for (const job of jobs.values()) {
    jobsByStatus[job.status] = (jobsByStatus[job.status] || 0) + 1;
  }

  const ipQuota = quotaUsage(quotaBuckets, "ip:", DOWNLOADS_PER_IP_WINDOW);
  const userQuota = quotaUsage(quotaBuckets, "user:", DOWNLOADS_PER_USER_WINDOW);

  logEvent("admin.status_viewed", { ip: hashKey(clientIp(req)) });

  res.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    metrics: { ...metrics },
    activeDownloads: {
      jobs: jobsByStatus.downloading || 0,
      byIp: activeByIp.size,
      byUser: activeByUser.size
    },
    jobsByStatus,
    quotaUsage: {
      ip: ipQuota,
      user: userQuota
    },
    cleanup: {
      deletedFiles: metrics.cleanupDeleted,
      errors: metrics.cleanupErrors,
      retentionMs: JOB_RETENTION_MS
    }
  });
});

app.get("/api/limits", (req, res) => {
  res.json({
    rateWindowSeconds: Math.ceil(RATE_WINDOW_MS / 1000),
    rateLimitPerIp: RATE_LIMIT_PER_IP,
    downloadsPerIpWindow: DOWNLOADS_PER_IP_WINDOW,
    downloadsPerUserWindow: DOWNLOADS_PER_USER_WINDOW,
    maxConcurrentPerIp: MAX_CONCURRENT_PER_IP,
    maxConcurrentPerUser: MAX_CONCURRENT_PER_USER,
    maxRequestBodyBytes: MAX_REQUEST_BODY_BYTES,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    retentionMs: JOB_RETENTION_MS,
    trustProxy: TRUST_PROXY
  });
});

app.get("/api/download/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Download job not found or expired." });

  const elapsed = Math.max(1, Date.now() - job.startedAt);
  const speed = job.speed || (job.bytes / (elapsed / 1000));
  const remaining = job.total && speed > 0 ? Math.max(0, (job.total - job.bytes) / speed) : null;

  res.json({
    jobId: job.id,
    status: job.status,
    bytes: job.bytes,
    totalBytes: job.total,
    speedBytesPerSecond: speed,
    etaSeconds: remaining,
    contentType: job.contentType || null,
    error: job.error || null
  });
});

app.post("/api/download/:id/cancel", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Download job not found or expired." });
  if (job.status === "downloading" || job.status === "starting") {
    job.status = "canceled";
    job.controller?.abort();
    if (job.filePath) {
      await fsp.unlink(job.filePath).catch(() => {});
      job.filePath = null;
    }
    releaseActiveSlot(job);
    job.updatedAt = Date.now();
    job.expiresAt = Date.now() + Math.min(JOB_RETENTION_MS, 5 * 60 * 1000);
    cleanupJob(job.id);
  }
  res.json({ ok: true, status: job.status });
});


app.get("/api/stream", async (req, res) => {
  try {
    const input = validateInput(req.query?.url);
    if (!isSocialUrl(input.href)) return res.status(400).json({ error: "Streaming is currently available for supported social/video URLs." });
    const quality = String(req.query?.quality || "best");
    const height = quality.match(/\d+/)?.[0];
    const format = height
      ? `best[ext=mp4][height<=${height}][vcodec!=none][acodec!=none]/best[height<=${height}][vcodec!=none][acodec!=none]/best`
      : "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best";
    const { stdout } = await runYtdlp(["--no-playlist", "--no-warnings", "--get-url", "--format", format, input.href], 60000);
    const mediaUrl = stdout.trim().split(/\r?\n/).find(Boolean);
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) throw new Error("No playable stream was returned by the extractor.");

    // Proxy the media instead of redirecting the browser. This avoids many cross-origin
    // playback failures and lets the HTML5 player use byte-range seeking.
    const headers = { "User-Agent": "Mozilla/5.0 Veyra/1.0" };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(mediaUrl, { headers, redirect: "follow" });
    if (!upstream.ok && upstream.status !== 206) throw new Error(`Media source returned HTTP ${upstream.status}.`);

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const acceptRanges = upstream.headers.get("accept-ranges");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);
    res.setHeader("Accept-Ranges", acceptRanges || "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (upstream.body) {
      const reader = upstream.body.getReader();
      req.on("close", () => { try { reader.cancel(); } catch {} });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err?.message || "Unable to prepare the stream." });
    else res.destroy();
  }
});

app.get("/api/download/:id/file", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Download job not found or expired." });
  if (job.status !== "complete" || !job.filePath) return res.status(409).json({ error: "Download is not complete." });

  try {
    const stat = await fsp.stat(job.filePath);
    if (Date.now() >= job.expiresAt) {
      await fsp.unlink(job.filePath).catch(() => {});
      jobs.delete(job.id);
      return res.status(410).json({ error: "Download file has expired." });
    }

    res.setHeader("Content-Type", job.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName || `streamdrop-${job.id}`}"`);

    const stream = fs.createReadStream(job.filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "Unable to read the temporary download file." });
      else res.destroy();
    });
    stream.pipe(res);

    // Keep the file available for the remainder of the retention window.
    job.expiresAt = Date.now() + JOB_RETENTION_MS;
    cleanupJob(job.id);
  } catch {
    return res.status(404).json({ error: "Download file is no longer available." });
  }
});

app.post("/api/source-info", async (req, res) => {
  try {
    const input = validateInput(req.body?.url);
    const source = detectSource(input.href);
    const ytId = getYouTubeId(input.href);
    res.json({
      supported: true,
      url: input.href,
      provider: source.provider,
      hostname: source.hostname,
      kind: source.kind,
      handler: source.handler,
      playback: ytId ? 'youtube-embed' : 'auto',
      downloadStrategy: source.kind === 'platform' ? 'platform-handler' : 'direct-first',
      message: source.kind === 'platform'
        ? `${source.provider} detected. Veyra will automatically use the compatible public-source handler.`
        : 'Veyra will automatically inspect this URL and use direct media handling when the URL exposes a downloadable resource.'
    });
  } catch (err) {
    res.status(400).json({ supported:false, error:err?.message || 'Unable to detect the source.' });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const input = validateInput(req.body?.url);
    if (isSocialUrl(input.href)) {
      const ytId = getYouTubeId(input.href);
      let meta = null;
      let extractorError = null;
      try {
        const { stdout } = await runYtdlp(ytdlpInfoArgs(input.href));
        meta = JSON.parse(stdout);
      } catch (err) { extractorError = err; }

      // YouTube can provide public title/thumbnail metadata and official embedded playback
      // even when its media extractor is challenged. Do not try to bypass that challenge.
      if (ytId && !meta) {
        try {
          const o = await fetchYouTubeOEmbed(input.href);
          meta = { title:o.title, author_name:o.author_name, thumbnail_url:o.thumbnail_url };
        } catch (_) {}
      }
      if (!meta) throw extractorError || new Error('The source could not be read.');

      const formats = Array.isArray(meta.formats) ? meta.formats : [];
      const heights = [...new Set(formats.map(f => Number(f.height)).filter(h => Number.isFinite(h) && h > 0))].sort((a,b)=>b-a);
      const qualities = heights.length ? heights.map(h=>`${h}p`) : [];
      const provider = meta.extractor_key || meta.extractor || (ytId ? 'YouTube' : new URL(input.href).hostname);
      const thumbnail = meta.thumbnail || meta.thumbnail_url || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null);
      // A successful extractor response with usable formats is the authoritative
      // signal that server-side downloading can be attempted. When the first
      // metadata pass fails, runYtdlp already retries with the configured EJS
      // runtime/remote components before falling back to public YouTube metadata.
      const downloadableFormats = formats.filter(f => f && (f.url || f.format_id));
      const canDownload = downloadableFormats.length > 0 && !extractorError;
      const embedUrl = ytId ? youtubeEmbedUrl(ytId) : null;
      return res.json({
        supported:true, provider, social:true, url:input.href, title:meta.title || 'Video', thumbnail,
        uploader:meta.uploader || meta.channel || meta.author_name || null, duration:meta.duration || null,
        type:'video', format:'video', formats:canDownload ? ['MP4','WebM'] : [], qualities:canDownload ? qualities : [],
        downloadAvailable:canDownload, playback:embedUrl ? 'youtube-embed' : 'extractor', embedUrl,
        note: canDownload
          ? `${provider} video detected. Choose a quality and download it if you are authorized to do so.`
          : (ytId
            ? 'Download is currently unavailable for this source. You can still watch it using the official YouTube player.'
            : `${provider} video detected, but this source did not expose downloadable media to Veyra.`)
      });
    }
    const first = await fetchWithSafeRedirects(input.href, { method: "HEAD" });
    let response = first.response;
    let finalUrl = first.url;

    let contentType = response.headers.get("content-type") || "";
    let length = Number(response.headers.get("content-length"));
    let info = mediaFromContentType(contentType) || mediaFromPath(finalUrl);

    // Some servers reject HEAD. A small range GET lets us identify the resource
    // without downloading the media body.
    if (!response.ok || (!info && response.status >= 400)) {
      const fallback = await fetchWithSafeRedirects(input.href, { method: "GET" });
      response = fallback.response;
      finalUrl = fallback.url;
      contentType = response.headers.get("content-type") || contentType;
      if (!Number.isFinite(length) || length <= 0) length = Number(response.headers.get("content-length"));
      info = mediaFromContentType(contentType) || mediaFromPath(finalUrl);
      if (response.body) {
        try { await response.body.cancel(); } catch {}
      }
    }

    if (!response.ok) {
      return res.status(422).json({
        supported: false,
        error: `Source returned HTTP ${response.status}.`
      });
    }

    info = info || { type: "unknown", format: "unknown" };

    // A normal webpage is not treated as a downloadable media URL.
    if (info.type === "unknown") {
      return res.status(422).json({
        supported: false,
        error: "This URL does not appear to be a direct media resource.",
        finalUrl: finalUrl.href
      });
    }

    const qualities = qualitiesFor({ ...info, contentType }, finalUrl.href);
    const title = decodeURIComponent(path.basename(finalUrl.pathname) || "Media").replace(/\.[^.]+$/, "");

    res.json({
      supported: true,
      url: finalUrl.href,
      title,
      type: info.type,
      format: info.format,
      contentType: contentType.split(";")[0] || null,
      sizeBytes: Number.isFinite(length) && length > 0 ? length : null,
      size: bytesToHuman(length),
      formats: [info.format.toUpperCase()],
      qualities,
      note: (info.format === "hls" || info.format === "dash")
        ? "Quality availability is reported from the public stream URL; DRM/authenticated streams are not supported."
        : "Direct media detected."
    });
  } catch (err) {
    const message = err?.name === "AbortError"
      ? "The source took too long to respond."
      : (err?.message || "Unable to analyze this URL.");
    res.status(400).json({ supported: false, error: message });
  }
});


app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length > 160) return res.status(400).json({ error: 'Enter a search query.' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 16, 1), 40);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { stdout } = await runYtdlp(ytdlpSearchArgs(q, limit, 'ytsearch', offset), YTDLP_TIMEOUT_MS);
    const data = JSON.parse(stdout);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const videos = entries.filter(Boolean).map(normalizeVideoResult).filter(v => v.url);
    res.json({ query: q, source: 'youtube', videos, offset, limit, nextOffset: offset + videos.length, hasMore: videos.length >= limit });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Video search is unavailable.' });
  }
});

app.get('/api/discover', async (req, res) => {
  try {
    const category = String(req.query.category || 'home').toLowerCase();
    const cfg = DISCOVERY_CONFIG[category] || DISCOVERY_CONFIG.home;
    const q = String(req.query.q || cfg.query).trim().slice(0, 160);
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 40);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { stdout } = await runYtdlp(ytdlpSearchArgs(q, limit, cfg.prefix, offset), YTDLP_TIMEOUT_MS);
    const data = JSON.parse(stdout);
    const videos = (Array.isArray(data.entries) ? data.entries : []).filter(Boolean).map(normalizeVideoResult).filter(v => v.url);
    res.json({ category, query: q, source: 'youtube', videos, offset, limit, nextOffset: offset + videos.length, hasMore: videos.length >= limit });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Discovery is unavailable.' });
  }
});

app.get('/api/recommendations', async (req, res) => {
  try {
    const seed = String(req.query.seed || req.query.q || 'popular videos').trim().slice(0, 160);
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 24);
    const { stdout } = await runYtdlp(ytdlpSearchArgs(`${seed} recommended`, limit), YTDLP_TIMEOUT_MS);
    const data = JSON.parse(stdout);
    const videos = (Array.isArray(data.entries) ? data.entries : []).filter(Boolean).map(normalizeVideoResult).filter(v => v.url);
    res.json({ seed, source: 'youtube', videos });
  } catch (err) {
    res.status(502).json({ error: err?.message || 'Recommendations are unavailable.' });
  }
});

app.get("/api/health", async (req,res) => {
  const check = (bin, args) => new Promise(resolve => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", d => out += d);
    child.on("error", e => resolve({ ok:false, error:e.message }));
    child.on("close", code => resolve({ ok:code === 0, version:out.trim().split(/\r?\n/)[0] || null }));
  });
  const [extractor, deno, ffmpeg] = await Promise.all([
    check(YTDLP_BIN, ["--version"]),
    check("deno", ["--version"]),
    check(process.env.FFMPEG_BIN || "ffmpeg", ["-version"])
  ]);
  res.json({
    ok: extractor.ok && deno.ok && ffmpeg.ok,
    service: "veyra-media",
    version: "4.8.0",
    dependencies: { extractor, deno, ffmpeg },
    tempDir: TEMP_DIR
  });
});


async function sweepTempFiles() {
  try {
    const entries = await fsp.readdir(TEMP_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".download")) continue;
      const file = path.join(TEMP_DIR, entry.name);
      try {
        const stat = await fsp.stat(file);
        if (now - stat.mtimeMs > JOB_RETENTION_MS) await fsp.unlink(file);
      } catch {}
    }
  } catch {}
}
setInterval(sweepTempFiles, Math.max(60_000, Math.min(JOB_RETENTION_MS, 5 * 60_000))).unref();
sweepTempFiles();

app.listen(PORT, HOST, () => {
  console.log(`Veyra running on ${HOST}:${PORT}`);
});
