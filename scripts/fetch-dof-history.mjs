#!/usr/bin/env node
/**
 * Downloads deduplicated NYC DOF storefront records (2021–2025) including
 * filing_due_date so Feb 15 supplemental filings are NEVER double-counted
 * alongside June Annual RPIE filings.
 *
 * Writes:
 *   /tmp/dof_2025_full_p1.json & /tmp/dof_2025_full_p2.json (full 2025 rows incl. filing_due_date)
 *   /tmp/dof_hist_2021.json .. /tmp/dof_hist_2024.json (deduplicated compact tuples)
 */
import fs from 'node:fs';
import { dedupeDofRows, parseDofVacant } from '../src/lib/dofDedupe.js';

const HIST_YEARS = [
	{ key: '2021', yearNum: 2021, filter: '2021 and 2022' },
	{ key: '2022', yearNum: 2022, filter: '2022 and 2023' },
	{ key: '2023', yearNum: 2023, filter: '2023' },
	{ key: '2024', yearNum: 2024, filter: '2024' }
];

async function fetch2025Full() {
	const base =
		"https://data.cityofnewyork.us/resource/92iy-9c3n.json?$select=latitude,longitude,vacant_on_12_31,filing_due_date,borough_block_lot,bbl,borough,nta,nbhd,property_number,property_street,property_street_address_or,primary_business_activity&$where=reporting_year='2025'+AND+latitude+IS+NOT+NULL&$order=:id&$limit=50000";
	const [r1, r2] = await Promise.all([fetch(`${base}&$offset=0`), fetch(`${base}&$offset=50000`)]);
	if (!r1.ok) throw new Error(`DOF 2025 p1 HTTP ${r1.status}`);
	if (!r2.ok) throw new Error(`DOF 2025 p2 HTTP ${r2.status}`);
	const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
	fs.writeFileSync('/tmp/dof_2025_full_p1.json', JSON.stringify(d1));
	fs.writeFileSync('/tmp/dof_2025_full_p2.json', JSON.stringify(d2));
	const deduped = dedupeDofRows([...d1, ...d2], { fixedYear: 2025 });
	const vac = deduped.filter((r) => parseDofVacant(r.vacant_on_12_31) === true).length;
	console.log(
		`DOF 2025 full: raw ${d1.length + d2.length} -> deduped ${deduped.length.toLocaleString()}, ${vac.toLocaleString()} vacant (${((vac / Math.max(1, deduped.length)) * 100).toFixed(2)}%)`
	);
}

async function fetchHistYear({ key, yearNum, filter }) {
	const outPath = `/tmp/dof_hist_${key}.json`;
	const where = encodeURIComponent(
		`reporting_year='${filter}' AND latitude IS NOT NULL AND vacant_on_12_31 IS NOT NULL`
	);
	const base = `https://data.cityofnewyork.us/resource/92iy-9c3n.json?$select=latitude,longitude,vacant_on_12_31,filing_due_date,borough_block_lot,bbl,property_street&$where=${where}&$order=:id&$limit=50000`;

	const [r1, r2] = await Promise.all([fetch(`${base}&$offset=0`), fetch(`${base}&$offset=50000`)]);
	if (!r1.ok) throw new Error(`${key} p1 HTTP ${r1.status}`);
	if (!r2.ok) throw new Error(`${key} p2 HTTP ${r2.status}`);
	const [d1, d2] = await Promise.all([r1.json(), r2.json()]);

	const raw = [...d1, ...d2];
	const deduped = dedupeDofRows(raw, { fixedYear: yearNum });

	// Pack into compact tuples: [lat, lng, vacant(0|1), street]
	const packed = [];
	for (const r of deduped) {
		const isVac = parseDofVacant(r.vacant_on_12_31);
		if (isVac === null) continue;
		const lat = Number(r.latitude);
		const lng = Number(r.longitude);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		packed.push([
			Math.round(lat * 100000) / 100000,
			Math.round(lng * 100000) / 100000,
			isVac ? 1 : 0,
			r.property_street ? String(r.property_street).trim() : ''
		]);
	}

	fs.writeFileSync(outPath, JSON.stringify(packed));
	const vac = packed.reduce((s, p) => s + p[2], 0);
	console.log(
		`DOF ${key} (${filter}): raw ${raw.length.toLocaleString()} -> deduped ${packed.length.toLocaleString()}, ${vac.toLocaleString()} vacant (${((vac / Math.max(1, packed.length)) * 100).toFixed(2)}%) -> ${outPath}`
	);
}

Promise.all([fetch2025Full(), ...HIST_YEARS.map(fetchHistYear)]).catch((err) => {
	console.error(err);
	process.exit(1);
});
