/**
 * Canonical NYC DOF Storefront Registry (92iy-9c3n) year parsing & deduplication.
 *
 * Why this exists:
 * Starting with reporting_year '2023', NYC DOF publishes multiple filing periods
 * under the same reporting_year:
 *   - Aug 15 (mid-year June 30 supplemental; vacant_on_12_31 is null)
 *   - Feb 15 (Local Law 157 supplemental filing for vacant units on Dec 31 only)
 *   - Jun 1/3 (Annual RPIE full storefront census: ALL occupied + vacant units on Dec 31)
 *
 * Roughly ~72% of buildings that file the Feb 15 supplemental ALSO file the June RPIE,
 * which causes naive aggregations over 92iy-9c3n to double-count ~1,700 vacant storefronts
 * per year (e.g. turning 540 W 28th St's 2/3 vacant in 2023 into 4/5).
 *
 * Rule: For each (BBL, reportingYear), if the building filed an annual (non-February)
 * RPIE return, drop its February supplemental rows. Keep February supplemental rows
 * only for buildings that did NOT file an annual return that year.
 */

export function parseDofYear(raw) {
	const m = String(raw || '').trim().match(/^(\d{4})/);
	return m ? parseInt(m[1], 10) : 0;
}

export function parseDofVacant(raw) {
	const ans = String(raw || '').trim().toUpperCase();
	if (ans === 'YES' || ans === 'Y') return true;
	if (ans === 'NO' || ans === 'N') return false;
	return null;
}

export function isFebSupplemental(filingDueDate) {
	const s = String(filingDueDate || '').trim();
	// Matches ISO dates like "2024-02-15T00:00:00.000" or "2025-02-15"
	return /^\d{4}-02-/.test(s);
}

function rowBblKey(r) {
	const bbl = String(r.borough_block_lot || r.bbl || '').split('.')[0].trim();
	if (bbl) return bbl;
	const addr = String(
		r.property_street_address_or || `${r.property_number || ''} ${r.property_street || ''}`
	)
		.trim()
		.toUpperCase()
		.replace(/\s+/g, ' ');
	return addr ? `addr:${addr}` : '';
}

/**
 * Filter & deduplicate NYC DOF 92iy-9c3n rows to a single authoritative Dec 31
 * snapshot per (BBL, reportingYear).
 *
 * @template T
 * @param {T[]} rows
 * @param {{ fixedYear?: number }} [opts]
 * @returns {T[]}
 */
export function dedupeDofRows(rows, opts = {}) {
	if (!Array.isArray(rows) || rows.length === 0) return [];
	const fixedYear = opts.fixedYear || 0;

	const valid = [];
	const hasAnnualFiling = new Set();

	for (const r of rows) {
		if (!r) continue;
		const vac = parseDofVacant(r.vacant_on_12_31);
		if (vac === null) continue;
		const yr = fixedYear || parseDofYear(r.reporting_year);
		if (!yr) continue;
		const key = `${rowBblKey(r)}|${yr}`;
		const isFeb = isFebSupplemental(r.filing_due_date);
		if (!isFeb && key !== `|${yr}`) {
			hasAnnualFiling.add(key);
		}
		valid.push({ row: r, key, isFeb });
	}

	const out = [];
	for (const item of valid) {
		if (item.isFeb && hasAnnualFiling.has(item.key)) continue;
		out.push(item.row);
	}
	return out;
}

/**
 * Clean NYC DOF `primary_business_activity` safely.
 *
 * Starting in reporting_year 2023, NYC DOF's Open Data export shifted its
 * business-activity lookup table (turning ~21k Retail shops into "EDUCATIONAL SERVICES",
 * ~15k Food Services into "RETAIL", ~4k Healthcare into "PUBLISHING", etc.).
 * We therefore return '' for 2023+ filings so callers fall back to neutral
 * "Open"/"Storefront" labels (or verified DOHMH/DCWP business names), while
 * preserving accurate 2019–2022 DOF activity labels.
 */
export function cleanDofActivity(raw, year, isVacant = false) {
	if (isVacant) return '';
	if (!year || year >= 2023) return '';
	const s = String(raw || '').trim();
	if (!s || /NO BUSINESS ACTIVITY/i.test(s) || /^OTHER$/i.test(s)) return '';
	return s
		.toLowerCase()
		.replace(/\b([a-z])/g, (c) => c.toUpperCase())
		.replace(/\bAnd\b/g, '&')
		.replace(/\bOr\b/g, 'or');
}
