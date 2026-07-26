// Styled .xlsx version of the structures-at-risk export. A plain CSV can't
// do any of what makes a report like this actually scannable — merged/blank
// repeated cells to show which rows belong to the same incident, or
// highlighting the rows that matter (a structure with a real address you
// can actually go knock on, vs. an OSM building footprint with no address
// tag at all). Excel/Sheets can, so this is a real spreadsheet built with
// ExcelJS rather than string-concatenated CSV rows.

const ExcelJS = require('exceljs');

const HEADER = [
  'Incident Address', 'Incident Type', 'Incident Date', 'Incident Status',
  'Affected Address', 'Building Type', 'Distance (m)', 'Bearing (°)',
  'Smoke Damage %', 'Risk Tier', 'Lat', 'Lon', 'Computed At', 'Structure ID',
];

const TIER_FILL = {
  High: 'FFFFC7CE',     // light red
  Moderate: 'FFFFEB9C', // light amber
  Low: 'FFC6EFCE',      // light green
};
const TIER_FONT = {
  High: 'FF9C0006',
  Moderate: 'FF9C6500',
  Low: 'FF006100',
};

function isPlaceholderAddress(addr) {
  return !addr || addr.startsWith('Structure - no address');
}

// rows: the same shape produced by formatAffectedAddress()-enriched rows in
// fn-webhook-server.js — each has incident_address/incident_type/... already
// resolved to plain strings/numbers, one row per (incident, structure).
async function buildStructuresWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FireWatch USA';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Structures at Risk', {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze header row
  });

  sheet.columns = [
    { width: 34 }, { width: 26 }, { width: 20 }, { width: 14 },
    { width: 34 }, { width: 16 }, { width: 12 }, { width: 10 },
    { width: 14 }, { width: 12 }, { width: 11 }, { width: 11 },
    { width: 20 }, { width: 12 },
  ];

  const headerRow = sheet.addRow(HEADER);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FF000000' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: HEADER.length } };

  // Group consecutive rows sharing the same incident so the blank-repeat
  // effect (and the alternating shading fallback, in case someone re-sorts
  // and the blanks stop lining up) actually groups the right rows. Rows
  // already come in largely-grouped order from the dedup step upstream, but
  // sort explicitly here so it's guaranteed rather than incidental.
  const sorted = [...rows].sort((a, b) => {
    if (a.incident_address !== b.incident_address) return a.incident_address < b.incident_address ? -1 : 1;
    return (b.smoke_damage_pct || 0) - (a.smoke_damage_pct || 0);
  });

  let lastIncidentKey = null;
  let bandOn = false;

  for (const r of sorted) {
    const incidentKey = r.incident_address + '|' + r.incident_date;
    const isNewGroup = incidentKey !== lastIncidentKey;
    if (isNewGroup) bandOn = !bandOn;
    lastIncidentKey = incidentKey;

    const row = sheet.addRow([
      isNewGroup ? r.incident_address : '',
      isNewGroup ? r.incident_type : '',
      isNewGroup ? r.incident_date : '',
      isNewGroup ? r.incident_status : '',
      r.affected_address, r.building_type, r.distance_m, r.bearing_deg,
      r.smoke_damage_pct, r.risk_tier, r.lat, r.lon, r.computed_at, r.incident_structure_id,
    ]);

    // Band shading per incident group so grouping stays visible even if the
    // sheet gets re-sorted later and the blank-repeat cells no longer line
    // up under their group.
    if (bandOn) {
      row.eachCell(cell => {
        if (!cell.fill || !cell.fill.fgColor) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      });
    }

    // The whole point of this differentiation: a row with a REAL address is
    // something a CRM user can actually act on (contact/inspect); a
    // "Structure - no address" row is just an OSM building footprint OSM
    // never tagged with an address. Bold + tier-colored fill makes the
    // actionable rows visually pop out of the placeholder ones.
    const hasRealAddress = !isPlaceholderAddress(r.affected_address);
    const addressCell = row.getCell(5);
    if (hasRealAddress) {
      addressCell.font = { bold: true };
      const fill = TIER_FILL[r.risk_tier];
      if (fill) {
        row.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }; });
        row.getCell(9).font = { bold: true, color: { argb: TIER_FONT[r.risk_tier] } }; // smoke_damage_pct
        row.getCell(10).font = { bold: true, color: { argb: TIER_FONT[r.risk_tier] } }; // risk_tier
      }
    } else {
      addressCell.font = { italic: true, color: { argb: 'FF808080' } };
    }

    if (typeof r.smoke_damage_pct === 'number') row.getCell(9).numFmt = '0.0"%"';
  }

  return wb;
}

module.exports = { buildStructuresWorkbook, isPlaceholderAddress };
