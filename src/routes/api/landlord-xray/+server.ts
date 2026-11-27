import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { dedupeDofRows, parseDofVacant, parseDofYear } from '$lib/dofDedupe';
import { PersistentCache } from '$lib/server/cache';
import type { RequestHandler } from './$types';
import type {
	ClustersFile,
	ClusterShard,
	LandlordPortfolioBuilding,
	LandlordXrayResponse
} from '$lib/types';

const BORO_NAMES: Record<string, string> = {
	'1': 'Manhattan',
	'2': 'Bronx',
	'3': 'Brooklyn',
	'4': 'Queens',
	'5': 'Staten Island'
};

const GENERIC_OWNERS = new Set([
	'UNAVAILABLE OWNER',
	'NAME NOT ON FILE',
	'CITY OF NEW YORK',
	'NYC DEPARTMENT OF HOUSING',
	'DCAS',
	'NYCHA',
	'NEW YORK CITY HOUSING AUTHORITY',
	'THE CITY OF NEW YORK',
	'BOARD OF EDUCATION',
	'PARKS AND RECREATION'
]);

const xrayCache = new PersistentCache<LandlordXrayResponse>('landlord-xray-v1', 1000 * 60 * 60 * 48, 1200);
let cachedClusters: ClustersFile | null = null;
const shardCache = new Map<string, ClusterShard>();

function titleCase(s: string): string {
	return (s || '')
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
		.replace(/\b([a-z])/g, (c) => c.toUpperCase())
		.replace(/\bLlc\b/g, 'LLC')
		.replace(/\bInc\b(?!\.)/g, 'Inc.')
		.replace(/\bCorp\b(?!\.)/g, 'Corp.')
		.replace(/\bLtd\b(?!\.)/g, 'Ltd.')
		.replace(/\bNy\b/g, 'NY')
		.replace(/\bNj\b/g, 'NJ')
		.replace(/\bCt\b/g, 'CT')
		.replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, suf) => `${n}${suf.toLowerCase()}`);
}

function escSoql(s: string): string {
	return s.replace(/'/g, "''");
}

async function fetchJsonSafe<T>(url: string, timeoutMs = 6500): Promise<T[]> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await globalThis.fetch(url, {
			signal: controller.signal,
			headers: { Accept: 'application/json' }
		});
		clearTimeout(timer);
		if (!res.ok) return [];
		const data = await res.json();
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

function makeBbl(boroid: string | undefined, block: string | undefined, lot: string | undefined): string {
	const b = String(boroid || '').trim();
	const blk = String(block || '').replace(/\D/g, '');
	const lt = String(lot || '').replace(/\D/g, '');
	if (!/^[1-5]$/.test(b) || !blk || !lt) return '';
	return `${b}${blk.padStart(5, '0')}${lt.padStart(4, '0')}`;
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0],
			yi = ring[i][1];
		const xj = ring[j][0],
			yj = ring[j][1];
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function pointInGeom(
	lng: number,
	lat: number,
	geom: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
	const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
	for (const poly of polys) {
		if (!pointInRing(lng, lat, poly[0])) continue;
		let inHole = false;
		for (let i = 1; i < poly.length; i++) {
			if (pointInRing(lng, lat, poly[i])) {
				inHole = true;
				break;
			}
		}
		if (!inHole) return true;
	}
	return false;
}

function distToLine(lng: number, lat: number, line: [number, number][]): number {
	let best = Infinity;
	for (let i = 0; i < line.length - 1; i++) {
		const [ax, ay] = line[i];
		const [bx, by] = line[i + 1];
		const vx = bx - ax;
		const vy = by - ay;
		const l2 = vx * vx + vy * vy;
		const t = l2 > 0 ? Math.max(0, Math.min(1, ((lng - ax) * vx + (lat - ay) * vy) / l2)) : 0;
		const d = Math.hypot(lng - (ax + t * vx), lat - (ay + t * vy));
		if (d < best) best = d;
	}
	return best;
}

async function resolveBuildingHref(
	bbl: string,
	lat: number | null,
	lng: number | null,
	fetchFn: typeof fetch
): Promise<string | null> {
	if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (!cachedClusters) {
		const res = await fetchFn('/data/nyc-clusters.json');
		if (!res.ok) return null;
		cachedClusters = (await res.json()) as ClustersFile;
	}
	let hit = cachedClusters.clusters.features.find((f) => {
		const b = f.properties.bbox;
		if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return false;
		return pointInGeom(lng, lat, f.geometry);
	});
	if (!hit) {
		let bestD = Infinity;
		for (const f of cachedClusters.clusters.features) {
			const d = Math.hypot(f.properties.center[0] - lng, f.properties.center[1] - lat);
			if (d < bestD) {
				bestD = d;
				hit = f;
			}
		}
		if (bestD > 0.015) return null;
	}
	if (!hit) return null;

	const cid = hit.properties.id;
	let shard = shardCache.get(cid);
	if (!shard) {
		const sRes = await fetchFn(`/data/clusters/${cid}.json`);
		if (!sRes.ok) return `/cluster/${cid}`;
		shard = (await sRes.json()) as ClusterShard;
		shardCache.set(cid, shard);
	}

	// First check exact BBL presence in any segment's storefronts
	for (const seg of shard.segments) {
		const det = shard.segmentDetails[seg.id];
		if (det?.storefronts?.some((sf) => (sf.bbl || '').split('.')[0] === bbl)) {
			return `/cluster/${cid}/block/${seg.id}/building/${bbl}`;
		}
	}

	// Fallback: nearest segment by geometry
	let bestSegId: string | null = null;
	let bestD = Infinity;
	for (const seg of shard.segments) {
		const d = distToLine(lng, lat, seg.line);
		if (d < bestD) {
			bestD = d;
			bestSegId = seg.id;
		}
	}
	if (bestSegId && bestD < 0.002) {
		return `/cluster/${cid}/block/${bestSegId}/building/${bbl}`;
	}
	return `/cluster/${cid}`;
}

export const GET: RequestHandler = async ({ url, fetch }) => {
	const rawBbl = (url.searchParams.get('bbl') || '').replace(/\D/g, '');
	const plutoOwnerParam = (url.searchParams.get('owner') || '').trim();
	if (!/^[1-5]\d{9}$/.test(rawBbl)) {
		throw error(400, 'Invalid NYC BBL');
	}

	const cached = xrayCache.get(rawBbl);
	if (cached) {
		return json(cached, {
			headers: { 'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=43200' }
		});
	}

	const boro = rawBbl[0];
	const blockNum = String(parseInt(rawBbl.slice(1, 6), 10));
	const lotNum = String(parseInt(rawBbl.slice(6, 10), 10));

	type HpdReg = {
		registrationid?: string;
		boroid?: string;
		block?: string;
		lot?: string;
		housenumber?: string;
		streetname?: string;
		lastregistrationdate?: string;
	};
	type HpdContact = {
		registrationid?: string;
		type?: string;
		corporationname?: string;
		firstname?: string;
		lastname?: string;
		businesshousenumber?: string;
		businessstreetname?: string;
		businesscity?: string;
		businessstate?: string;
		businesszip?: string;
	};
	type PlutoRow = {
		bbl?: string;
		address?: string;
		borough?: string;
		ownername?: string;
		latitude?: string;
		longitude?: string;
	};
	type DofRow = {
		borough_block_lot?: string;
		reporting_year?: string;
		filing_due_date?: string;
		vacant_on_12_31?: string;
		property_street_address_or?: string;
		latitude?: string;
		longitude?: string;
	};

	// 1. Check HPD Registration for this BBL
	const regUrl =
		'https://data.cityofnewyork.us/resource/tesw-yqqr.json?' +
		new URLSearchParams({
			boroid: boro,
			block: blockNum,
			lot: lotNum,
			$order: 'lastregistrationdate DESC',
			$limit: '3'
		}).toString();

	const regs = await fetchJsonSafe<HpdReg>(regUrl, 5500);
	const latestRegId = regs[0]?.registrationid?.trim() || '';

	let entityName = plutoOwnerParam || 'Owner';
	let matchedVia: LandlordXrayResponse['matchedVia'] = 'NYC Owner Name';
	let businessAddress: string | null = null;
	const portfolioMap = new Map<
		string,
		{ bbl: string; address: string; borough: string; lat: number | null; lng: number | null }
	>();

	if (latestRegId) {
		const contactsUrl =
			'https://data.cityofnewyork.us/resource/feu5-w2e2.json?' +
			new URLSearchParams({
				registrationid: latestRegId,
				$limit: '15'
			}).toString();
		const contacts = await fetchJsonSafe<HpdContact>(contactsUrl, 5500);

		const headOfficer = contacts.find(
			(c) => c.type === 'HeadOfficer' && c.firstname && c.lastname && c.businesszip
		);
		const agentCorp = contacts.find(
			(c) => c.type === 'Agent' && c.corporationname && c.corporationname.trim().length > 3
		);
		const corpOwner = contacts.find(
			(c) =>
				c.type === 'CorporateOwner' &&
				c.corporationname &&
				c.corporationname.trim().length > 3
		);

		const pickContact = headOfficer || agentCorp || corpOwner || null;
		if (pickContact) {
			const addrParts = [
				pickContact.businesshousenumber,
				pickContact.businessstreetname,
				pickContact.businesscity,
				pickContact.businessstate,
				pickContact.businesszip
			].filter(Boolean);
			if (addrParts.length >= 2) {
				businessAddress = titleCase(addrParts.join(' '));
			}
		}

		const strategies: Array<{
			name: string;
			via: LandlordXrayResponse['matchedVia'];
			where: string;
		}> = [];

		if (headOfficer?.firstname && headOfficer?.lastname && headOfficer?.businesszip) {
			const fn = headOfficer.firstname.trim().toUpperCase();
			const ln = headOfficer.lastname.trim().toUpperCase();
			const zip = headOfficer.businesszip.trim().slice(0, 5);
			const corpHint = agentCorp?.corporationname
				? ` (${titleCase(agentCorp.corporationname)})`
				: corpOwner?.corporationname
					? ` (${titleCase(corpOwner.corporationname)})`
					: '';
			strategies.push({
				name: `${titleCase(`${fn} ${ln}`)}${corpHint}`,
				via: 'HPD Head Officer',
				where: `upper(firstname)='${escSoql(fn)}' AND upper(lastname)='${escSoql(ln)}' AND starts_with(businesszip,'${escSoql(zip)}')`
			});
		}
		if (agentCorp?.corporationname) {
			const cn = agentCorp.corporationname.trim().toUpperCase();
			strategies.push({
				name: titleCase(cn),
				via: 'HPD Managing Agent',
				where: `upper(corporationname)='${escSoql(cn)}'`
			});
		}
		if (corpOwner?.corporationname) {
			const cn = corpOwner.corporationname.trim().toUpperCase();
			strategies.push({
				name: titleCase(cn),
				via: 'HPD Corporate Owner',
				where: `upper(corporationname)='${escSoql(cn)}'`
			});
		}

		// Try HeadOfficer first; if that only finds 1 building, expand to Managing Agent / Corporate Owner!
		let chosenRegIds: string[] = [];
		for (const strat of strategies) {
			const sibContactsUrl =
				'https://data.cityofnewyork.us/resource/feu5-w2e2.json?' +
				new URLSearchParams({
					$select: 'registrationid',
					$where: strat.where,
					$group: 'registrationid',
					$limit: '80'
				}).toString();
			const sibContacts = await fetchJsonSafe<{ registrationid?: string }>(sibContactsUrl, 6000);
			const ids = [...new Set(sibContacts.map((r) => r.registrationid).filter(Boolean) as string[])].slice(
				0,
				65
			);
			if (ids.length > chosenRegIds.length) {
				chosenRegIds = ids;
				entityName = strat.name;
				matchedVia = strat.via;
			}
			if (chosenRegIds.length >= 2) break;
		}

		if (chosenRegIds.length > 0) {
			const regIn = chosenRegIds.map((id) => `'${escSoql(id)}'`).join(',');
			const sibRegsUrl =
				'https://data.cityofnewyork.us/resource/tesw-yqqr.json?' +
				new URLSearchParams({
					$select: 'boroid,block,lot,housenumber,streetname',
					$where: `registrationid in (${regIn})`,
					$limit: '100'
				}).toString();
			const sibRegs = await fetchJsonSafe<HpdReg>(sibRegsUrl, 6000);
			for (const r of sibRegs) {
				const bbl = makeBbl(r.boroid, r.block, r.lot);
				if (!bbl || portfolioMap.has(bbl)) continue;
				const addr = titleCase(`${r.housenumber || ''} ${r.streetname || ''}`.trim());
				portfolioMap.set(bbl, {
					bbl,
					address: addr || `BBL ${bbl}`,
					borough: BORO_NAMES[bbl[0]] || 'NYC',
					lat: null,
					lng: null
				});
			}
		}
	}

	// 2. Fallback for pure commercial / non-HPD buildings (or if HPD returned <= 1 building): check MapPLUTO exact ownername
	const upperPlutoOwner = plutoOwnerParam.toUpperCase().replace(/\s+/g, ' ').trim();
	if (
		portfolioMap.size <= 1 &&
		upperPlutoOwner.length >= 4 &&
		!GENERIC_OWNERS.has(upperPlutoOwner) &&
		!upperPlutoOwner.includes('CONDO')
	) {
		const plutoUrl =
			'https://data.cityofnewyork.us/resource/64uk-42ks.json?' +
			new URLSearchParams({
				$select: 'bbl,address,borough,ownername,latitude,longitude',
				$where: `upper(ownername)='${escSoql(upperPlutoOwner)}'`,
				$limit: '60'
			}).toString();
		const plutoRows = await fetchJsonSafe<PlutoRow>(plutoUrl, 6000);
		if (plutoRows.length > portfolioMap.size) {
			matchedVia = 'NYC Owner Name';
			entityName = plutoOwnerParam;
			for (const r of plutoRows) {
				const bbl = (r.bbl || '').split('.')[0].trim();
				if (!/^[1-5]\d{9}$/.test(bbl) || portfolioMap.has(bbl)) continue;
				const lat = r.latitude ? Number(r.latitude) : null;
				const lng = r.longitude ? Number(r.longitude) : null;
				portfolioMap.set(bbl, {
					bbl,
					address: titleCase(r.address || `BBL ${bbl}`),
					borough: BORO_NAMES[bbl[0]] || 'NYC',
					lat: Number.isFinite(lat) ? lat : null,
					lng: Number.isFinite(lng) ? lng : null
				});
			}
		}
	}

	// Ensure current BBL is included
	if (!portfolioMap.has(rawBbl)) {
		portfolioMap.set(rawBbl, {
			bbl: rawBbl,
			address: `BBL ${rawBbl}`,
			borough: BORO_NAMES[rawBbl[0]] || 'NYC',
			lat: null,
			lng: null
		});
	}

	const allBbls = [...portfolioMap.keys()].slice(0, 60);

	// 3. Query deduplicated NYC DOF Storefront Registry across ALL portfolio BBLs
	const bblIn = allBbls.map((b) => `'${b}'`).join(',');
	const dofUrl =
		'https://data.cityofnewyork.us/resource/92iy-9c3n.json?' +
		new URLSearchParams({
			$select:
				'borough_block_lot,reporting_year,filing_due_date,vacant_on_12_31,property_street_address_or,latitude,longitude',
			$where: `borough_block_lot in (${bblIn})`,
			$limit: '3000'
		}).toString();

	const rawDofRows = await fetchJsonSafe<DofRow>(dofUrl, 7000);
	const cleanDof = dedupeDofRows(rawDofRows);

	const byBblYear = new Map<
		string,
		{
			years: Map<number, { vacant: number; total: number }>;
			address: string;
			lat: number | null;
			lng: number | null;
		}
	>();

	for (const r of cleanDof) {
		const bbl = (r.borough_block_lot || '').split('.')[0].trim();
		const yr = parseDofYear(r.reporting_year);
		const isVac = parseDofVacant(r.vacant_on_12_31);
		if (!bbl || !yr || isVac === null) continue;
		if (!byBblYear.has(bbl)) {
			byBblYear.set(bbl, {
				years: new Map(),
				address: r.property_street_address_or ? titleCase(r.property_street_address_or) : '',
				lat: r.latitude ? Number(r.latitude) : null,
				lng: r.longitude ? Number(r.longitude) : null
			});
		}
		const rec = byBblYear.get(bbl)!;
		if (!rec.address && r.property_street_address_or) rec.address = titleCase(r.property_street_address_or);
		if (rec.lat === null && r.latitude && Number.isFinite(Number(r.latitude))) {
			rec.lat = Number(r.latitude);
			rec.lng = Number(r.longitude);
		}
		const bucket = rec.years.get(yr) || { vacant: 0, total: 0 };
		bucket.total++;
		if (isVac) bucket.vacant++;
		rec.years.set(yr, bucket);
	}

	const scored: Array<{
		bbl: string;
		address: string;
		borough: string;
		vacant: number;
		total: number;
		vacantYears: number;
		lat: number | null;
		lng: number | null;
		isCurrent: boolean;
	}> = [];

	let totalStorefronts = 0;
	let vacantStorefronts = 0;

	for (const [bbl, meta] of portfolioMap.entries()) {
		const dof = byBblYear.get(bbl);
		if (!dof) continue;
		const yearsDesc = [...dof.years.keys()].sort((a, b) => b - a);
		const latestYr = yearsDesc[0];
		if (!latestYr || latestYr < 2024) continue;
		const latest = dof.years.get(latestYr)!;
		let streak = 0;
		for (const yr of yearsDesc) {
			if ((dof.years.get(yr)?.vacant ?? 0) > 0) streak++;
			else break;
		}
		totalStorefronts += latest.total;
		vacantStorefronts += latest.vacant;

		scored.push({
			bbl,
			address: meta.address.startsWith('BBL ') && dof.address ? dof.address : meta.address,
			borough: meta.borough,
			vacant: latest.vacant,
			total: latest.total,
			vacantYears: streak,
			lat: meta.lat ?? dof.lat,
			lng: meta.lng ?? dof.lng,
			isCurrent: bbl === rawBbl
		});
	}

	// Sort: vacant buildings first (most vacant -> longest streak), then other commercial buildings
	scored.sort((a, b) => {
		if (b.vacant !== a.vacant) return b.vacant - a.vacant;
		if (b.vacantYears !== a.vacantYears) return b.vacantYears - a.vacantYears;
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return b.total - a.total;
	});

	const topBuildings = scored.slice(0, 10);
	const buildings: LandlordPortfolioBuilding[] = await Promise.all(
		topBuildings.map(async (b) => ({
			bbl: b.bbl,
			address: b.address,
			borough: b.borough,
			vacant: b.vacant,
			total: b.total,
			vacantYears: b.vacantYears,
			href: b.isCurrent ? null : await resolveBuildingHref(b.bbl, b.lat, b.lng, fetch),
			isCurrent: b.isCurrent
		}))
	);

	const responseData: LandlordXrayResponse = {
		bbl: rawBbl,
		plutoOwner: plutoOwnerParam,
		entityName,
		matchedVia,
		businessAddress,
		totalBuildings: portfolioMap.size,
		commercialBuildings: scored.length,
		totalStorefronts,
		vacantStorefronts,
		buildings
	};

	xrayCache.set(rawBbl, responseData);

	return json(responseData, {
		headers: { 'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=43200' }
	});
};
