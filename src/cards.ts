/**
 * UI cards for MCP tool results.
 *
 * Each renderer returns a self-contained HTML string with inline styles —
 * no external CSS, JS, or fonts. Clients that don't support HTML resource
 * blocks ignore them and fall back to the JSON text content.
 */

const MAX_ROWS = 50;

const STYLES = `
  :host, .card { all: initial; }
  .card {
    display: block; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px; line-height: 1.45; color: #1f2937;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
    padding: 16px; max-width: 720px; box-sizing: border-box;
  }
  .card * { box-sizing: border-box; }
  .card h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px; color: #0f172a; }
  .card h2 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; color: #475569;
             text-transform: uppercase; letter-spacing: 0.04em; }
  .card a { color: #2563eb; text-decoration: none; }
  .card a:hover { text-decoration: underline; }
  .card .muted { color: #64748b; }
  .card .sub { color: #475569; font-size: 12px; margin-bottom: 10px; }
  .card .grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 8px 16px; margin: 6px 0 4px;
  }
  .card .field { display: flex; flex-direction: column; }
  .card .field .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.03em; }
  .card .field .value { font-size: 13px; color: #0f172a; word-break: break-word; }
  .card .badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 500; background: #f1f5f9; color: #475569;
    margin-left: 6px; vertical-align: middle;
  }
  .card .badge.warn { background: #fef3c7; color: #92400e; }
  .card .badge.ok   { background: #dcfce7; color: #166534; }
  .card .badge.info { background: #dbeafe; color: #1e40af; }
  .card table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
  .card th, .card td {
    text-align: left; padding: 6px 8px; border-bottom: 1px solid #f1f5f9;
    vertical-align: top; word-break: break-word;
  }
  .card th { font-weight: 600; color: #475569; background: #f8fafc; font-size: 11px;
             text-transform: uppercase; letter-spacing: 0.03em; }
  .card tr:last-child td { border-bottom: 0; }
  .card .row-list { display: flex; flex-direction: column; gap: 8px; }
  .card .row {
    border: 1px solid #f1f5f9; border-radius: 8px; padding: 8px 10px;
  }
  .card .footer { margin-top: 12px; padding-top: 10px; border-top: 1px solid #f1f5f9;
                  font-size: 12px; color: #64748b; display: flex; justify-content: space-between; gap: 8px; }
  @media (prefers-color-scheme: dark) {
    .card { background: #0f172a; color: #e2e8f0; border-color: #1e293b; }
    .card h1 { color: #f1f5f9; }
    .card h2 { color: #94a3b8; }
    .card .muted, .card .sub, .card .field .label, .card .footer { color: #94a3b8; }
    .card .field .value { color: #f1f5f9; }
    .card a { color: #60a5fa; }
    .card th { background: #1e293b; color: #94a3b8; }
    .card th, .card td, .card .row, .card .footer { border-color: #1e293b; }
    .card .badge { background: #1e293b; color: #cbd5e1; }
    .card .badge.warn { background: #78350f; color: #fde68a; }
    .card .badge.ok   { background: #14532d; color: #bbf7d0; }
    .card .badge.info { background: #1e3a8a; color: #bfdbfe; }
  }
`;

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safe https://waterrights.utah.gov URL, or empty string. */
function safeWrUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  if (!/^https:\/\/(www\.)?waterrights\.utah\.gov\//i.test(url)) return "";
  return esc(url);
}

function shell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLES}</style></head><body><div class="card">${body}</div></body></html>`;
}

function field(label: string, value: unknown): string {
  const v = value == null || value === "" ? '<span class="muted">—</span>' : esc(value);
  return `<div class="field"><span class="label">${esc(label)}</span><span class="value">${v}</span></div>`;
}

// ── Water right master detail ────────────────────────────────────────────────

interface WaterRightOwner { name?: string; address?: string[]; interest?: string; remarks?: string; }
interface WaterRightChange { app_number?: string; filed?: string; status?: string; }
interface WaterRightPod {
  description?: string; diverting_works?: string; source?: string;
  elevation?: string; utm?: string; stream_alteration_required?: string;
}
interface WaterRightDetail {
  wr_number?: string; quantity?: string; source?: string; county?: string;
  type_of_right?: string; common_description?: string; priority_date?: string;
  filed_date?: string; certificate_date?: string; state_engineer_action?: string;
  protested?: string | boolean;
  owners?: WaterRightOwner[]; changes?: WaterRightChange[]; points_of_diversion?: WaterRightPod[];
  general?: Record<string, string>; dates?: Record<string, string>;
  detail_url?: string;
}

export function renderWaterRightCard(d: WaterRightDetail): string {
  const wr = d.wr_number ?? "—";
  const protested = d.protested === true || d.protested === "true" || d.protested === "Yes";
  const statusBadge = d.certificate_date
    ? `<span class="badge ok">Certified</span>`
    : d.state_engineer_action
      ? `<span class="badge info">${esc(d.state_engineer_action)}</span>`
      : "";
  const protestBadge = protested ? `<span class="badge warn">Protested</span>` : "";
  const detailLink = safeWrUrl(d.detail_url);

  const owners = (d.owners ?? []).map((o) => {
    const addr = Array.isArray(o.address) ? o.address.filter(Boolean).join(", ") : "";
    const interest = o.interest ? ` <span class="muted">· ${esc(o.interest)}</span>` : "";
    const remarks = o.remarks ? `<div class="muted" style="font-size:11px;margin-top:2px">${esc(o.remarks)}</div>` : "";
    return `<div class="row"><div><strong>${esc(o.name ?? "—")}</strong>${interest}</div>${addr ? `<div class="muted">${esc(addr)}</div>` : ""}${remarks}</div>`;
  }).join("");

  const pods = (d.points_of_diversion ?? []).map((p) => {
    const head = esc(p.description ?? p.diverting_works ?? "Point of diversion");
    const bits = [
      p.diverting_works && p.description ? p.diverting_works : "",
      p.elevation ? `elev ${p.elevation}` : "",
      p.utm ? `UTM ${p.utm}` : "",
      p.stream_alteration_required ? `stream-alt: ${p.stream_alteration_required}` : "",
    ].filter(Boolean).map(esc).join(" · ");
    return `<div class="row"><div><strong>${head}</strong></div>${bits ? `<div class="muted">${bits}</div>` : ""}</div>`;
  }).join("");

  const changes = (d.changes ?? []).map((c) => `
    <tr>
      <td>${esc(c.app_number ?? "")}</td>
      <td>${esc(c.filed ?? "")}</td>
      <td>${esc(c.status ?? "")}</td>
    </tr>`).join("");

  const dates = Object.entries(d.dates ?? {})
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => field(k, v))
    .join("");

  return shell(`Water Right ${wr}`, `
    <h1>Water Right ${esc(wr)}${statusBadge}${protestBadge}</h1>
    ${d.common_description ? `<div class="sub">${esc(d.common_description)}</div>` : ""}
    <div class="grid">
      ${field("Priority", d.priority_date)}
      ${field("Quantity", d.quantity)}
      ${field("Source", d.source)}
      ${field("County", d.county)}
      ${field("Type", d.type_of_right)}
      ${field("Filed", d.filed_date)}
      ${field("Certificate", d.certificate_date)}
    </div>
    ${owners ? `<h2>Owners (${(d.owners ?? []).length})</h2><div class="row-list">${owners}</div>` : ""}
    ${pods ? `<h2>Points of Diversion (${(d.points_of_diversion ?? []).length})</h2><div class="row-list">${pods}</div>` : ""}
    ${changes ? `<h2>Change Applications</h2><table><thead><tr><th>App #</th><th>Filed</th><th>Status</th></tr></thead><tbody>${changes}</tbody></table>` : ""}
    ${dates ? `<h2>Dates</h2><div class="grid">${dates}</div>` : ""}
    <div class="footer">
      <span>Utah DWR · waterrights.utah.gov</span>
      ${detailLink ? `<a href="${detailLink}" target="_blank" rel="noopener">Open on waterrights.utah.gov →</a>` : ""}
    </div>
  `);
}

// ── Search results (by owner / by source) ────────────────────────────────────

interface SearchRecord {
  owner?: string | null; source?: string | null; wr_number?: string | null;
  type?: string | null; status?: string | null; app_number?: string | null;
  priority_date?: string | null; flow_cfs?: string | number | null;
  volume_acft?: string | number | null; detail_url?: string | null;
}

export function renderSearchResultsCard(opts: {
  mode: "owner" | "source";
  query: string;
  total_found: number;
  has_more: boolean;
  records: SearchRecord[];
}): string {
  const { mode, query, total_found, has_more, records } = opts;
  const title = mode === "owner" ? "Search by Owner" : "Search by Source";
  const subject = mode === "owner" ? "owner" : "source";
  const limited = records.slice(0, MAX_ROWS);

  const rows = limited.map((r) => {
    const link = safeWrUrl(r.detail_url);
    const wrCell = link ? `<a href="${link}" target="_blank" rel="noopener">${esc(r.wr_number ?? "")}</a>` : esc(r.wr_number ?? "");
    return `
      <tr>
        <td>${wrCell}</td>
        <td>${esc(r.owner ?? "")}</td>
        <td>${esc(r.source ?? "")}</td>
        <td>${esc(r.priority_date ?? "")}</td>
        <td>${esc(r.flow_cfs ?? "")}</td>
        <td>${esc(r.volume_acft ?? "")}</td>
        <td>${esc(r.status ?? "")}</td>
      </tr>`;
  }).join("");

  const moreNote = records.length > MAX_ROWS
    ? `<span class="muted">Showing ${MAX_ROWS} of ${records.length}. Full list in JSON.</span>`
    : has_more
      ? `<span class="badge warn">More results — narrow your search</span>`
      : `<span class="muted">${records.length} record${records.length === 1 ? "" : "s"}</span>`;

  return shell(`${title} — ${query}`, `
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subject)}: <strong>${esc(query)}</strong> · ${total_found} record${total_found === 1 ? "" : "s"}${has_more ? ` <span class="badge warn">truncated</span>` : ""}</div>
    ${rows ? `<table>
      <thead><tr><th>WR #</th><th>Owner</th><th>Source</th><th>Priority</th><th>CFS</th><th>Ac-ft</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="muted">No records.</div>`}
    <div class="footer">
      <span>WRINDEX legacy DB</span>
      ${moreNote}
    </div>
  `);
}

// ── Scanned documents ────────────────────────────────────────────────────────

interface ScannedDoc {
  doc_seq_n?: string | number; docdate?: string; doctype?: string; codedesc?: string;
  comment?: string; volname?: string; recordid?: string;
  pdf_url?: string; direct_url?: string;
}

export function renderScannedDocsCard(wr_number: string, count: number, documents: ScannedDoc[]): string {
  const limited = documents.slice(0, MAX_ROWS);
  const rows = limited.map((doc) => {
    const pdf = safeWrUrl(doc.pdf_url);
    const direct = safeWrUrl(doc.direct_url);
    const links = [
      pdf ? `<a href="${pdf}" target="_blank" rel="noopener">PDF</a>` : "",
      direct ? `<a href="${direct}" target="_blank" rel="noopener">scan</a>` : "",
    ].filter(Boolean).join(" · ");
    return `
      <tr>
        <td>${esc(doc.doc_seq_n ?? "")}</td>
        <td>${esc(doc.docdate ?? "")}</td>
        <td>${esc(doc.codedesc ?? doc.doctype ?? "")}</td>
        <td>${esc(doc.comment ?? "")}</td>
        <td>${links || '<span class="muted">—</span>'}</td>
      </tr>`;
  }).join("");

  const moreNote = documents.length > MAX_ROWS
    ? `Showing ${MAX_ROWS} of ${documents.length}. Full list in JSON.`
    : `${documents.length} document${documents.length === 1 ? "" : "s"}`;

  return shell(`Scanned Documents — ${wr_number}`, `
    <h1>Scanned Documents <span class="badge info">${esc(wr_number)}</span></h1>
    <div class="sub">${esc(count)} indexed document${count === 1 ? "" : "s"}</div>
    ${rows ? `<table>
      <thead><tr><th>#</th><th>Date</th><th>Type</th><th>Comment</th><th>Links</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="muted">No scanned documents indexed.</div>`}
    <div class="footer">
      <span>Utah DWR DOCDB</span>
      <span class="muted">${esc(moreNote)}</span>
    </div>
  `);
}

// ── MCP content helpers ──────────────────────────────────────────────────────

export function htmlResource(uri: string, html: string) {
  return { type: "resource" as const, resource: { uri, mimeType: "text/html", text: html } };
}
