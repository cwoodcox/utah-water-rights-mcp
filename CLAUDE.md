# Claude notes for utah-water-rights-mcp

A remote MCP server that wraps the Utah Division of Water Rights' public surfaces and exposes them as 20 read-only tools. Runs stateless on Cloudflare Workers via `createMcpHandler` from the `agents` SDK. No auth, no Durable Objects, no KV.

**Read [`docs/dwr-reverse-engineering.md`](docs/dwr-reverse-engineering.md) before adding tools or probing new endpoints.** It's the institutional memory: endpoint catalog, wrDB schema, confirmed-non-existent tables, the WRCHEX-vs-WRNUM gotcha, scanned-doc URL construction, and a decision tree for "where does this data live."

## Stack at a glance

- Cloudflare Worker, TypeScript, `@modelcontextprotocol/sdk` + `agents/mcp` (`createMcpHandler`, not `McpAgent` — this server is fully stateless, so a fresh `McpServer` is constructed per request).
- `nodejs_compat` flag is required at runtime; the `agents` package depends on it (`tsc --noEmit` doesn't catch this). See commit 46f37b6 for context.
- Zod **v4** for tool input schemas; `agents@0.12.4` declares it as a peer.
- No secrets, no bindings, no DOs. The worker is a pure proxy over three upstream surfaces.

## File responsibilities

| File | Holds | Don't put here |
|------|-------|-----------------|
| `src/index.ts` | All tool registrations, the three upstream fetch wrappers (`dwrGet`, `wrindexPost`, `wrprintAjax`), and the WRINDEX HTML parser. | Anything renderable as HTML — that goes in `cards.ts`. |
| `src/cards.ts` | HTML widget renderers for card-emitting tools (`renderWaterRightCard`, `renderSearchResultsCard`, `renderScannedDocsCard`) and the `htmlResource` helper. | Business logic, fetches, parsing. |
| `scripts/preview-cards.mjs` | Local preview harness for iterating on card HTML without redeploying. | Anything imported by the worker. |
| `docs/dwr-reverse-engineering.md` | Authoritative spec for what each upstream surface returns and why. | Code. |
| `wrangler.jsonc` | Worker name (`utah-diwr-mcp`), `compatibility_date`, `nodejs_compat`, observability. | Secrets, bindings. |

## The three upstream surfaces

The whole server exists to paper over these three being inconsistent. Know which surface a tool hits before debugging.

1. **`/api/*` — clean JSON.** Map utilities, hydrography, distribution accounting. Standard `fetch` + `Accept: application/json`. Wrapped by `dwrGet`.
2. **`/cgi-bin/wrindex.exe` — legacy CGI returning HTML.** Owner/source search across the full statewide WR database. Parsed in-worker by `parseWrindexHtml`. Sometimes the first POST returns empty; `wrindexPost` transparently retries with a warmed `ASPSESSIONID` cookie when that happens — don't strip the retry.
3. **`/asp_apps/wrprint/lclAjax.asp` — session-cookied AJAX.** Per-WR detail and arbitrary `SELECT` against wrDB. Each request needs a fresh `ASPSESSIONID` (obtained by `wrprintCookie`). Error responses come back as **single-quoted pseudo-JSON** like `{'Error':'...'}` — `wrprintAjax` normalizes both that and `{'RecordCount':'0'}`.

The application tracker is a fourth, narrower surface: server-rendered HTML at `/applicationsrecords/*AppTracker.asp`, parsed similarly to WRINDEX.

## Gotchas

- **WRCHEX vs WRNUM.** The `owners` table is keyed by `WRCHEX`, not `WRNUM`. Exchange rights look like `E5428`. To find owners by WR number use `WHERE wrchex LIKE '%<wrnum>%'`. The spec covers this in detail.
- **SQL safety in `uwr_wrdb_query` and `uwr_water_right_uses`.** Where-clauses interpolate user input into single-quoted SQL strings. The `wr_number` parameter is regex-validated upstream by `SAFE_WRNUM` (`/^[A-Za-z]?\d+(?:-\d+)?$/`). Don't relax that regex without thinking through injection vectors against wrDB.
- **WRINDEX session-cookie behavior is non-deterministic.** Some queries work cold, others need a warmed cookie. The empty-then-retry pattern in `wrindexPost` is the working compromise — don't replace it with eager warming (extra round trip on every call) or no warming (random empty results).
- **`agents/mcp` only loads in the Workers runtime.** Don't import it from Node scripts. Test through `wrangler dev` or against the deployed Worker.
- **`worker-configuration.d.ts` is generated** by `npx wrangler types` and is `.gitignore`'d. Re-run after adding bindings.
- **The lockfile is committed.** `npm clean-install` is what CF runs — peer-dep conflicts (e.g. zod major mismatches) will fail the build. If you bump a dep with peers, run `npm install` locally and commit the lockfile.

## When extending

- **New tool** → `server.registerTool(...)` inside `createServer()` in `src/index.ts`. Follow the existing pattern: `title`, prose `description` (LLM reads this — be specific about parameters and return shape), Zod `inputSchema`, `annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: <true if it queries arbitrary external data> }`. Use the `text(...)` helper to wrap the response.
- **New wrDB query** → reach for `uwr_wrdb_query` first; only add a convenience tool if (a) the SQL needs validation/escaping the generic tool can't safely do, or (b) the return shape is so specialized it justifies a dedicated tool.
- **Card-emitting tool** → add the renderer to `src/cards.ts` and append the HTML resource via `htmlResource(...)` in the tool's response. End the tool's `description` with the RENDERING directive so clients with `show_widget` render the card inline.
- **New upstream surface** → update the spec before writing code. Discovering the same gotcha twice is the failure mode the spec exists to prevent.

## Testing

- `npx tsc --noEmit` for type-checking.
- `npm run dev` for `wrangler dev` (port 8787, endpoint `/mcp`).
- Inspector: `npx @modelcontextprotocol/inspector@latest` → Streamable HTTP → `http://localhost:8787/mcp`.
- CF Workers Builds runs `npm clean-install` then `wrangler deploy` on every push; check the build before declaring a change shipped.

## Conventions

- Comments explain **why**, not what. The reader can read the code.
- Tool descriptions are prose, not lists — write them for the LLM that will read them, not for humans skimming docs.
- Atomic commits per logical change. Subjects use lowercase prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
