# Veyra Robust Download Diagnostics

This version adds source-aware failure classification and a diagnostic endpoint.

## New endpoint
`POST /api/download/diagnose` with `{ "url": "https://..." }`.

It distinguishes common cases such as:
- READY
- SOURCE_PROTECTION
- ACCESS_DENIED
- NOT_FOUND
- TRANSIENT_SOURCE_ERROR
- REDIRECT_ERROR
- SIZE_LIMIT
- NO_MEDIA
- DOWNLOAD_FAILED

It never attempts to bypass CAPTCHA, authentication, DRM, or anti-bot protections.

## Direct-media resilience
Direct downloads now tolerate sources that reject `HEAD` by probing with a normal request before failing.

## Browser-download errors
`/api/download/browser` returns structured JSON diagnostics when preparation fails, making the failure actionable instead of a generic 502 message.
