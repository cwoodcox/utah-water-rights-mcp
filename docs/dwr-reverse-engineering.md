# Reverse-engineering notes for waterrights.utah.gov

This document captures what we know — and what we've ruled out — about the data surfaces under `waterrights.utah.gov`. It exists so future agents working on this MCP don't have to re-probe everything from scratch.

If you're about to write a new tool, **read this first.** The tradeoffs between the three surfaces (modern JSON API, legacy CGI, ASP apps) are non-obvious, and there are several confidently-attractive paths that turn out to be dead ends.

## The three surfaces

Utah DWR's public site is layered over three eras of infrastructure, each with its own conventions. Mixing them is fine, but the conventions don't transfer.

**1. The modern JSON API at `/api/*`.** A typed REST surface with an OpenAPI catalog at `/api/openapi.json`. The root spec is a stub that links out to **12 sub-APIs**, each with its own `/api/{name}/openapi.json`:

| API | Public? | Notes |
|---|---|---|
| `wr-net` | yes | Hydrography (streams, canals, ponds, nodes). 3 endpoints. We use 2. |
| `distribution-accounting` | yes | The "delivery ledger" — managed-river accounting (Bear, Weber, etc). 13 endpoints, 9 are interesting. We use most. |
| `map-utilities` | yes | Lat/lon → DWR area lookup. 1 endpoint, in use. |
| `measurement` | yes | Real-time gauge scrapes from Metro, ExactRaq, Hydroserver. 3 endpoints. Unwired. |
| `dam-safety` | yes | 20 endpoints — dam master, incidents, modifications, contacts, sensor data, docs, inspectors, hysteresis points. Unwired. |
| `stream-alt` | yes | Stream-alteration permits + ledgers. 9 endpoints. Unwired. |
| `well-driller` | yes | Driller licenses + wells-completed-by-driller. 12 endpoints. Unwired. |
| `water-use` | yes | Per-source water use detail. 1 endpoint by `source_id`. Unwired. |
| `dredge` | yes | 1 endpoint — `GET /dredge/`. Probably useless. |
| `utils` | yes | Virus scanner. Don't bother. |
| `dam-doc` | stub | OpenAPI returns empty paths. Endpoint exists but no public methods. |
| `water-rights` | stub | Same — title is "Water Right Usage API" but the spec has zero paths. **Tempting name, but it's not the thing you want.** Use the wrprint ASP surface instead. |

All `/api/*` endpoints accept plain `GET` (the POSTs need typed bodies, see distribution-accounting). They emit JSON. No auth required. They tolerate (but don't require) browser-like headers.

**2. The legacy CGI at `/cgi-bin/*.exe`.** Two known apps:
- `wrindex.exe` — text search across the static water-rights database. The only path into rights on closed-basin or unmanaged sources (Salt Wells, Hansel Valley, etc.).
- `gageview.exe` — real-time gauge viewer. Unprobed.
- `libview.exe` — publications library. Unprobed.
- `staffapp.exe` — staff app, probably auth-gated.

CGI quirks:
- POST form-encoded, with specific magic field values (`Modinfo`, `Search_Key`, `Key=Display Results`).
- **`wrindex.exe` sometimes returns empty results without a session cookie.** Pattern is *try without; on empty, GET the form page to harvest a cookie, retry once*. Don't unconditionally warm a cookie — it doubles round-trips for the common case where headers alone are enough.
- The response is an HTML `<pre>` block, not JSON. Parsing is line-based; rows span 2–3 lines.

**3. The ASP apps at `/asp_apps/*` and various ASP pages elsewhere.** Server-side rendered HTML. Some pages also expose an AJAX SQL surface (see below). Examples in active use:
- `/asp_apps/wrprint/wrprint.asp` and `wrPrintAction.asp` — water right detail pages.
- `/applicationsrecords/wrAppTracker.asp` (and `chAppTracker`, `exAppTracker`) — application trackers (rendered HTML tables of recent apps).

Things to know:
- ASP pages prefer browser-like headers. `User-Agent: Mozilla/...` is enough; nothing fancy needed.
- Some return `Set-Cookie: ASPSESSIONID...` but most data is reachable without one.
- Many of the dynamic-feeling pages (tabs, lookups) call `lclAjax.asp` or `/siteFiles/glblAjax.asp` with `?xhrPost=GET_*`. Several of these are essentially arbitrary-SQL endpoints (see next section).

## The wrprint AJAX SQL surface (`GET_MULTIPLE_VALUES`)

This is the single most powerful thing we've unlocked. `POST /asp_apps/wrprint/lclAjax.asp?xhrPost=GET_MULTIPLE_VALUES` runs an arbitrary `SELECT` against the `wrDB` database. It's behind no auth; it just needs the right body shape.

**Request shape that works.** Form-encoded body (not JSON — dojo's `xhrPost` serializes its `content:` object as `application/x-www-form-urlencoded`, which is what the server expects). All five keys are required:

```
dbNameId=wrDB
tableNameId=<table>
selectNameId=<columns>     (e.g. "TOP 10 *", "wrnum, use_type")
whereClauseId=<full WHERE>  (literally including "WHERE ...", string literals single-quoted)
orderClauseId=<full ORDER>  (literally including "ORDER BY ...", or empty)
```

Cookie is required: do a `GET /asp_apps/wrprint/wrprint.asp?wrnum=ANYTHING` once and harvest the `ASPSESSIONID...` from `Set-Cookie`. Replay it on subsequent POSTs. The cookie is per-session; module-scope caching across requests is pointless because Workers isolates are too short-lived to amortize.

**Response shape.**
- Success: real JSON, `{"Records":[...], "RecordCount":"N"}`. Note the response has a leading space — `trim()` before `JSON.parse`.
- Empty: single-quoted pseudo-JSON `{'RecordCount':'0'}`. Not parseable as JSON — match with a regex.
- Error: single-quoted pseudo-JSON `{'Error':'No RecordSet to convert to JSON'}`. Usually means bad table name or SQL syntax.

**Confirmed wrDB tables (and what they're keyed on).**

| Table | Key | Notable columns |
|---|---|---|
| `water_uses` | `WRNUM` | `USE_TYPE` (IRR/DOM/STK/MUN/MIN/POW/OTH), `IRRIGATION_ACREAGE`, `STOCK_UNITS`, `DOMESTIC_FAMILIES`, plus parallel `ADJUD_*` adjudicated values, `USE_BEG_DATE`/`USE_END_DATE`, `ADJUD_ACTION_FLAG`, `GROUP_NUMBER` |
| `owners` | `WRCHEX` (not WRNUM!) | `OWNER_FIRST_NAME`/`LAST_NAME`, `OWNER_ADDRESS`/`CITY`/`STATE`/`ZIPCODE`, `OWNER_PHONE`, `OWNER_EMAIL_ADDRESS`, `OWNER_INTEREST` |
| `points_of_diversion` | `WRCHEX` | `POD_TYPE`, `NS_DIRECTION`/`DISTANCE`, `EW_DIRECTION`/`DISTANCE`, `SECTION_CORNER`, `STR`, `DIVERTING_WORKS`, `POD_COMMENT` |
| `place_of_use` | `WRCHEX` | `STR` + quarter-quarter flags `USE_NWNW`/`NENW`/`NWNE`/`NENE`/`SWNW`/`SENW`/`SWNE`/`SENE` (each is a flag for that 40-acre parcel) |
| `group_wrnums` | `GROUP_NUMBER`+`WRNUM` | `SOLE_SUPPLY_IRR`/`STK`/`FAM`/`PER`/`MUN`/`MIN`/`POW`/`OTH` |
| `segregations` | — | Exists, usually empty |

**`WRCHEX` vs `WRNUM`.** This is the big gotcha. Some tables key by `WRNUM` (e.g. `43-10040`), others by `WRCHEX` which appears to be an exchange-style identifier (e.g. `E5428`). They are not interchangeable. When you query a `WRCHEX`-keyed table for a known `wrnum`, try `WHERE wrchex LIKE '%<wrnum>%'` as a first cut — the value is usually padded with leading whitespace too, so `LIKE '%43-10040%'` is more forgiving than `=`.

**Tables we probed and confirmed do NOT exist:** `wr_main`, `wr_master`, `wrinfo`, `water_rights`, `wr_rights`, `rights`, `wr_basic`, `wr_summary`, `wr_general`, `wr_appcheck`, `wr_priority`, `wr_quantity`, `wr_action`, `action_log`, `proof`, `proofs`, `cert`, `certificates`, `applications`, `appls`, `adv`, `advertisement`, `mail_log`, `maillog`, `comments`, `remarks`, `change_apps`, `change_applications`, `wr_cha`, `cha`, `exchanges`, `exchange`, `sources`, `water_sources`, `source_master`, `uses`, `water_use`, `sole_supply`, `approvals`, `approval`, `status`, `wr_status`, `engineer_actions`. **Don't waste time re-probing these names.** If you need to expand the schema, try domain-y names not in this list, and check the wrprint.asp HTML for `tableNameId:` strings — the JS will tell you what the page itself queries.

## The WR master record lives in HTML, not in wrDB

This is unintuitive enough to call out separately: **there is no master water-rights table in wrDB queryable via `GET_MULTIPLE_VALUES`.** The headline summary fields a user actually wants — priority date, quantity in CFS/AF, source description, county, type of right, common description, change-application history, certified status, advertised/protested dates — only exist as a server-side-rendered ASP page.

The page is `/asp_apps/wrprint/wrPrintAction.asp?action=tab_home&wrnum=X&tab=home&companyid=0&forPublicView=0`. It needs no cookie — just a browser User-Agent. It returns roughly 50KB of HTML organized into sections that always appear in this order:

```
Changes
Owners
General
Dates
Points of Diversion
Water Uses
```

The page renders each section as a flat list of `Label: value` pairs separated by `<br>`-like tag soup. Strip tags, walk the line list, and pluck pairs. The current MCP's `parseWrPrintAction` in `src/index.ts` does exactly this. Notable extractable fields:

- **General**: `Quantity of Water` (e.g. "0.13 CFS"), `Source`, `County`, `Type of Right`, `Common Description`, `Proposed Determin. Book`.
- **Dates**: `Filed`, `Priority` (often "/ /1903"-style for pre-statehood claims), `Protested`, `State Engineer Action`, `Action Date`, `Certificate/WUC Date`, `Extension Filed Date`. The Dates section repeats (Filing/Approval/Certification subsections) — taking the first hit per label is correct for the headline.
- **Points of Diversion**: each starts with `(N)` then a description line ("N 1300 feet W 1300 feet from SE corner, Sec 30 T 3S R 10W USBM"), then `Diverting Works:`, `Source:`, `Elevation:`, `UTM:` (NAD83, Zone 12N — e.g. "495564.689, 4448501.34 (NAD83)"), `Stream Alteration Required: Yes/No`.
- **Owners**: repeating `Name:`/`Address:`/`Interest:`/`Remarks:` blocks. Address is multi-line (usually street then city/state/zip).
- **Changes**: triplet pattern `app_number` then `(Filed: MM/DD/YYYY)` then status (Withdrawn/Approved/Pending).

The parser is brittle by nature — DWR could change markup at any time. Wrap it in try/catch, and on parse failure consider falling back to returning the raw cleaned text. The current tool exposes `general` and `dates` as label→value maps in addition to the structured top-level fields, so anything the structured extraction misses is still reachable.

## Application trackers

`/applicationsrecords/{wr,ch,ex}AppTracker.asp` render a server-side HTML table of every application of that type acted on in the last six months (the "last 6 months" window is server-controlled and not currently configurable from the URL). Three types:

- `wrAppTracker.asp` — new water right applications (typically 200–900 rows)
- `chAppTracker.asp` — change applications (200–700 rows)
- `exAppTracker.asp` — exchange applications (~50–100 rows)

**Parsing.** Each data row is a `<tr id="rowN">` followed by `<td>` cells. The columns in order are: row number button, WR number, (empty/details button), `(App number)` in parens, applicant, date filed (with relative age), date advertised, date protest end, protested Y/N, status, hearing date, progress percent, (empty). The last row appends an inline legend table — **truncate to first 13 cells per row** to avoid pulling in the legend.

The progress percent is a lifecycle code, decoded in the embedded legend:

```
0   = Application has been filed
5   = Approved to be advertised
6   = Out of protest period, but no proof of publication received
10  = Proof of publication received, but protested, or application
50  = Proof of publication has been verified and not protested
70  = Hearing has been held
80  = Regional office review complete, waiting for Assistant State Engineer
85  = In central review with Assistant State Engineer
90  = Central review complete, waiting for State or Deputy State Engineer
95  = In final review with State or Deputy State Engineer
100 = Application is complete (approved or rejected)
```

**Filters.** The page has a `<form name="tabForm" method="post">` with select fields `regional`, `yearS`, `Advertised`, `Protested`, `Hearing`, `recentCom` (plus paired `*Mode` toggles). The select options are populated client-side, so the bare HTML only shows "All" — but the visible rendered text lists real values:

- `regional`: All, Cedar City, Logan, Price, Richfield, ULJR, Vernal, Weber
- `yearS`: All, 2026, 2025, ... back several decades
- `Advertised` / `Protested` / `Hearing`: All / Yes / No (guess)

The MCP's `uwr_application_tracker` tool currently does not POST filters — it just GETs the default view and lets the agent filter downstream. If you want server-side filtering later, POST to the same URL with form fields; you'll need to figure out the `*Mode` toggle values by inspecting `<input type="hidden">` defaults in the page.

## Scanned-document URL construction

`GET_SCANNED_DOCUMENTS` (a sibling `xhrPost=` against `lclAjax.asp`) returns records with `wwwpath`, `volname`, `docfilen`, `imgtype`. The actual fetchable URL is:

```
https://www.waterrights.utah.gov{wwwpath}{volname}{docfilen}.{imgtype}
```

**`volname` is in the path** — not in `wwwpath`, despite appearances. An agent earlier got stuck here. Example: `wwwpath=/docSys/v902/e902/`, `volname=E902`, `docfilen=05J7`, `imgtype=TIF` → `/docSys/v902/e902/E90205J7.TIF`.

For TIFs there's also a server-side PDF wrapper that's friendlier for text extraction or browser display:

```
https://www.waterrights.utah.gov/asp_apps/DOCDB/DocImageToPDF.asp?file={wwwpath}{volname}{docfilen}.{imgtype}
```

The MCP's `uwr_scanned_documents` tool emits both as `direct_url` and `pdf_url` on every record.

## Endpoints we know about but haven't probed

Listed roughly in order of expected value:

- **`/api/measurement`** — three scraper endpoints (`metro`, `exactraq`, `hydroserver-day-end`) for instrumented gauge data. Real-time / day-end values from physical sensors. Probably the highest-leverage unused API.
- **`/api/dam-safety`** — 20 endpoints. Dam-specific data including water rights tied to a dam, inspection history, incidents, real-time device data.
- **`/api/stream-alt`** — 9 endpoints. Stream-alteration permits and ledgers.
- **`/api/well-driller`** — 12 endpoints. Driller licensing and wells-completed by driller.
- **`/api/water-use`** — single endpoint `GET /{source_id}`. Per-source water-use data.
- **`/api/distribution-accounting`** — two POST endpoints (`query/measurements`, `query/transactions`) take an `AccountingGraph-Input` body. The agent would need to construct a graph first, which means a multi-step workflow.
- **`/cgi-bin/gageview.exe`** — real-time stream gauges (CGI surface, probably HTML).
- **`/cgi-bin/libview.exe`** — publications library lookup.
- **`/distinfo/realtime_info.asp`** — distribution system real-time info page.
- **`/distinfo/distribution_systems.asp`** — managed distribution systems listing.
- **`/distinfo/colorado/`** — Colorado River system specifics (Lake Powell, Flaming Gorge, priority DD summaries).
- **`/forms/advertListByCounty.asp`** — required legal notices for new water-right applications by county. Complements the application trackers.
- **`/forms/waterCompanies.asp`** — water company directory.
- **`/mailLog/mlMonitor.asp`** — mail-log monitor (correspondence tracking).
- **`/asp_apps/generalWaterUse/WaterUseList.asp`** — general water use listing.
- **`/proofs/`, `/titleInfo/`, `/groundwater/`, `/adjdinfo/`, `/geothermal/`** — content sections; mostly bulk PDFs and reference pages, low automation value, high reading value.

## Things we know not to do

A few attractive paths that turn out to be wrong:

- **Don't query `GET_USE_DATA` or `GET_DIVERSION_DATA` on `glblAjax.asp` thinking they're per-WR.** They return a static 26-record global catalog regardless of `wrchexId`, both with form-encoded and JSON bodies. They're not WR-scoped despite the name.
- **Don't bother with `SET_SESSION_VARIABLE` for `GET_MULTIPLE_VALUES`.** The data fetches read params straight from the form body — the session-variable dance from older example scripts isn't a prerequisite.
- **Don't probe Cloudflare-Workers Durable Objects for session stickiness with these endpoints.** wrindex sometimes wants a cookie, but per-request lifetime is too short for stateful objects to pay for themselves. The try-without-then-retry-with pattern is the right shape.
- **Don't unconditionally warm a cookie on wrindex.exe.** It doubles round-trips on the common path. Retry only on empty results.
- **Don't try to send JSON bodies to ASP-AJAX endpoints.** dojo's `xhrPost` serializes as form-encoded; the ASP code on the other end expects form-encoded; JSON either errors (SET_SESSION_VARIABLE → HTTP 500) or returns a misleading catalog (GET_USE_DATA).
- **Don't expect the `/api/water-rights` API to be the WR detail API.** Despite the title, it's an empty stub. The actual WR detail comes from HTML-parsing `wrPrintAction.asp`.

## Field guide for adding a new tool

A rough decision tree:

1. **Is the data already in an `/api/*` OpenAPI spec?** Use the spec. Cleanest path. Endpoints accept browser headers but don't require them; emit JSON; need no auth.
2. **Is it per-WR detail (priority, quantity, source, owners, PODs)?** It's not in wrDB — parse the HTML from `wrPrintAction.asp?action=tab_home&wrnum=X`. See `parseWrPrintAction` for the pattern.
3. **Is it per-WR structured data the AJAX surface exposes?** (uses, scanned documents, group memberships) Use `GET_MULTIPLE_VALUES` or one of the dedicated `xhrPost=` endpoints. Form-encoded body, cookie-warm from `wrprint.asp?wrnum=anything`.
4. **Is it search-style (find rights by owner, source, etc.)?** Use `wrindex.exe` with one of the four `Search_Key` values: "Owner Name", "Text Search", "Source of Supply", "Text Source". POST form-encoded with `Modinfo=WRMain` and `Key=Display Results`. Try without cookie; retry with cookie if results come back empty.
5. **Is it a page-style listing (applications, water companies, advertisements, distribution systems)?** It's probably a server-rendered ASP page. Fetch with browser headers, parse with regex or a real HTML parser. Watch for inline legends and pagination — the application tracker contaminates its last row.

In all cases: emit browser headers on every outbound request. The DWR servers rarely require them, but they sometimes change behavior (or return shorter results) without them. The overhead is zero.
