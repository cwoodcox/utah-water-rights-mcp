# Utah Water Rights MCP Server

A remote MCP server for the Utah Division of Water Rights public API, deployable to Cloudflare Workers in one command.

**Endpoint after deploy:** `https://utah-water-rights-mcp.<your-account>.workers.dev/mcp`

## Tools

The server wraps three distinct DWR surfaces. Pick the right one for your question — the distribution accounting API only covers managed systems (Bear/Weber/Provo/etc.), while WRINDEX and wrprint cover *every* water right in Utah including closed-basin and historical rights.

### Geography & lookup

| Tool | Description |
|---|---|
| `uwr_county_codes` | Map Utah county names to DWR 2-letter codes (e.g. Box Elder → `BE`). |
| `uwr_location_info` | Resolve lat/lon → county, area code, office, township/range/section, quarter-quarter, UTM. |
| `uwr_waterway_network` | List hydrographic features (streams, canals, ditches, tunnels) in a lat/lon bounding box, with WKT geometry. |
| `uwr_flowline_details` | Full metadata for a single waterway by flowline ID. |

### Distribution accounting (managed river systems only)

| Tool | Description |
|---|---|
| `uwr_accounting_graphs` | List managed water systems (Bear River, Weber, Provo, …) and their zone IDs. |
| `uwr_allocations` | Query individual allocations with rich filtering: water right number, from/to zone, system, date range, min volume. Paginated. |
| `uwr_allocations_summary` | Aggregate totals/counts/averages across allocations without paging. |
| `uwr_zone_balance` | Account balance time series for a single zone (stream reach or irrigation area). |

### Static WR database (full statewide coverage — WRINDEX legacy)

| Tool | Description |
|---|---|
| `uwr_search_by_owner` | Find water rights by owner/entity name. Alphabetical lookup by default, substring with `text_search=true`. |
| `uwr_search_by_source` | Find water rights drawing from a named source — the only way to reach unmanaged/closed-basin sources (e.g. Hansel Valley Springs, Salt Wells Spring). |

### Per-water-right detail (wrprint AJAX / wrDB)

| Tool | Description |
|---|---|
| `uwr_water_right_uses` | Use-by-use breakdown for a WR number — irrigation acreage, stock units, domestic families, municipal, mining, power, with parallel adjudicated values. |
| `uwr_scanned_documents` | Scanned document index for a WR — applications, decrees, proofs, correspondence, well-driller reports — with paths into `/docSys/`. |
| `uwr_wrdb_query` | Power tool: arbitrary `SELECT` against wrDB (e.g. `owners`, `water_uses`). Use convenience tools first; this is for tables they don't cover. |

### Resources

| URI | Description |
|---|---|
| `uwr://place-of-use/layer-info` | Pointer + query recipes for the ArcGIS *Utah Place of Use Irrigation* layer (67k polygons, statewide). Tells agents to query it via the UGRC ArcGIS tool rather than writing custom fetch code. |

## Deploy

```bash
npm install
npm run deploy
```

That's it. No secrets, no Durable Objects — fully stateless, reads from `waterrights.utah.gov` public API.

## Local dev

```bash
npm run dev
# Server at http://localhost:8787/mcp
```

Test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector@latest
# Select "Streamable HTTP", enter http://localhost:8787/mcp
```

## Connect from Claude Desktop / other clients

After deploying, add to your MCP client config:

```json
{
  "mcpServers": {
    "utah-water-rights": {
      "url": "https://utah-water-rights-mcp.<your-account>.workers.dev/mcp"
    }
  }
}
```

For clients that only support stdio (not remote URLs), use `mcp-remote` as a proxy:
```bash
npx mcp-remote https://utah-water-rights-mcp.<your-account>.workers.dev/mcp
```

## Architecture

Uses `createMcpHandler` from Cloudflare's `agents` SDK — a new server instance is created per request, keeping the Worker completely stateless. No Durable Objects or session state needed since all tools are read-only API calls.

```
MCP Client → Streamable HTTP → Cloudflare Worker → waterrights.utah.gov API
```

Data sources accessed:
- `/api/map-utilities/` — coordinate → area resolution
- `/api/wr-net/hydrography/` — waterway network geometry
- `/api/distribution-accounting/` — allocations, zone balances (managed systems only)
- `/cgi-bin/wrindex.exe` — legacy static WR database (owner/source search, full statewide coverage)
- `/asp_apps/wrprint/lclAjax.asp` — per-WR detail (uses, scanned documents, arbitrary wrDB SELECT)
