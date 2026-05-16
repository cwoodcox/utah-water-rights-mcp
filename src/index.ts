/**
 * Utah Division of Water Rights MCP Server
 * Deployed on Cloudflare Workers via createMcpHandler (stateless, no Durable Objects).
 *
 * Public API — no auth required.
 * Endpoint: https://<worker>.workers.dev/mcp
 */

import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://waterrights.utah.gov/api";

const COUNTY_CODES: Record<string, string> = {
  BEAVER: "BV", "BOX ELDER": "BE", CACHE: "CA", CARBON: "CB",
  DAGGETT: "DA", DAVIS: "DV", DUCHESNE: "DC", EMERY: "EM",
  GARFIELD: "GF", GRAND: "GR", IRON: "IR", JUAB: "JU",
  KANE: "KA", MILLARD: "ML", MORGAN: "MO", PIUTE: "PI",
  RICH: "RI", "SALT LAKE": "SL", "SAN JUAN": "SJ", SANPETE: "SA",
  SEVIER: "SV", SUMMIT: "SU", TOOELE: "TO", UINTAH: "UI",
  UTAH: "UT", WASATCH: "WA", WASHINGTON: "WN", WAYNE: "WY",
  WEBER: "WB",
};

const FLOWLINE_TYPES: Record<string, string> = {
  "0": "natural stream",
  "1": "canal/ditch",
  "2": "tunnel/siphon",
};

// ── Shared helpers ────────────────────────────────────────────────────────────

async function dwrGet(path: string, params?: Record<string, string | number | boolean>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const resp = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DWR API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

function formatError(e: unknown): string {
  if (e instanceof Error) {
    if (e.message.startsWith("DWR API 404")) return "Error: Resource not found. Check your parameters.";
    if (e.message.startsWith("DWR API 422")) return `Error: Invalid parameters — ${e.message}`;
    return `Error: ${e.message}`;
  }
  return "Error: Unexpected failure";
}

/** Convert DWR priority_order float (YYYYMMDD) → ISO date string */
function priorityDate(raw: number | null | undefined): string | null {
  if (raw == null) return null;
  const s = Math.round(raw).toString();
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  return s;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

// ── Server factory (one per request) ─────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: "utah-water-rights-mcp-server",
    version: "1.0.0",
  });

  // ── Tool: county codes ──────────────────────────────────────────────────────

  server.registerTool(
    "uwr_county_codes",
    {
      title: "List Utah County Codes",
      description: `Return all Utah county names and their DWR 2-letter codes.

Box Elder County (Stratos project area) = 'BE', area_code 13.
Use these codes with other tools that take county_code parameters.

Returns: JSON object mapping county names to 2-letter DWR codes.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => text(JSON.stringify(COUNTY_CODES, null, 2)),
  );

  // ── Tool: location info ─────────────────────────────────────────────────────

  server.registerTool(
    "uwr_location_info",
    {
      title: "Resolve Coordinates to DWR Area",
      description: `Resolve a lat/lon coordinate to Utah DWR administrative area metadata.

Returns county, area_code, water rights office, township/range/section, and
quarter-quarter section. Use area_code in allocation and accounting tools.

Returns JSON with:
  county, county_code, area_code, office, township, range, section,
  quarter_quarter, book_name, quad_name, duty_value_acre_ft_per_acre, utm_x, utm_y`,
      inputSchema: {
        latitude: z.number().min(36.9).max(42.1).describe("Decimal latitude, e.g. 41.2"),
        longitude: z.number().min(-114.1).max(-109.0).describe("Decimal longitude (negative for west), e.g. -113.1"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ latitude, longitude }) => {
      try {
        const data = await dwrGet("/map-utilities/location/area_from_lat_long", { latitude, longitude }) as Record<string, unknown>;
        return text(JSON.stringify({
          county: data.county,
          county_code: data.county_code,
          area_code: data.area_code,
          office: data.office,
          township: data.township,
          range: data.range,
          section: data.section_no,
          section_corner: data.section_corner,
          quarter_quarter: data.qtrqtr,
          book_name: data.book_name,
          quad_name: data.quad_name,
          duty_value_acre_ft_per_acre: data.duty_value,
          utm_x: data.x_utm,
          utm_y: data.y_utm,
          in_forty: data.in_forty,
        }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: waterway network ──────────────────────────────────────────────────

  server.registerTool(
    "uwr_waterway_network",
    {
      title: "Get Waterway Network for Bounding Box",
      description: `Return all hydrographic features (streams, canals, ditches, tunnels)
within a lat/lon bounding box.

Flowline types: 0 = natural stream, 1 = canal/ditch, 2 = tunnel/siphon.
Useful for understanding water infrastructure on or near a parcel of land.

Returns JSON with:
  total_flowlines (number),
  named_nodes (reservoirs/ponds with id, name, lat, lon),
  flowlines (list of { id, name, type, active, geometry_wkt })`,
      inputSchema: {
        min_lat: z.number().min(36.9).max(42.1).describe("Southern boundary latitude"),
        max_lat: z.number().min(36.9).max(42.1).describe("Northern boundary latitude"),
        min_lon: z.number().min(-114.1).max(-109.0).describe("Western boundary longitude (negative)"),
        max_lon: z.number().min(-114.1).max(-109.0).describe("Eastern boundary longitude (negative)"),
        include_inactive: z.boolean().default(false).describe("Include inactive waterways (default: false)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ min_lat, max_lat, min_lon, max_lon, include_inactive }) => {
      try {
        const data = await dwrGet("/wr-net/hydrography/net-in-extent", {
          minLat: min_lat, maxLat: max_lat, minLon: min_lon, maxLon: max_lon,
        }) as { flowlines?: Record<string, Record<string, string>>; nodes?: Record<string, Record<string, string>> };

        const flowlines = Object.entries(data.flowlines ?? {})
          .filter(([, f]) => include_inactive || f.active === "1")
          .map(([id, f]) => ({
            id,
            name: f.flowlineName || "(unnamed)",
            type: FLOWLINE_TYPES[f.flowlineType] ?? f.flowlineType,
            active: f.active === "1",
            geometry_wkt: f.wkt,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const named_nodes = Object.entries(data.nodes ?? {})
          .filter(([, n]) => !!n.name)
          .map(([id, n]) => ({ id, name: n.name, lat: n.lat, lon: n.lon }));

        return text(JSON.stringify({ total_flowlines: flowlines.length, named_nodes, flowlines }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: flowline details ──────────────────────────────────────────────────

  server.registerTool(
    "uwr_flowline_details",
    {
      title: "Get Flowline Details",
      description: `Get detailed metadata for a specific waterway flowline by ID.

Flowline IDs come from uwr_waterway_network results.

Returns: Raw JSON from the DWR hydrography API with name, type, nodes, and geometry.`,
      inputSchema: {
        flowline_id: z.number().int().positive().describe("Flowline ID from uwr_waterway_network results"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ flowline_id }) => {
      try {
        const data = await dwrGet("/wr-net/hydrography/flowline-details", { flowline_id });
        return text(JSON.stringify(data, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: accounting graphs list ────────────────────────────────────────────

  server.registerTool(
    "uwr_accounting_graphs",
    {
      title: "List Distribution Accounting Graphs",
      description: `List all managed water system graphs (river systems / basins).

Each graph represents a managed water system such as Bear River, Weber River, etc.
The graph_id and zone_ids are used in allocation and zone balance queries.

Returns: JSON list of { graph_id, name, zone_ids, primary_zone_id }`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const data = await dwrGet("/distribution-accounting/accounting-graphs/list");
        return text(JSON.stringify(data, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: allocations query ─────────────────────────────────────────────────

  server.registerTool(
    "uwr_allocations",
    {
      title: "Query Water Right Allocations",
      description: `Query individual water right allocations from the distribution accounting system.

Allocations represent diversions from source zones (streams) to destination zones
(irrigation districts, municipalities). Priority date is the water right's seniority —
earlier dates are more senior rights.

Filters:
  - water_right_name: water right number substring, e.g. "57-" for Box Elder area rights
  - from_zone: source stream/river name substring, e.g. "Bear River"
  - to_zone: destination zone name substring, e.g. "irrigation"
  - system_name: river system, e.g. "Bear River", "Weber River"
  - min_volume_acft: minimum allocation volume in acre-feet
  - exclude_zeros: skip zero-volume allocations (default true)

Returns JSON with:
  total_records, page, page_size, has_more,
  allocations: [{ id, water_right, from_zone, from_zone_type, to_zone,
                  to_zone_type, system, priority_date, volume_acft, date }]`,
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD, e.g. '2023-01-01'"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD, e.g. '2023-12-31'"),
        water_right_name: z.string().optional().describe("Water right number substring, e.g. '57-' for Box Elder"),
        from_zone: z.string().optional().describe("Source zone name substring, e.g. 'Bear River'"),
        to_zone: z.string().optional().describe("Destination zone name substring"),
        system_name: z.string().optional().describe("River system name, e.g. 'Bear River'"),
        min_volume_acft: z.number().optional().describe("Minimum allocation volume in acre-feet"),
        exclude_zeros: z.boolean().default(true).describe("Exclude zero-volume allocations (default: true)"),
        page_size: z.number().int().min(1).max(100).default(25).describe("Results per page (1-100)"),
        page: z.number().int().min(1).default(1).describe("Page number"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p) => {
      try {
        const params: Record<string, string | number | boolean> = {
          inc_beg_date: p.start_date,
          inc_end_date: p.end_date,
          page_size: p.page_size,
          page: p.page,
          exclude_zeros: p.exclude_zeros,
        };
        if (p.water_right_name) params.name_contains = p.water_right_name;
        if (p.from_zone) params.from_zone_name_contains = p.from_zone;
        if (p.to_zone) params.to_zone_name_contains = p.to_zone;
        if (p.system_name) params.system_name_contains = p.system_name;
        if (p.min_volume_acft != null) params.volume_greaterThan = p.min_volume_acft;

        const data = await dwrGet("/distribution-accounting/allocations/query", params) as {
          data: Array<Record<string, unknown>>;
          total_count?: number;
        };

        const records = data.data ?? [];
        const total = data.total_count ?? records.length;

        return text(JSON.stringify({
          total_records: total,
          page: p.page,
          page_size: p.page_size,
          has_more: total > p.page * p.page_size,
          allocations: records.map((r) => ({
            id: r.id,
            water_right: r.name,
            from_zone: r.from_zone_name,
            from_zone_type: r.from_zone_type,
            to_zone: r.to_zone_name,
            to_zone_type: r.to_zone_type,
            system: r.system_name,
            priority_date: priorityDate(r.priority_order as number | null),
            volume_acft: r.volume,
            date: r.date,
          })),
        }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: allocations summary ───────────────────────────────────────────────

  server.registerTool(
    "uwr_allocations_summary",
    {
      title: "Get Allocation Summary Statistics",
      description: `Get aggregate statistics for water allocations — totals, counts, averages.

Useful for understanding total water volumes in a system without paging through
individual records.

Returns: Raw JSON summary from the DWR allocation summary endpoint.`,
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD"),
        from_zone: z.string().optional().describe("Source zone name substring"),
        to_zone: z.string().optional().describe("Destination zone name substring"),
        system_name: z.string().optional().describe("River system name"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p) => {
      try {
        const params: Record<string, string> = {
          inc_beg_date: p.start_date,
          inc_end_date: p.end_date,
        };
        if (p.from_zone) params.from_zone_name_contains = p.from_zone;
        if (p.to_zone) params.to_zone_name_contains = p.to_zone;
        if (p.system_name) params.system_name_contains = p.system_name;
        const data = await dwrGet("/distribution-accounting/allocations/summary-query", params);
        return text(JSON.stringify(data, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: zone account balance ──────────────────────────────────────────────

  server.registerTool(
    "uwr_zone_balance",
    {
      title: "Get Zone Account Balance",
      description: `Get distribution accounting balance for a specific water zone over a date range.

Zones represent stream reaches or irrigation areas. Zone IDs come from
uwr_accounting_graphs (zone_ids field) or uwr_allocations results
(from_zone_id / to_zone_id fields).

Returns: Raw JSON balance data for the zone.`,
      inputSchema: {
        zone_id: z.number().int().positive().describe("DWR zone ID from accounting graphs or allocation results"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ zone_id, start_date, end_date }) => {
      try {
        const data = await dwrGet(
          `/distribution-accounting/zones/${zone_id}/account-balances`,
          { from_date: start_date, to_date: end_date },
        );
        return text(JSON.stringify(data, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  return server;
}

// ── Worker export ─────────────────────────────────────────────────────────────

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> | Response {
    const url = new URL(request.url);

    // Health check / info at root
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        JSON.stringify({
          name: "Utah Water Rights MCP Server",
          mcp_endpoint: "/mcp",
          tools: [
            "uwr_county_codes",
            "uwr_location_info",
            "uwr_waterway_network",
            "uwr_flowline_details",
            "uwr_accounting_graphs",
            "uwr_allocations",
            "uwr_allocations_summary",
            "uwr_zone_balance",
          ],
          source: "waterrights.utah.gov public API",
        }, null, 2),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // MCP endpoint — new server instance per request (stateless)
    const server = createServer();
    return createMcpHandler(server)(request, env, ctx);
  },
};
