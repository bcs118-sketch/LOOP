# LOOP reporting integration: source-level change, not a deployment

## What this package does

A dependency-free browser/Node client for the **documented Sites reporting API** in this repository's existing README. It supports authenticated same-origin reads, draft creation, draft editing, private photo uploads, explicit handoff approval, and approved packet retrieval. It preserves response JSON rather than inventing a server response model. TypeScript declarations are included.

It deliberately has **no government submit method**. Approval and packet retrieval do not mean a request reached a city. It does not call the separate hackathon backend's `/api/311/...` or photo-analysis endpoints.

The module has no HTML/CSS, changes no LOOP assets, stores no photos or credentials in local storage, and cannot forward session credentials to a different browser origin. The server still must enforce authentication, ownership, Origin checks, version conflicts, quotas and approval invalidation. Browser checks are not a substitute for these controls.

## Current integration status

**Not imported into or deployed on the live app.** At inspection, `bcs118-sketch/LOOP` contained only `README.md`. The version-12 application source and Sites deployment editor were not accessible in this working session. Consequently this package is not claimed to replace, export, or complete version 12.

The original source referenced in this repository is the Vinext/React + D1/R2 Sites pilot. `JoseBernardS/hackathon_ai_frontend` and `hackathon_ai_backend` are different applications/contracts. Do not replace the live Sites source with those repositories or copy their unauthenticated phone-login behavior into this client.

## Run the tests

With Node.js 22 (tested locally with 22.16.0):

```sh
node --test tests/report-client.test.mjs
```

Tests cover request-ID retention, review consent, confirmed-location gating, version conflicts, upload validation and multipart encoding, login HTML mistaken for API success, timeout ambiguity, transport bounds, and a complete **local fixture HTTP** sequence of draft → photo → approve → packet. There are no model or government calls in the tests. Passing these tests does not prove production storage, AI accuracy, or municipal submission.

## Attach to the existing UI when its source is available

Import `ReportClient` and `prepareDraft` from `integration/report-client.mjs` in the existing reporting controller. Keep existing HTML, components, animations, and assets. Use the existing server `ReportInput` type and response decoder; they are not available here, so this package intentionally does not fabricate their fields.

1. Construct `new ReportClient()` on the same origin as the API. The browser supplies the real session. Never fabricate identity headers or expose a model key.
2. After the resident confirms the exact affected location, prepare the existing form input once with `prepareDraft(input)`. Keep this snapshot and its `request_id` while the save is unresolved.
3. Call `saveDraft(prepared, { locationConfirmed: true })` only from that confirmed action. If its result is uncertain, reconcile the saved draft with the server; a deliberate retry must use the **same** prepared payload and ID. There are no automatic write retries.
4. Decode the authoritative report ID and version using the current server contract. Pass those to `uploadPhoto(id, file, version)`. Use the new returned server version afterward. Signature checking is an early UX check, not full image decoding or EXIF removal.
5. Show the exact current report, route and privacy warning. Call `approveHandoff(id, version, { consent: true })` only after the resident approves that displayed revision. On any edit or 409, discard the displayed approval and refresh/re-review; do not silently retry it.
6. Get the approved JSON/plain-text packet. The existing vetted route controls the official link. Do not display "submitted" or "accepted" on download or link-open.

Errors are typed. `SIGN_IN_REQUIRED` means reauthenticate using the app's existing flow. `CONFLICT` means refresh and review. `uncertain: true` means a write may have reached the server. Show messages through React escaping or `textContent`, not `innerHTML`.

## Optional public connectivity check

```sh
node scripts/check-backend.mjs https://community-voice-reporting-bsw-2026.sweet-swan-9023.chatgpt.site
```

This performs only GET requests to `/api/capabilities` and `/api/session`. It sends no bearer token and creates no records. It distinguishes a JSON endpoint from a sign-in HTML page. A failed check means this environment could not verify access, not proof that the site is down.

## Remaining blockers

- Restore access to the deployed version-12 source/editor, then wire these handlers to its current form and verify the exact request/response schema against the real backend.
- Provide the vision service credential through server-side secret configuration, not chat, source control or a browser environment variable. No credential was available or configured in this session.
- Run authenticated owner-isolation, upload, edit/approval-invalidation and actual image-analysis checks in a designated staging environment before release. Use synthetic reports and no final agency submission.

This change does not certify App Store readiness, implement native authentication, complete a privacy review, enable AI inference, or submit municipal forms.
