# Veyra 4.8

A clean, mobile-friendly video downloader front end inspired by the simplicity of downloader apps.

## What is included
- URL input with Paste button
- Analyze flow
- Format selector: MP4 / WebM / MP3
- Quality selector
- Large one-click Download button
- Local download history
- Light/dark mode
- Responsive mobile layout

## Important implementation note
The included front end downloads a URL only when the browser/server permits that resource to be downloaded. Many video platforms do not expose a downloadable media file directly, and browsers also enforce CORS and other restrictions.

For a production service, connect the Analyze and Download actions to your own backend that:
1. Accepts only sources you are authorized to process.
2. Resolves the permitted media source.
3. Transcodes it to the requested format/quality with a server-side media tool such as FFmpeg.
4. Streams the resulting file back to the browser.
5. Adds rate limits, abuse protection, file-size limits, temporary storage cleanup, and logging.

Do not use the service to bypass DRM, access private content, or download copyrighted material without permission.

## Run
Open `index.html` directly for the front-end demo, or serve the folder with any static host.

## Production API shape
POST /api/analyze
{ "url": "https://example.com/video.mp4" }

Response:
{ "title": "Example", "formats": [
  { "format": "mp4", "quality": "1080p", "downloadUrl": "/api/download/..." }
]}

POST /api/download
{ "url": "...", "format": "mp4", "quality": "720p" }

The API should validate authorization and source availability before processing.


## Search result previews
The Search tab now shows preview cards when the browser can reach the DuckDuckGo Instant Answer endpoint. Cards can display a thumbnail, title, source domain, snippet, and actions to Copy link, Open, or Use link in Veyra. The selected Google/Bing/DuckDuckGo search also opens in a new tab.

For a production site with comprehensive web results, replace the lightweight preview request with a licensed search API/backend endpoint (for example, your own `/api/search`) rather than scraping search-engine result pages.


## Backend URL analysis

Veyra now includes an Express backend at `server.js`.

### Run locally

1. Install Node.js 18+.
2. Run:
   ```bash
   npm install
   npm start
   ```
3. Open `http://localhost:3000`.

The frontend calls `POST /api/analyze` to validate a URL and return:
- final URL after safe redirects
- media type
- detected format
- content type
- file size when supplied by the source
- quality hints exposed by the URL/source
- a human-readable title

### Security scope

The analyzer is intended for public/direct media resources that the user is authorized to access and download. It does not bypass DRM, authentication, paywalls, private content, or access controls.

The server rejects localhost/private-network destinations and limits redirects/timeouts to reduce SSRF risk.

### Production notes

For broader quality detection, add dedicated parsers for public HLS/DASH manifests where permitted. Do not expose an unrestricted proxy endpoint. Add rate limiting, request logging, abuse controls, caching, and stricter egress/network policy before public deployment.


## Veyra 4.8 downloader upgrade

The downloader now uses a layered, permitted-source strategy:

- direct-media URLs use the safe HTTP download path
- supported public video-platform URLs use yt-dlp with Deno and `yt-dlp-ejs`
- the requested quality is attempted first, followed by a compatible fallback format when codec/container selection fails
- transient extractor/network failures receive limited retries
- download progress is reported from the worker
- access-control failures such as CAPTCHA, login, or bot challenges are reported without attempting to bypass them
- no DRM, private-content, authentication, cookie, or anti-bot bypass is included

The downloader cannot make a platform downloadable when that platform refuses server-side extraction. In that case Veyra should use the platform's official playback path.

### Health check

`GET /api/health` reports Veyra version 4.8.0 and the installed yt-dlp, Deno, and FFmpeg versions.

## Real download backend

The build now includes real backend download jobs for authorized direct media URLs.

Endpoints:
- `POST /api/download/start`
- `GET /api/download/:id/status`
- `POST /api/download/:id/cancel`
- `GET /api/download/:id/file`

The frontend polls the job status and displays actual byte-based progress, speed, and ETA. Completion triggers the browser file download. Cancel requests abort the upstream fetch where supported, and Retry starts a new job.

### Temporary storage and retention

Downloads are written to a temporary server directory instead of being held in RAM. Each job has:
- a configurable maximum size (`MAX_DOWNLOAD_BYTES`, default 2 GB)
- a configurable retention period (`JOB_RETENTION_MS`, default 30 minutes)
- automatic deletion after expiry
- immediate cleanup when a download is canceled or fails
- restrictive temporary-file permissions on supported operating systems
- a periodic sweep that removes stale `.download` files

Optional environment variables:

```bash
MAX_DOWNLOAD_BYTES=1073741824
JOB_RETENTION_MS=1800000
VEYRA_TEMP_DIR=/path/to/private/temp
```

The download response is streamed from the temporary file to the browser after completion.

For production, also add authentication/authorization as appropriate, per-IP/user rate limits, maximum concurrent jobs, stronger MIME validation, and durable job storage if workers are separated.

It does not bypass DRM, authentication, private content, paywalls, or access controls.


### Rate limiting, quotas, and request limits

The backend now enforces several layers of protection:

- Per-IP request rate limit
- Per-IP download-start quota per rate window
- Optional per-user download-start quota using the `X-Veyra-User-Id` header
- Per-IP concurrent download limit
- Per-user concurrent download limit
- JSON request-body size limit
- Existing per-job downloaded-byte limit
- Clear HTTP `429`/`413` responses with machine-readable error codes and `Retry-After` when applicable

Default environment variables:

```bash
RATE_WINDOW_MS=60000
RATE_LIMIT_PER_IP=30
DOWNLOADS_PER_IP_WINDOW=10
DOWNLOADS_PER_USER_WINDOW=20
MAX_CONCURRENT_PER_IP=3
MAX_CONCURRENT_PER_USER=5
MAX_REQUEST_BODY_BYTES=16384
```

The optional user identifier is intentionally supplied by an authenticated application layer; the backend does not treat the client-supplied header as proof of identity. In production, replace it with a trusted authenticated user/session identity.

The frontend translates throttling, quota, request-size, permission, and server errors into clear user-facing messages.

For deployments behind a reverse proxy, configure the proxy's trusted-client/IP handling before using forwarded IP headers. The application does not blindly trust `X-Forwarded-For`.


### Verified per-user quotas

Per-user quotas no longer use `X-Veyra-User-Id` from the browser. A user counts toward a personal quota only when the application has verified authentication and attached a stable subject as:

```js
req.auth = { userId: verifiedSubject };
```

Integrate your existing JWT/session verifier in the authentication middleware before the quota guard. The default build intentionally does not invent an authentication system or trust an unverified identity header.

Download-start responses expose:

- `X-Veyra-Quota-Limit`
- `X-Veyra-Quota-Remaining`
- `X-Veyra-Quota-Reset` (Unix timestamp in seconds)

The frontend reads these headers and displays the remaining authenticated-user quota. `GET /api/quota` also provides the current quota for authenticated users and reports `authenticated: false` when no verified identity is present.


### Proxy-aware IP limiting

For deployments behind a trusted reverse proxy/load balancer, set:

```bash
TRUST_PROXY=true
```

When enabled, Veyra uses the first address in `X-Forwarded-For` for IP quotas and rate limits. Leave it disabled when clients can reach Veyra directly; this prevents clients from spoofing forwarded IP headers to evade limits.

If your infrastructure has multiple proxy hops, configure the edge proxy to overwrite/sanitize `X-Forwarded-For` before enabling this setting.


### Structured logs and admin status

Veyra now emits JSON structured events such as:

- `download.started`
- `download.completed`
- `download.failed`
- `download.canceled`
- `download.throttled`
- `download.rejected`
- `cleanup.deleted`
- `cleanup.error`
- `cleanup.sweep_deleted`
- `cleanup.sweep_error`

IP addresses and authenticated user identifiers are hashed before appearing in logs.

The admin status endpoint is:

```text
GET /api/admin/status
Authorization: Bearer <ADMIN_STATUS_TOKEN>
```

Enable it with:

```bash
ADMIN_STATUS_TOKEN=replace-with-a-long-random-secret
```

The endpoint reports aggregate request/download metrics, throttling/rejection counts, active downloads, job status counts, quota-bucket usage, and cleanup activity. It intentionally does not expose raw IP addresses or user IDs.

For production, put the admin endpoint behind HTTPS and preferably an additional network/authentication boundary.

## Browser save flow

The frontend now uses the real `/api/download/start` job flow instead of simulated progress. It polls the backend for actual bytes, speed, ETA, and completion status.

When the server finishes a job, Veyra **does not automatically trigger the browser download**. The download card changes to **READY TO SAVE** and shows **Save to browser**. Tapping that action requests `/api/download/:id/file`, allowing the browser to handle the normal save/download behavior.

This keeps the frontend clear about the two stages:
1. Veyra prepares the authorized media and reports live progress.
2. The user explicitly saves the completed file through the browser.

The backend remains responsible for temporary-file retention and cleanup. This frontend change does not add DRM bypass, private-access bypass, or unauthorized downloading.


## UI enhancements in this build

- Video-focused search preview with video-only filtering heuristics.
- Video search suggestion chips for faster discovery.
- Selectable video result cards with a VidMate-style prominent Download action.
- Select All / Clear controls and a batch download queue.
- Suggested-video section for additional results.
- Video-only format choices in the main downloader.
- Mobile-first sticky download controls and improved result selection states.
- Batch downloads are queued sequentially to respect server concurrency limits.
- The downloader remains intended for media the user owns or is authorized to download; it does not bypass DRM or access controls.


## Social video extraction
Veyra uses an external `yt-dlp` executable for supported social/video URLs. Configure `YTDLP_BIN` when it is not on PATH. FFmpeg is required for formats that need video/audio merging. The extractor should only be used for content the user is authorized to download and does not bypass DRM. Supported sites depend on the installed yt-dlp version; common providers include YouTube, TikTok, Instagram, Facebook, X/Twitter, Reddit, Vimeo, Dailymotion, Twitch and Rumble.

## Launch checklist (Veyra v2)

Veyra's web app is ready to run as a Node/Express service, but the media features require two external command-line tools:

- **Node.js 18+**
- **yt-dlp** on PATH (or set `YTDLP_BIN`)
- **FFmpeg** on PATH (or set `FFMPEG_BIN`)

From the project directory:

```bash
npm install
npm run doctor
npm start
```

Then open `http://localhost:3000`.

`npm run doctor` does not download anything. It only checks Node.js, yt-dlp, FFmpeg, and Veyra's temporary directory before launch.

### Windows

Install Node.js 18+ first. Install yt-dlp using an installation method appropriate for your machine, then make sure `yt-dlp.exe` is available on PATH. Install FFmpeg and make sure `ffmpeg.exe` is on PATH. If either executable is installed elsewhere, set the corresponding environment variable:

```text
YTDLP_BIN=C:\path\to\yt-dlp.exe
FFMPEG_BIN=C:\path\to\ffmpeg.exe
```

After changing PATH/environment variables, open a new terminal and run `npm run doctor` again.

### What is verified

The v2 build includes live `/api/search`, `/api/discover`, and `/api/recommendations` endpoints, a dedicated `/watch` page, quality-aware downloads, a browser-side batch manager, and responsive mobile navigation. Search/discovery results are sourced through yt-dlp's supported search extraction and should be described as search/category discovery rather than guaranteed platform-wide ranking.

Only download or stream media you are authorized to use. Veyra does not intentionally bypass DRM or authenticated access controls.


## Deploy to Render (free Docker deployment)

This project includes a Render-ready Docker deployment:

- `Dockerfile` installs Node.js, FFmpeg, Python, and the latest yt-dlp into the image.
- `render.yaml` defines a free Render web service and health check.
- `.dockerignore` keeps local/development files out of the image.
- The server binds to `0.0.0.0` and uses Render's `PORT` environment variable.

### Render deployment

1. Put this project in a GitHub repository.
2. In Render, create a **New Blueprint** and select that repository, or create a **Web Service** and choose Docker.
3. If using the Blueprint, Render reads `render.yaml` automatically.
4. If creating the service manually, select the repository, choose Docker, and use `Dockerfile` at the project root.
5. Choose the **Free** instance type.
6. Deploy. Render builds the Docker image and starts Veyra.
7. Open the generated `https://<service-name>.onrender.com` address.

The `/api/health` endpoint is configured as the Render health check.

### Free-tier limitations

The Render free service can sleep after inactivity and has limited compute, storage, and bandwidth. Veyra also uses temporary server storage for completed downloads, so this deployment is intended for testing and early use rather than heavy production traffic. Temporary files are automatically cleaned according to `JOB_RETENTION_MS`.

The service must only process media the user is authorized to download or stream. It does not intentionally bypass DRM, private access controls, or paywalls.


### YouTube playback and downloads

Veyra now uses YouTube's official embedded player when server-side extraction is challenged. This means public YouTube videos can still display their real thumbnail and play on the watch page without attempting to bypass YouTube's anti-bot controls. If yt-dlp can legally access a source, Veyra exposes its available qualities for download; otherwise the download control is disabled with a clear explanation.

The Render Docker image also installs a current yt-dlp build and Deno, which yt-dlp documents as a supported JavaScript runtime for full YouTube extraction support.


## Veyra 4.1 launch fixes
- yt-dlp is installed with its default EJS companion package and Deno is enabled for current YouTube challenge handling.
- Health endpoint reports yt-dlp, Deno, and FFmpeg status.
- UI download dialog now disables Download when the source does not expose a downloadable media stream.
- Veyra localStorage keys are namespaced to the Veyra brand.
- Render temp directory uses VEYRA_TEMP_DIR.


## Veyra 4.5 UI/search update
- Search and category results use pagination with a Load more flow instead of a fixed small card limit.
- Category discovery can continue loading results while the upstream provider has more results.
- Added a Search category shortcut.
- Refined video-card layout, category tabs, loading states, and result controls for a more polished video-platform UI.
- The result source still controls how many results are ultimately available; no web search provider can guarantee literally infinite results.
