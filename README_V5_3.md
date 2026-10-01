# Veyra v5.3 — Device-First Browser Delivery

This release makes the browser the final media requester whenever Veyra can safely resolve a permitted public media URL.

## Flow
1. Veyra detects the source.
2. Direct media URLs are sent back to the browser unchanged.
3. Supported public platform URLs are resolved with the configured extractor to a media URL.
4. The browser requests that resolved media URL directly.
5. If no browser-usable media URL can be resolved, Veyra falls back to its existing attachment endpoint.
6. Source verification, authentication, CAPTCHA, DRM, and anti-bot protections are not bypassed.

## New endpoint
`GET /api/download/resolve`

Returns a JSON media URL only when Veyra can obtain a permitted public media resource. It never returns cookies or authentication material.

## Important limitation
A browser-first architecture cannot turn a protected platform URL into a downloadable URL. If the platform refuses extraction, Veyra uses its existing diagnostic/fallback behavior.
