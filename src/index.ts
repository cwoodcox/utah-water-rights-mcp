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
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      Referer: "https://waterrights.utah.gov/",
    },
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


const WRINDEX_URL = "https://waterrights.utah.gov/cgi-bin/wrindex.exe";

// wrindex.exe is picky: bare requests get blocked, but browser headers usually
// suffice. Some searches still need a session cookie — we discover that lazily
// by retrying with a warmed cookie when the first POST comes back empty.
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function wrindexWarmupCookie(): Promise<string> {
  try {
    const resp = await fetch(WRINDEX_URL, {
      method: "GET",
      headers: { ...BROWSER_HEADERS, Referer: "https://waterrights.utah.gov/" },
      redirect: "follow",
    });
    const cookies = resp.headers.getSetCookie?.() ?? [];
    return cookies.map((c: string) => c.split(";", 1)[0].trim()).filter(Boolean).join("; ");
  } catch {
    return "";
  }
}

interface WrIndexRecord {
  owner: string;
  source: string;
  wr_number: string;
  type: string;
  status: string;
  app_number: string;
  cert_number: string;
  priority_date: string | null;
  flow_cfs: number | null;
  volume_acft: number | null;
  detail_url: string;
}

/**
 * Parse WRINDEX HTML into structured records.
 * The <pre> block uses 3 lines per right: owner / source+WRnum / priority+volume
 */
function parseWrindexHtml(html: string): WrIndexRecord[] {
  const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (!preMatch) return [];
  const pre = preMatch[1];

  // Replace linked WR numbers with just the number text
  const cleaned = pre
    .replace(/<a[^>]*onclick="[^"]*\/search\?q=([^']+)'[^"]*"[^>]*>[^<]*<\/a>/gi, (_m, wrNum: string) => wrNum.trim())
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

  const records: WrIndexRecord[] = [];
  const lines = cleaned.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const ownerLine = lines[i];
    // Owner lines: non-empty, not indented, not headers/hr lines
    if (
      !ownerLine ||
      ownerLine.startsWith(" ") ||
      ownerLine.startsWith("\t") ||
      ownerLine.trim() === "" ||
      ownerLine.includes("---") ||
      ownerLine.includes("Name ") ||
      ownerLine.includes("WR/CH")
    ) {
      i++;
      continue;
    }

    const owner = ownerLine.trim().replace(/,\s*$/, "");

    // Find the next indented source line
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;

    if (j >= lines.length || !lines[j].startsWith("     ")) {
      i = j;
      continue;
    }
    const sourceLine = lines[j++];

    // Find the next indented priority line
    while (j < lines.length && lines[j].trim() === "") j++;
    let priorityLine = "";
    if (j < lines.length && lines[j].startsWith("     ")) {
      priorityLine = lines[j++];
    }

    // Extract WR number from the source line
    const wrMatch = sourceLine.match(/\b(\d{1,3}-\d+|[aAeEE]\d{4,6})\b/);
    const wrNum = wrMatch ? wrMatch[1] : "";

    // Source name: everything before the WR number
    let source = "";
    if (wrNum && sourceLine.includes(wrNum)) {
      source = sourceLine.slice(0, sourceLine.indexOf(wrNum)).trim();
    } else {
      source = sourceLine.trim();
    }

    // Type and status from text after WR number
    const afterWr = wrNum ? sourceLine.slice(sourceLine.indexOf(wrNum) + wrNum.length) : sourceLine;
    const typeMatch = afterWr.match(/\b(APPL|DIL|SHAR|DEC|EXCH)\b/);
    const wrType = typeMatch ? typeMatch[1] : "";
    const statusMatch = afterWr.match(/\b(CERT|REJ|APP|WUC|WD|DIS|NPR|UNAP|LAP)\b/);
    const wrStatus = statusMatch ? statusMatch[1] : "";
    const appMatch = afterWr.match(/\b(A\d{4,6}\w*)\b/);
    const appNum = appMatch ? appMatch[1] : "";

    // Priority date
    let priorityDateStr: string | null = null;
    let flowCfs: number | null = null;
    let volumeAcft: number | null = null;

    if (priorityLine) {
      const dateMatch = priorityLine.match(/Priority Date:\s*(\d{2}\/\d{2}\/\d{4}|\/\s*\/\s*\d{4})/);
      if (dateMatch) {
        const raw = dateMatch[1].trim();
        if (raw.startsWith("/")) {
          const yrMatch = raw.match(/(\d{4})/);
          if (yrMatch) priorityDateStr = yrMatch[1];
        } else {
          const parts = raw.split("/");
          if (parts.length === 3) {
            priorityDateStr = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
          }
        }
      }
      const cfsMatch = priorityLine.match(/([\d,]+\.?\d*)\s*cfs/);
      if (cfsMatch) flowCfs = parseFloat(cfsMatch[1].replace(/,/g, ""));
      const acftMatch = priorityLine.match(/([\d,]+\.?\d*)\s*acft/);
      if (acftMatch) volumeAcft = parseFloat(acftMatch[1].replace(/,/g, ""));
    }

    if (owner && source.length > 1) {
      records.push({
        owner,
        source,
        wr_number: wrNum,
        type: wrType,
        status: wrStatus,
        app_number: appNum,
        cert_number: "",
        priority_date: priorityDateStr,
        flow_cfs: flowCfs,
        volume_acft: volumeAcft,
        detail_url: wrNum
          ? `https://waterrights.utah.gov/search?q=${encodeURIComponent(wrNum)}`
          : "",
      });
    }

    i = j;
  }

  return records;
}

async function wrindexFetch(bodyStr: string, cookie: string): Promise<string> {
  const resp = await fetch(WRINDEX_URL, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://waterrights.utah.gov",
      Referer: WRINDEX_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: bodyStr,
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`WRINDEX HTTP ${resp.status}`);
  return resp.text();
}

async function wrindexPost(
  searchKey: "Owner Name" | "Text Search" | "Source of Supply" | "Text Source",
  searchString: string,
): Promise<{ records: WrIndexRecord[]; has_more: boolean }> {
  const bodyStr = new URLSearchParams({
    Modinfo: "WRMain",
    Search_Key: searchKey,
    SEARCH_STRING: searchString,
    Key: "Display Results",
  }).toString();

  // First try with no cookie. wrindex.exe sometimes refuses without a session;
  // if the parsed result is empty, warm a cookie and retry once.
  let html = await wrindexFetch(bodyStr, "");
  let records = parseWrindexHtml(html);
  if (records.length === 0) {
    const cookie = await wrindexWarmupCookie();
    if (cookie) {
      html = await wrindexFetch(bodyStr, cookie);
      records = parseWrindexHtml(html);
    }
  }

  const has_more = html.includes('value="Next Page"') && html.includes('name="FIRST_');
  return { records, has_more };
}

// ── wrprint.asp / wrDB SQL surface ────────────────────────────────────────────
// The /asp_apps/wrprint/ subsystem exposes an arbitrary-SELECT endpoint
// (GET_MULTIPLE_VALUES) gated behind an ASPSESSIONID cookie. Form-encoded body,
// keys: dbNameId, tableNameId, selectNameId, whereClauseId, orderClauseId.
// Errors come back as single-quoted pseudo-JSON; success is real JSON.

const WRPRINT_BASE = "https://waterrights.utah.gov/asp_apps/wrprint";

async function wrprintCookie(): Promise<string> {
  const resp = await fetch(`${WRPRINT_BASE}/wrprint.asp?wrnum=1-1`, {
    method: "GET",
    headers: { ...BROWSER_HEADERS, Referer: "https://waterrights.utah.gov/" },
    redirect: "follow",
  });
  const cookies = resp.headers.getSetCookie?.() ?? [];
  return cookies.map((c: string) => c.split(";", 1)[0].trim()).filter(Boolean).join("; ");
}

async function wrprintAjax(
  endpoint: "GET_MULTIPLE_VALUES" | "GET_SCANNED_DOCUMENTS",
  params: Record<string, string>,
): Promise<{ records: Array<Record<string, string>>; count: number }> {
  const cookie = await wrprintCookie();
  if (!cookie) throw new Error("Failed to establish wrprint session");
  const resp = await fetch(`${WRPRINT_BASE}/lclAjax.asp?xhrPost=${endpoint}`, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://waterrights.utah.gov",
      Referer: `${WRPRINT_BASE}/wrprint.asp`,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!resp.ok) throw new Error(`wrprint ${endpoint} HTTP ${resp.status}`);
  const raw = (await resp.text()).trim();

  // {'Error':'...'} or {'RecordCount':'0'} — single-quoted pseudo-JSON
  if (raw.startsWith("{'")) {
    const err = raw.match(/'Error':'([^']*)'/);
    if (err) throw new Error(`wrprint ${endpoint}: ${err[1]}`);
    const cnt = raw.match(/'RecordCount':'(\d+)'/);
    if (cnt) return { records: [], count: parseInt(cnt[1], 10) };
  }

  const parsed = JSON.parse(raw) as { Records?: Array<Record<string, string>>; RecordCount?: string };
  const records = (parsed.Records ?? []).map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) out[k] = typeof v === "string" ? v.trim() : v;
    return out;
  });
  return { records, count: parseInt(parsed.RecordCount ?? String(records.length), 10) };
}

const SAFE_WRNUM = /^[A-Za-z]?\d+(?:-\d+)?$/;

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


  // ── Tool: search static DB by owner name ─────────────────────────────────────

  server.registerTool(
    "uwr_search_by_owner",
    {
      title: "Search Water Rights by Owner Name",
      description: `Search the static Utah water rights database by owner/entity name.

This reaches the WRINDEX legacy database — covering ALL water rights in Utah including
unmanaged, closed-basin, and historical rights that do NOT appear in the distribution
accounting API (e.g. Hansel Valley, Salt Wells Spring, Bear River closed-basin rights).

search_string is alphabetical starting point (e.g. "O'Leary" returns rights for owners
alphabetically starting at that name). Use text_search=true for substring matching
anywhere in the owner name rather than alphabetical lookup.

Returns JSON with:
  total_found, has_more (true if >1 page of results),
  records: [{ owner, source, wr_number, type, status, app_number,
              priority_date, flow_cfs, volume_acft, detail_url }]

Type codes: APPL=Application, DIL=Diligence Claim, SHAR=Shares, DEC=Decree, EXCH=Exchange
Status codes: CERT=Certified, REJ=Rejected, APP=Approved, WUC=Water Use Certificate,
              WD=Withdrawn, DIS=Dismissed, NPR=No Priority, LAP=Lapsed`,
      inputSchema: {
        search_string: z.string().min(1).describe("Owner name to search for, e.g. 'O\'Leary', 'Utah Power', 'Bureau of Land Management'"),
        text_search: z.boolean().default(false).describe("If true, searches for substring anywhere in owner name. If false (default), alphabetical starting-point lookup."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ search_string, text_search }) => {
      try {
        const searchKey = text_search ? "Text Search" : "Owner Name";
        const { records, has_more } = await wrindexPost(searchKey, search_string);
        return text(JSON.stringify({
          total_found: records.length,
          has_more,
          note: has_more ? "More results exist. Narrow your search or use a more specific name." : undefined,
          records,
        }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: search static DB by water source ────────────────────────────────────

  server.registerTool(
    "uwr_search_by_source",
    {
      title: "Search Water Rights by Water Source",
      description: `Search the static Utah water rights database by water source name.

This reaches the WRINDEX legacy database — the ONLY way to find water rights on
unmanaged/closed-basin sources like Hansel Valley Springs, Salt Wells Spring,
Bear River diversions, and other sources not covered by distribution accounting.

Returns ALL rights drawing from a named source, with owner, priority date, and volume.
Useful for: mapping who holds rights on a specific spring, stream, or well field;
building a complete picture of water interests on land parcels.

search_string is an alphabetical starting point (e.g. "Salt Wells" returns rights
whose source name starts alphabetically at that point). Use text_search=true for
substring matching (e.g. "Wells" finds "Salt Wells", "Gravel Wells", etc.).

Returns JSON with:
  total_found, has_more,
  records: [{ owner, source, wr_number, type, status, app_number,
              priority_date, flow_cfs, volume_acft, detail_url }]`,
      inputSchema: {
        search_string: z.string().min(1).describe("Source/spring/stream name to search, e.g. 'Hansel Valley', 'Salt Wells Spring', 'Bear River', 'Locomotive Springs'"),
        text_search: z.boolean().default(false).describe("If true, substring match anywhere in source name. If false (default), alphabetical starting-point lookup."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ search_string, text_search }) => {
      try {
        const searchKey = text_search ? "Text Source" : "Source of Supply";
        const { records, has_more } = await wrindexPost(searchKey, search_string);
        return text(JSON.stringify({
          total_found: records.length,
          has_more,
          note: has_more ? "More results exist. Try a more specific source name." : undefined,
          records,
        }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );


  // ── Tool: water right uses ───────────────────────────────────────────────────

  server.registerTool(
    "uwr_water_right_uses",
    {
      title: "Get Water Right Use Allocations",
      description: `Get the use-by-use breakdown for a specific water right number.

Returns each USE_TYPE associated with the right (IRR=irrigation, DOM=domestic,
STK=stockwater, MUN=municipal, MIN=mining, POW=power, OTH=other) along with the
allocated quantity in that use's native unit (irrigation_acreage, stock_units,
domestic_families, etc.) and the parallel ADJUD_* adjudicated values.

This is the structured data behind a water right's detail page — equivalent to
what waterrights.utah.gov shows in the "Uses" section of wrprint.asp.

Returns: { wr_number, count, uses: [...] } — empty if the WR has no recorded uses.`,
      inputSchema: {
        wr_number: z.string().regex(SAFE_WRNUM).describe("Water right number, e.g. '57-2634', '43-10040', 'E5428'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ wr_number }) => {
      try {
        const { records, count } = await wrprintAjax("GET_MULTIPLE_VALUES", {
          dbNameId: "wrDB",
          tableNameId: "water_uses",
          selectNameId: "wrnum, group_number, use_type, use_id, irrigation_acreage, domestic_families, domestic_persons, stock_units, municipality, mine_district, mine_name, power_plant_name, other_type, other_description, use_beg_date, use_end_date, adjud_irrigation_acreage, adjud_domestic_families, adjud_stock_units, adjud_municipality, adjud_action_flag",
          whereClauseId: `WHERE wrnum='${wr_number}'`,
          orderClauseId: "ORDER BY use_type, use_id",
        });
        return text(JSON.stringify({ wr_number, count, uses: records }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: scanned documents ──────────────────────────────────────────────────

  server.registerTool(
    "uwr_scanned_documents",
    {
      title: "List Scanned Documents for a Water Right",
      description: `List the scanned document index for a water right — applications, decrees,
proofs, correspondence, legal documents, well driller's reports, etc.

Each record has codedesc (human-readable doc type), docdate, comment, and a
wwwpath + docfilen pair that points to the scanned image under /docSys/.

Returns: { wr_number, count, documents: [{ doc_seq_n, docdate, doctype, codedesc, comment, volname, wwwpath, docfilen, ... }] }`,
      inputSchema: {
        wr_number: z.string().regex(SAFE_WRNUM).describe("Water right number, e.g. '43-10040'"),
        sort: z.enum(["doc_seq_n", "docdate", "codedesc", "doctype"]).default("doc_seq_n").describe("Sort key"),
        order: z.enum(["asc", "desc"]).default("asc"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ wr_number, sort, order }) => {
      try {
        const { records, count } = await wrprintAjax("GET_SCANNED_DOCUMENTS", {
          wrnum: wr_number,
          sort,
          order,
        });
        return text(JSON.stringify({ wr_number, count, documents: records }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Tool: generic wrDB query ─────────────────────────────────────────────────

  server.registerTool(
    "uwr_wrdb_query",
    {
      title: "Query wrDB Table (advanced)",
      description: `Run an arbitrary SELECT against the DWR wrDB database via the wrprint
GET_MULTIPLE_VALUES endpoint. Power tool — use the convenience tools first
(uwr_water_right_uses, uwr_scanned_documents) when they fit.

The endpoint composes \`SELECT {columns} FROM {table} {where_clause} {order_clause}\`.
String literals in where_clause use single quotes, e.g. WHERE wrnum='57-2634'.

Known tables (non-exhaustive):
  - water_uses       — per-use breakdown for each WR. Key: WRNUM.
                       Cols: GROUP_NUMBER, USE_TYPE, USE_ID, IRRIGATION_ACREAGE,
                       DOMESTIC_FAMILIES, STOCK_UNITS, MUNICIPALITY, MINE_*,
                       POWER_*, OTHER_*, plus parallel ADJUD_* columns,
                       USE_BEG_DATE, USE_END_DATE, ADJUD_ACTION_FLAG.
  - owners           — current/historical owners. Key: WRCHEX (NOT WRNUM —
                       owners may be keyed by an exchange identifier like 'E5428';
                       to find owners by WR number try WHERE wrchex LIKE '%<wrnum>%').
                       Cols: OWNER_NAME, OWNER_FIRST_NAME, OWNER_LAST_NAME,
                       OWNER_ADDRESS, OWNER_CITY, OWNER_STATE, OWNER_ZIPCODE,
                       OWNER_PHONE, OWNER_EMAIL_ADDRESS, OWNER_INTEREST.

To discover more tables, try \`tableNameId\` values and read the error response —
"No RecordSet to convert to JSON" means the query failed (bad table/column/SQL).
A successful unknown query returns { Records: [...], RecordCount }.

Returns: { count, records: [...] } with all string values whitespace-trimmed.`,
      inputSchema: {
        table: z.string().min(1).describe("Table name, e.g. 'water_uses', 'owners'"),
        columns: z.string().default("*").describe("SELECT clause body, e.g. 'wrnum, use_type' or 'TOP 10 *'"),
        where_clause: z.string().default("").describe("Full WHERE clause including the word WHERE, e.g. \"WHERE wrnum='57-2634'\""),
        order_clause: z.string().default("").describe("Full ORDER BY clause, e.g. 'ORDER BY use_type'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ table, columns, where_clause, order_clause }) => {
      try {
        const { records, count } = await wrprintAjax("GET_MULTIPLE_VALUES", {
          dbNameId: "wrDB",
          tableNameId: table,
          selectNameId: columns,
          whereClauseId: where_clause,
          orderClauseId: order_clause,
        });
        return text(JSON.stringify({ count, records }, null, 2));
      } catch (e) {
        return text(formatError(e));
      }
    },
  );

  // ── Resource: place of use GIS layer ─────────────────────────────────────────
  // Tells agents to use ugrc-gis:arcgis_query_raw rather than a custom tool.

  server.registerResource(
    "uwr_place_of_use_layer",
    "uwr://place-of-use/layer-info",
    { mimeType: "application/json" },
    async () => ({
      contents: [{
        uri: "uwr://place-of-use/layer-info",
        mimeType: "application/json",
        text: JSON.stringify({
          instruction: "Query this layer using the ugrc-gis arcgis_query_raw tool — do NOT write custom fetch code. Pass service_url and params as shown in examples.",
          service_url: "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Place_of_Use_Irrigation/FeatureServer/0",
          total_features: 67027,
          description: "Digitized irrigation place-of-use polygons for all Utah water rights. Covers the entire state including unmanaged and closed-basin rights not in the distribution accounting API.",
          fields: {
            WRNUMS: "Space-separated WR numbers for this polygon — NOTE: values have a leading space (e.g. ' 13-101, 13-3509'). Always use LIKE with a leading space: LIKE '% 13-101%'.",
            POLYGON_ACRES: "NULL in the entire dataset — do not use for acreage queries.",
            DOCUMENT_ACRES: "NULL in the entire dataset — do not use for acreage queries.",
            POU_TYPE: "Place of use type code (e.g. 'C' = certified). Single character. Often empty.",
            SOURCE: "Source document type (e.g. 'ProofMap', 'Hydrographic Survey Map'). Often empty.",
            AREA_CODE: "DWR area code — matches area_code from uwr_location_info (e.g. '13' = Box Elder County)",
            CHNUM: "Change application number. Often empty.",
            dbURL: "Link to the DWR POU group detail page — always populated.",
          },
          notes: [
            "WRNUMS values always have a leading space — use LIKE '% 13-101%' not LIKE '%13-101%'",
            "POLYGON_ACRES and DOCUMENT_ACRES are NULL across the entire 67,027-record dataset",
            "Geometry is returned in UTM Zone 12N (WKID 26912) unless you specify outSR=4326",
            "The FeatureServer returns up to 2000 records per request (exceededTransferLimit indicates more exist)",
          ],
          example_queries: {
            by_wr_number: {
              params: { f: "json", where: "WRNUMS LIKE '% 13-101%'", outFields: "WRNUMS,POLYGON_ACRES,AREA_CODE,dbURL", outSR: "4326", returnGeometry: "true", resultRecordCount: "100" },
            },
            by_bounding_box: {
              params: { f: "json", where: "1=1", geometry: JSON.stringify({xmin:-113.3,ymin:41.1,xmax:-112.8,ymax:41.4}), geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "WRNUMS,POLYGON_ACRES,AREA_CODE,dbURL", outSR: "4326", returnGeometry: "false", resultRecordCount: "200" },
            },
            by_area_code: {
              params: { f: "json", where: "AREA_CODE='13'", outFields: "WRNUMS,POLYGON_ACRES,AREA_CODE,dbURL", returnGeometry: "false", resultRecordCount: "500" },
            },
            count_only: {
              params: { f: "json", where: "AREA_CODE='13'", returnCountOnly: "true" },
            },
          },
        }, null, 2),
      }],
    }),
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
            "uwr_search_by_owner",
            "uwr_search_by_source",
            "uwr_water_right_uses",
            "uwr_scanned_documents",
            "uwr_wrdb_query",
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
