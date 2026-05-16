// Render sample cards to /tmp/uwr-card-*.html for visual inspection.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderWaterRightCard,
  renderSearchResultsCard,
  renderScannedDocsCard,
} from "../src/cards.ts";

const outDir = "/tmp/uwr-cards";
mkdirSync(outDir, { recursive: true });

const wr = renderWaterRightCard({
  wr_number: "43-10040",
  quantity: "0.13 CFS",
  source: "Bear River, underground water",
  county: "Box Elder",
  type_of_right: "Application",
  common_description: "NW¼ of Section 12, T10N R3W, SLB&M",
  priority_date: "1903-04-15",
  filed_date: "1903-04-15",
  certificate_date: "1908-10-22",
  state_engineer_action: "Approved",
  protested: "Yes",
  owners: [
    { name: "Smith Family Ranch LLC", address: ["P.O. Box 42", "Tremonton, UT 84337"], interest: "100%" },
    { name: "Jane Doe", address: ["123 Main St", "Brigham City, UT 84302"], interest: "Heir of record", remarks: "Notice returned undeliverable 2024" },
  ],
  changes: [
    { app_number: "a12345", filed: "2019-06-01", status: "Approved" },
    { app_number: "a98765", filed: "2024-02-10", status: "Pending" },
  ],
  points_of_diversion: [
    { description: "S 200 ft, E 500 ft from NW corner Sec 12", diverting_works: "Well", elevation: "4280 ft", utm: "12 392145E 4615200N" },
    { description: "Bear River diversion at canal headgate", diverting_works: "Headgate", elevation: "4265 ft", utm: "12 391850E 4615400N", stream_alteration_required: "Yes" },
  ],
  dates: {
    "Filed": "1903-04-15",
    "Advertised": "1903-05-01",
    "Protest Ends": "1903-06-01",
    "Approved": "1903-07-12",
    "Certificate Issued": "1908-10-22",
  },
  detail_url: "https://www.waterrights.utah.gov/wrinfo/print.asp?wrnum=43-10040",
});

const search = renderSearchResultsCard({
  mode: "owner",
  query: "Smith Family",
  total_found: 3,
  has_more: false,
  records: [
    { wr_number: "43-10040", owner: "Smith Family Ranch LLC", source: "Bear River", priority_date: "1903-04-15", flow_cfs: "0.13", volume_acft: "94.2", status: "CERT", detail_url: "https://www.waterrights.utah.gov/wrinfo/print.asp?wrnum=43-10040" },
    { wr_number: "57-2634", owner: "Smith Family Ranch LLC", source: "Hansel Valley Springs", priority_date: "1918-07-01", flow_cfs: "0.04", volume_acft: null, status: "WUC", detail_url: "https://www.waterrights.utah.gov/wrinfo/print.asp?wrnum=57-2634" },
    { wr_number: "E5428", owner: "Smith, Jane Q.", source: "Underground water", priority_date: null, flow_cfs: null, volume_acft: "12.0", status: "APP", detail_url: null },
  ],
});

const docs = renderScannedDocsCard("43-10040", 4, [
  { doc_seq_n: 1, docdate: "1903-04-15", codedesc: "Original Application", comment: "Filed by D.R. Smith", pdf_url: "https://www.waterrights.utah.gov/asp_apps/DOCDB/DocImageToPDF.asp?file=/x/y/z.tif", direct_url: "https://www.waterrights.utah.gov/x/y/z.tif" },
  { doc_seq_n: 2, docdate: "1908-10-22", codedesc: "Certificate of Appropriation", comment: "", pdf_url: "https://www.waterrights.utah.gov/asp_apps/DOCDB/DocImageToPDF.asp?file=/x/y/cert.tif", direct_url: "https://www.waterrights.utah.gov/x/y/cert.tif" },
  { doc_seq_n: 3, docdate: "2019-06-01", codedesc: "Change Application", comment: "POD relocation request", pdf_url: "https://www.waterrights.utah.gov/asp_apps/DOCDB/DocImageToPDF.asp?file=/x/y/ch1.pdf", direct_url: "https://www.waterrights.utah.gov/x/y/ch1.pdf" },
  { doc_seq_n: 4, docdate: "2024-02-10", codedesc: "Well Driller's Report", comment: "Driller: ACME Drilling", pdf_url: "https://www.waterrights.utah.gov/asp_apps/DOCDB/DocImageToPDF.asp?file=/x/y/wd.tif", direct_url: "https://www.waterrights.utah.gov/x/y/wd.tif" },
]);

writeFileSync(join(outDir, "water-right.html"), wr);
writeFileSync(join(outDir, "search.html"), search);
writeFileSync(join(outDir, "docs.html"), docs);
console.log("Wrote samples to", outDir);
