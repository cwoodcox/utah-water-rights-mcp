# Utah Water Rights MCP Server

A remote MCP server for the Utah Division of Water Rights public API, deployable to Cloudflare Workers in one command.

**Endpoint after deploy:** `https://utah-water-rights-mcp.<your-account>.workers.dev/mcp`

## Tools

| Tool | Description |
|---|---|
| `uwr_county_codes` | Utah county names → DWR 2-letter codes |
| `uwr_location_info` | lat/lon → county, area code, office, township/range/section |
| `uwr_waterway_network` | Bounding box → streams, canals, ditches, tunnels |
| `uwr_flowline_details` | Details for a specific waterway by ID |
| `uwr_accounting_graphs` | List managed river systems (Bear River, Weber, etc.) |
| `uwr_allocations` | Query water right allocations with rich filtering |
| `uwr_allocations_summary` | Aggregate volume/count stats for allocations |
| `uwr_zone_balance` | Account balance for a specific water zone |

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
- `/api/distribution-accounting/` — allocations, zone balances
