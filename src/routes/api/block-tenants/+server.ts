import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { cleanDofActivity, dedupeDofRows, parseDofVacant, parseDofYear } from '$lib/dofDedupe';
import type { RequestHandler } from './$types';
import type { BlockTenantInfo, BlockTenantsResponse, TenantRecord } from '$lib/types';

function cleanBusinessName(raw: string): string {
	let s = (raw || '').trim().replace(/\s+/g, ' ');
	if (!s) return '';
	// Strip trailing legal suffixes so names read naturally ("SCREAMING MIMI'S INC" -> "Screaming Mimi's")
	s = s
		.replace(/[,.]?\s+\b(INC\.?|L\.?L\.?C\.?|CORP\.?|CORPORATION|LTD\.?|LIMITED|L\.?P\.?|CO\.?|N\.?Y\.?)\s*$/i, '')
		.replace(/[,.]?\s+\b(INC\.?|L\.?L\.?C\.?|CORP\.?|LTD\.?)\s*$/i, '')
		.trim();
	if (!s) return '';
	// Smart title case preserving apostrophes (Drai's, Flannery's, Mimi's) and common acronyms
	return s
		.toLowerCase()
		.replace(/(^|[\s\-/&(])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`)
		.replace(/\b(Nyc|Bbq|Cvs|Atm|Usa|Dba|Ii|Iii)\b/g, (m) => m.toUpperCase());
}

async function fetchJsonWithTimeout<T>(url: string, ms = 6000): Promise<T | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ms);
		const res = await globalThis.fetch(url, {
			signal: controller.signal,
			headers: { Accept: 'application/json' }
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

const tenantCache = new Map<string, { at: number; data: BlockTenantsResponse }>();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

export const GET: RequestHandler = async ({ url }) => {
	const rawBbls = (url.searchParams.get('bbls') || '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => /^[1-5]\d{9}$/.test(s));
	const rawVacant = (url.searchParams.get('vacant') || '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => /^[1-5]\d{9}$/.test(s));

	const uniqueBbls = [...new Set(rawBbls)].slice(0, 60).sort();
	const uniqueVacant = [...new Set(rawVacant)].slice(0, 30).sort();

	if (uniqueBbls.length === 0) {
		return json({ byBbl: {} } satisfies BlockTenantsResponse);
	}

	const cacheKey = `${uniqueBbls.join(',')}|${uniqueVacant.join(',')}`;
	const cached = tenantCache.get(cacheKey);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return json(cached.data, {
			headers: { 'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=86400' }
		});
	}

	const bblIn = uniqueBbls.map((b) => `'${b}'`).join(',');

	const dohmhUrl =
		'https://data.cityofnewyork.us/resource/43nn-pn8j.json?' +
		new URLSearchParams({
			$select: 'bbl,dba,cuisine_description,max(inspection_date) as last_date',
			$where: `bbl in (${bblIn})`,
			$group: 'bbl,dba,cuisine_description',
			$limit: '250'
		}).toString();

	const dcwpUrl =
		'https://data.cityofnewyork.us/resource/w7w3-xahh.json?' +
		new URLSearchParams({
			$select: 'bbl,business_name,business_category,license_status,lic_expir_dd',
			$where: `bbl in (${bblIn})`,
			$limit: '250'
		}).toString();

	// Fetch 2019–2025 DOF filings for ALL commercial BBLs on the block (powers both chronic-vacancy streaks AND the Block Time Machine!)
	const dofUrl =
		'https://data.cityofnewyork.us/resource/92iy-9c3n.json?' +
		new URLSearchParams({
			$select:
				'borough_block_lot,reporting_year,filing_due_date,vacant_on_12_31,primary_business_activity',
			$where: `borough_block_lot in (${bblIn})`,
			$limit: '2500'
		}).toString();

	type DohmhRow = { bbl?: string; dba?: string; cuisine_description?: string; last_date?: string };
	type DcwpRow = {
		bbl?: string;
		business_name?: string;
		business_category?: string;
		license_status?: string;
		lic_expir_dd?: string;
	};
	type DofRow = {
		borough_block_lot?: string;
		reporting_year?: string;
		filing_due_date?: string;
		vacant_on_12_31?: string;
		primary_business_activity?: string;
	};

	const [dohmhRows, dcwpRows, dofRows] = await Promise.all([
		fetchJsonWithTimeout<DohmhRow[]>(dohmhUrl, 5500),
		fetchJsonWithTimeout<DcwpRow[]>(dcwpUrl, 5500),
		dofUrl ? fetchJsonWithTimeout<DofRow[]>(dofUrl, 5500) : Promise.resolve(null)
	]);

	const byBbl: Record<string, BlockTenantInfo> = {};
	const ensure = (bbl: string): BlockTenantInfo => {
		if (!byBbl[bbl]) {
			byBbl[bbl] = { tenants: [], vacantYears: 0, vacantSinceYear: null, priorActivity: null };
		}
		return byBbl[bbl];
	};

	// Track deduplicated tenant names per BBL
	const seenByBbl = new Map<string, Map<string, TenantRecord>>();
	const addTenant = (bbl: string, rec: TenantRecord) => {
		if (!rec.name) return;
		const key = rec.name.toLowerCase().replace(/[^a-z0-9]/g, '');
		if (!key) return;
		if (!seenByBbl.has(bbl)) seenByBbl.set(bbl, new Map());
		const m = seenByBbl.get(bbl)!;
		const existing = m.get(key);
		if (!existing) {
			m.set(key, rec);
			return;
		}
		// Prefer active over recent/former, and newer date over older
		const rank = { active: 3, recent: 2, former: 1 };
		if (
			rank[rec.status] > rank[existing.status] ||
			(rank[rec.status] === rank[existing.status] && (rec.lastDate || '') > (existing.lastDate || ''))
		) {
			m.set(key, rec);
		}
	};

	// 1. DOHMH Restaurants / Cafes / Bars / Delis
	if (Array.isArray(dohmhRows)) {
		for (const row of dohmhRows) {
			const bbl = (row.bbl || '').split('.')[0].trim();
			if (!bbl || !row.dba) continue;
			const name = cleanBusinessName(row.dba);
			const rawDate = (row.last_date || '').slice(0, 10);
			const isRealDate = Boolean(rawDate && !rawDate.startsWith('1900'));
			const year = isRealDate ? parseInt(rawDate.slice(0, 4), 10) : 0;
			const status: TenantRecord['status'] =
				isRealDate && year >= 2024 ? 'active' : isRealDate ? 'recent' : 'recent';
			const cat =
				row.cuisine_description && row.cuisine_description !== 'Other'
					? row.cuisine_description
					: 'Food & Drink';
			addTenant(bbl, {
				name,
				category: cat,
				source: 'DOHMH',
				status,
				lastDate: isRealDate ? rawDate : null
			});
		}
	}

	// 2. DCWP Licensed Businesses (non-food retail, vintage, salons, laundromats, smoke shops, garages)
	if (Array.isArray(dcwpRows)) {
		for (const row of dcwpRows) {
			const bbl = (row.bbl || '').split('.')[0].trim();
			if (!bbl || !row.business_name) continue;
			const name = cleanBusinessName(row.business_name);
			const st = (row.license_status || '').toLowerCase();
			const status: TenantRecord['status'] = st === 'active' ? 'active' : 'former';
			const exp = (row.lic_expir_dd || '').slice(0, 10) || null;
			addTenant(bbl, {
				name,
				category: (row.business_category || 'Licensed Business').split(' - ')[0],
				source: 'DCWP',
				status,
				lastDate: exp
			});
		}
	}

	for (const [bbl, map] of seenByBbl.entries()) {
		const info = ensure(bbl);
		const rank = { active: 3, recent: 2, former: 1 };
		info.tenants = [...map.values()]
			.sort((a, b) => {
				const rDiff = rank[b.status] - rank[a.status];
				if (rDiff !== 0) return rDiff;
				return (b.lastDate || '').localeCompare(a.lastDate || '');
			})
			.slice(0, 4);
	}

	// 3. DOF Multi-Year History (2019–2025) & Chronic Vacancy Streaks (deduplicated Feb vs June RPIE)
	const allYearsSet = new Set<number>();
	if (Array.isArray(dofRows)) {
		const cleanDofRows = dedupeDofRows(dofRows);
		const byBblYear = new Map<string, Map<number, { vacant: number; occupied: number; acts: string[] }>>();
		for (const row of cleanDofRows) {
			const bbl = (row.borough_block_lot || '').split('.')[0].trim();
			const yr = parseDofYear(row.reporting_year);
			const isVac = parseDofVacant(row.vacant_on_12_31);
			if (!bbl || !yr || isVac === null) continue;
			allYearsSet.add(yr);
			if (!byBblYear.has(bbl)) byBblYear.set(bbl, new Map());
			const ym = byBblYear.get(bbl)!;
			if (!ym.has(yr)) ym.set(yr, { vacant: 0, occupied: 0, acts: [] });
			const bucket = ym.get(yr)!;
			if (isVac) bucket.vacant++;
			else bucket.occupied++;
			const act = cleanDofActivity(row.primary_business_activity || '', yr, isVac);
			if (act && !bucket.acts.includes(act)) bucket.acts.push(act);
		}

		for (const [bbl, ym] of byBblYear.entries()) {
			const info = ensure(bbl);
			const years = [...ym.keys()].sort((a, b) => b - a);
			const byYear: Record<string, { v: number; o: number }> = {};
			for (const [yr, b] of ym.entries()) {
				byYear[String(yr)] = { v: b.vacant, o: b.occupied };
			}
			info.byYear = byYear;

			let streak = 0;
			let sinceYear: number | null = null;
			for (const yr of years) {
				const b = ym.get(yr)!;
				if (b.vacant > 0) {
					streak++;
					sinceYear = yr;
				} else {
					break;
				}
			}
			info.vacantYears = streak;
			info.vacantSinceYear = sinceYear;

			// Find last non-vacant activity before the vacancy streak started
			for (const yr of years) {
				if (sinceYear && yr >= sinceYear) continue;
				const b = ym.get(yr)!;
				if (b.acts.length > 0) {
					info.priorActivity = b.acts[0];
					break;
				}
			}
		}
	}

	const availableYears = [...allYearsSet].filter((y) => y >= 2019 && y <= 2025).sort((a, b) => a - b);
	const payload: BlockTenantsResponse = { byBbl, years: availableYears };
	tenantCache.set(cacheKey, { at: Date.now(), data: payload });

	return json(payload, {
		headers: { 'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=86400' }
	});
};
