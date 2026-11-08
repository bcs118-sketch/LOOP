# Community Voice — functional reporting pilot

This is a small, server-backed Miami-Dade reporting system for exactly three cases:

1. Potholes
2. Streetlight outages
3. Illegal dumping

The interface is intentionally replaceable. The data model, GIS routing, approval, private evidence storage, report packets, and event log are exposed through JSON API routes.

## What actually works

- Authenticated, owner-scoped reports persisted in Cloudflare D1.
- Private JPEG/PNG/WebP evidence uploads in R2, with server-side size and file-signature checks.
- Live, read-only Miami-Dade ArcGIS jurisdiction and maintenance lookups.
- Explicit handling of multiple nearby asset owners, missing data, GIS failures, emergencies, and out-of-pilot locations.
- Draft editing invalidates prior approval. Version checks protect concurrent edits and approvals.
- Resident review/approval of the exact report, destination, and public-records warning.
- Official County/City 311 or FPL portal handoffs, phone routing, copyable report text, and downloadable packets.
- Where the verified County 311 email route applies, a downloadable unsent `.eml` draft includes the evidence photo. The resident must send it in their email client.
- Resident-entered external case numbers and status notes, explicitly labeled **not independently verified**.
- Per-report event history and duplicate-save protection.

## What this pilot deliberately does not claim

- It does **not** automatically submit government requests. No authorized production submission API or mail-delivery credential is configured.
- Opening an official link, downloading a packet, approving a draft, or saving a case number does not prove agency acceptance.
- It does not classify images with AI. The resident selects one of the three issue types; photos are evidence.
- It does not automatically poll agency statuses, maintain public discussion threads, or publish resident photos.
- It does not use the model to decide jurisdiction. GIS evidence and reviewed routing rules determine the route, with uncertain results directed to assistance.

## Stack and structure

- Vinext / React, deployed as a Cloudflare Worker through Sites.
- `lib/report-types.ts`: shared client/API contract.
- `lib/report-domain.ts`: validation, approval requirements, image signatures, report packets.
- `lib/routing.ts`: live read-only ArcGIS adapter and deterministic routing rules.
- `lib/api.ts`: authenticated report operations, D1/R2 persistence, optimistic concurrency and packet downloads.
- `app/api/[...path]/route.ts`: thin API transport layer.
- `app/reporting-client.tsx`: minimal replaceable UI.
- `db/schema.ts` and `drizzle/`: versioned schema and migrations.
- `tests/`: domain/routing tests and local integration checks.

OpenContext is not a runtime dependency in this pilot. The same typed read functions can later be exposed through an OpenContext/MCP adapter without moving government writes into a general-purpose AI tool.

## API

All user-record operations require platform-provided ChatGPT identity. Writes require a matching Origin header. Photos and records are authorized per owner on every request. The public capability description contains no user data.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/capabilities` | Supported categories and honest capability flags |
| GET | `/api/session` | Signed-in user display information |
| GET | `/api/reports` | Owner's most recent 100 reports |
| POST | `/api/reports` | `{ input, request_id }` saves a draft and resolves live routing |
| GET | `/api/reports/:id` | Owner's report, source evidence, and events |
| PATCH | `/api/reports/:id` | `{ input, version }` edits a draft and re-resolves routing |
| DELETE | `/api/reports/:id` | `{ version }` deletes an unsubmitted draft and its photo |
| POST | `/api/reports/:id/photo` | Multipart `photo` and `version`; max 8 MiB |
| GET | `/api/reports/:id/photo` | Private photo, owner only |
| POST | `/api/reports/:id/approve` | `{ version, consent: true }`; authorizes handoff, not auto-submission |
| GET | `/api/reports/:id/packet` | Approved packet JSON |
| GET | `/api/reports/:id/packet.txt` | Download the approved report text |
| GET | `/api/reports/:id/packet.eml` | Download an unsent email draft with attached photo, where supported |
| POST | `/api/reports/:id/receipt` | `{ version, case_number, resident_reported_status, receipt_note, confirm_submitted: true }` |

API errors return `{ "error": "..." }` with a meaningful HTTP status. A 409 means the record changed, approval is missing, or the requested transition is invalid; refresh instead of blindly replaying a write.

## State and truthfulness

- `draft`: saved here only.
- `needs_user_action`: the resident approved the report; completing the official portal/email/phone workflow is still required.
- `external_case_recorded`: the resident entered an external case number. The case and status are not independently verified.
- `sent_unverified` is reserved in the shared contract but no current operation sets it.

Routing confidence describes GIS evidence, not the agency's receipt or acceptance. `closed` in a resident-entered status is not confirmation that the physical problem was resolved.

## Deployment and development

`.openai/hosting.json` declares `DB` and `BUCKET`; Sites provisions production storage. Preserve the existing project ID. No mail or model keys are required for this handoff pilot.

1. Install with the Sites dependency helper or the project's locked package manager.
2. Generate schema migrations after changing `db/schema.ts` (`npm run db:generate`).
3. Run `node --experimental-strip-types --test tests/*.test.ts` and `node node_modules/typescript/bin/tsc --noEmit`.
4. Build through the Sites build helper. Apply generated migrations separately to the local D1 preview; production migrations are applied by publication.
5. Use the Sites managed preview for browser QA. Never add fake production identity or use a public API endpoint to spoof authentication.

## Municipal worker workspace

The resident header now links to `/municipal/index.html`, a LOOP-style municipal
operations demonstration. It supports a work-order inbox, responsibility review,
department → capable crew → individual assignment, a crew itinerary optimizer,
an employee field view, repair/blocker notes, separate demo public replies, and an
activity log. Demo mutations persist only in this browser's local storage.

The staff view uses fictional Surfside records and verified-role simulations. It
does not grant real municipal access or read private resident records. Routing
optimizes straight-line distances between approximate coordinates, with optional
urgent-first precedence and return to the depot; a production road-routing service
is not connected. Existing resident API and receipt semantics are unchanged.

See `docs/MUNICIPAL_WORKSPACE.md` for the production integration contract. The
standalone frontend assets are in `public/municipal/`; both domain modules have
tests against the actual served source:

```bash
node --test tests/municipal-data.test.cjs tests/municipal-route-engine.test.cjs
```

## Miami-Dade civic data and AI tools

`/civic/` is a live public-data workspace, linked from the resident and municipal
views. Its five curated official ArcGIS sources cover municipalities, road
maintenance, waste service areas, County parks, and the published 2026 County 311
extract. The 311 source is a lagging BETA extract, not a dispatch queue. Dataset
notes and retrieval provenance accompany every query and grouped count.

The Worker adapts Boston OpenContext's configurable data-plugin/MCP architecture
to TypeScript; it does not run or fork the upstream Python server. The separate
public adapter has no D1/R2 access and exposes no resident records or municipal
mutations. `POST /mcp` offers five read-only tools through the Site's personal
plugin: catalog search, field schema, filtered/paged data, grouped statistics,
and the existing evidence-based responsibility lookup. The HTTP equivalents are
under `/api/civic/`. See `docs/MIAMI_DADE_OPENCONTEXT.md` for contracts, source
coverage, protocol behavior, examples, and attribution.

Queries accept registry dataset/field IDs and structured filters, never an
arbitrary source URL or caller-written SQL. Queries return at most 50 records,
source responses and timeouts are bounded, and truncated aggregates fail with an
explicit error. Date-only filters include whole UTC days. Source outages and
schema changes remain visible errors. Geography alone never grants maintenance
authority or confirms a physical repair.

## Direct-submission integration seam

To add genuine direct submissions, agree on an official agency/vendor integration, then implement a server-side adapter with authorized credentials and a verified service code. Add `submitted`/`agency_accepted` states only when the receiving system returns documented receipts. Keep credentials server-only, bind approval to the exact payload and destination, and reconcile uncertain responses before retries. Do not scrape around CAPTCHA, login, or permission controls.

## Source notes

Routing source URLs and retrieval timestamps are returned with every report. The source catalogue and jurisdiction exceptions are documented in `docs/ROUTING_SOURCES.md`. Public datasets may be incomplete or stale; the pilot reports uncertain results rather than guessing. Both County and municipal responsibilities can overlap, and a nearby line feature does not identify an individual pole with certainty.

Photos may contain identifiable people, addresses, or metadata. Private app storage does not make a later government submission confidential. Residents must review evidence and contact details before completing the official handoff.
