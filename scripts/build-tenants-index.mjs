#!/usr/bin/env node
/**
 * Builds a compact, citywide BBL -> Business Name static index from NYC DOHMH (restaurants)
 * and NYC DCWP (active retail/service licenses), filtered strictly to BBLs that appear in our
 * 349 commercial clusters so the file stays super tiny (~500 KB gzipped) while giving 0ms
 * instant business names across all 14,000 commercial blocks in all 5 boroughs!
 */
import fs from 'node:fs';

function cleanBusinessName(raw) {
	let s = (raw || '').trim().replace(/\s+/g, ' ');
	if (!s) return '';
	s = s
		.replace(
			/[,.]?\s+\b(INC\.?|L\.?L\.?C\.?|CORP\.?|CORPORATION|LTD\.?|LIMITED|L\.?P\.?|CO\.?|N\.?Y\.?)\s*$/i,
			''
		)
		.replace(/[,.]?\s+\b(INC\.?|L\.?L\.?C\.?|CORP\.?|LTD\.?)\s*$/i, '')
		.trim();
	if (!s) return '';
	return s
		.toLowerCase()
		.replace(/(^|[\s\-/&(])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`)
		.replace(/\b(Nyc|Bbq|Cvs|Atm|Usa|Dba|Ii|Iii)\b/g, (m) => m.toUpperCase());
}

// 1. Collect all commercial BBLs across all 349 cluster shards
const targetBbls = new Set();
const shardFiles = fs.readdirSync('static/data/clusters').filter((f) => f.endsWith('.json'));
for (const f of shardFiles) {
	const shard = JSON.parse(fs.readFileSync(`static/data/clusters/${f}`, 'utf8'));
	for (const det of Object.values(shard.segmentDetails || {})) {
		for (const sf of det.storefronts || []) {
			const b = String(sf.bbl || '').split('.')[0].trim();
			if (/^[1-5]\d{9}$/.test(b)) targetBbls.add(b);
		}
	}
}
console.log(`Collected ${targetBbls.size} commercial BBLs across ${shardFiles.length} clusters.`);

// Compact tuple per tenant: [name, category, source ('R'=DOHMH, 'L'=DCWP), status ('a'=active,'r'=recent,'f'=former), lastDate]
const byBbl = new Map();
function addTenant(bbl, name, cat, src, status, date) {
	if (!targetBbls.has(bbl) || !name) return;
	const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
	if (!key) return;
	if (!byBbl.has(bbl)) byBbl.set(bbl, new Map());
	const m = byBbl.get(bbl);
	const prev = m.get(key);
	const rank = { a: 3, r: 2, f: 1 };
	if (!prev || rank[status] > rank[prev[3]] || (rank[status] === rank[prev[3]] && (date || '') > (prev[4] || ''))) {
		m.set(key, [name, cat, src, status, date || '']);
	}
}

async function fetchAll(baseUrl, select, extraParams = {}) {
	const rows = [];
	const limit = 50000;
	for (let offset = 0; offset < 250000; offset += limit) {
		const params = new URLSearchParams({
			$select: select,
			$limit: String(limit),
			$offset: String(offset),
			...extraParams
		});
		const res = await fetch(`${baseUrl}?${params.toString()}`);
		if (!res.ok) throw new Error(`HTTP ${res.status} on ${baseUrl}`);
		const batch = await res.json();
		rows.push(...batch);
		console.log(`  fetched ${batch.length} rows (total ${rows.length}) from ${baseUrl.slice(-14)}`);
		if (batch.length < limit) break;
	}
	return rows;
}

console.log('Fetching NYC DOHMH restaurants (43nn-pn8j)...');
const dohmh = await fetchAll(
	'https://data.cityofnewyork.us/resource/43nn-pn8j.json',
	'bbl,dba,cuisine_description,max(inspection_date) as last_date',
	{ $where: 'bbl IS NOT NULL AND dba IS NOT NULL', $group: 'bbl,dba,cuisine_description' }
);
for (const r of dohmh) {
	const bbl = String(r.bbl || '').split('.')[0].trim();
	const name = cleanBusinessName(r.dba);
	const dt = String(r.last_date || '').slice(0, 10);
	const realDt = dt && !dt.startsWith('1900') ? dt : '';
	const yr = realDt ? parseInt(realDt.slice(0, 4), 10) : 0;
	const cat = r.cuisine_description && r.cuisine_description !== 'Other' ? r.cuisine_description : 'Food & Drink';
	addTenant(bbl, name, cat, 'R', yr >= 2024 ? 'a' : 'r', realDt);
}

console.log('Fetching NYC DCWP active licenses (w7w3-xahh)...');
const dcwp = await fetchAll(
	'https://data.cityofnewyork.us/resource/w7w3-xahh.json',
	'bbl,business_name,business_category,license_status,lic_expir_dd',
	{ $where: "bbl IS NOT NULL AND business_name IS NOT NULL AND license_status = 'Active'" }
);
for (const r of dcwp) {
	const bbl = String(r.bbl || '').split('.')[0].trim();
	const name = cleanBusinessName(r.business_name);
	const cat = String(r.business_category || 'Licensed Business').split(' - ')[0];
	const dt = String(r.lic_expir_dd || '').slice(0, 10);
	addTenant(bbl, name, cat, 'L', 'a', dt);
}

const out = {};
const rank = { a: 3, r: 2, f: 1 };
for (const [bbl, m] of byBbl.entries()) {
	out[bbl] = [...m.values()]
		.sort((a, b) => rank[b[3]] - rank[a[3]] || (b[4] || '').localeCompare(a[4] || ''))
		.slice(0, 3);
}

const outPath = 'static/data/nyc-tenants-index.json';
fs.writeFileSync(outPath, JSON.stringify({ syncedAt: new Date().toISOString(), byBbl: out }));
const sizeKb = Math.round(fs.statSync(outPath).size / 1024);
console.log(`Wrote ${outPath}: ${Object.keys(out).length} BBLs (${sizeKb} KB uncompressed).`);
