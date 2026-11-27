import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { cleanDofActivity, dedupeDofRows, parseDofVacant, parseDofYear } from '$lib/dofDedupe';
import type { RequestHandler } from './$types';
import type {
	BuildingDossier,
	BuildingDofYear,
	BuildingDroppedSignal,
	BuildingOathItem,
	Building311Item,
	BuildingPermitItem,
	BuildingTenantItem
} from '$lib/types';

const BORO_NAMES: Record<string, string> = {
	'1': 'MANHATTAN',
	'2': 'BRONX',
	'3': 'BROOKLYN',
	'4': 'QUEENS',
	'5': 'STATEN ISLAND'
};

const BORO_DISPLAY: Record<string, string> = {
	'1': 'Manhattan',
	'2': 'Bronx',
	'3': 'Brooklyn',
	'4': 'Queens',
	'5': 'Staten Island'
};

const LANDUSE_LABELS: Record<string, string> = {
	'1': '1–2 Family Residential',
	'2': 'Multi-Family Walk-Up',
	'3': 'Elevator Apartment',
	'4': 'Mixed Residential & Commercial',
	'5': 'Commercial & Office',
	'6': 'Industrial & Manufacturing',
	'7': 'Transportation & Utility',
	'8': 'Public Facilities & Institutions',
	'9': 'Open Space & Recreation',
	'10': 'Parking Facility',
	'11': 'Vacant Land'
};

function titleCase(s: string): string {
	return s
		.toLowerCase()
		.replace(/\b([a-z])/g, (c) => c.toUpperCase())
		.replace(/\bLlc\b/g, 'LLC')
		.replace(/\bInc\b(?!\.)/g, 'Inc.')
		.replace(/\bCorp\b(?!\.)/g, 'Corp.')
		.replace(/\bLtd\b(?!\.)/g, 'Ltd.');
}

function cleanBusinessName(raw: string): string {
	let s = (raw || '').trim().replace(/\s+/g, ' ');
	if (!s) return '';
	s = s
		.replace(/[,.]?\s+\b(INC\.?|L\.?L\.?C\.?|CORP\.?|CORPORATION|LTD\.?|LIMITED|L\.?P\.?|CO\.?|N\.?Y\.?)\s*$/i, '')
		.replace(/[,.]?\s+\b(INC\.?|L\.?L\.?C\.?|CORP\.?|LTD\.?)\s*$/i, '')
		.trim();
	if (!s) return '';
	return s
		.toLowerCase()
		.replace(/(^|[\s\-/&(])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`)
		.replace(/\b(Nyc|Bbq|Cvs|Atm|Usa|Dba|Ii|Iii)\b/g, (m) => m.toUpperCase());
}

function cleanAddr(raw: string): string {
	const s = (raw || '').trim().replace(/\s+/g, ' ');
	if (!s) return '';
	return s
		.toLowerCase()
		.replace(/\b([a-z])/g, (c) => c.toUpperCase())
		.replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, suf) => `${n}${suf.toLowerCase()}`)
		.replace(/\bSreet\b/gi, 'Street');
}

function extractHouseNum(raw: string): string {
	const m = (raw || '').trim().match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)\b/i);
	return m ? m[1].toUpperCase() : '';
}

async function fetchJsonSafe<T>(url: string, timeoutMs = 8000): Promise<T[]> {
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

async function fetchObjectSafe<T>(url: string, timeoutMs = 5500): Promise<T | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
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

const dossierCache = new Map<string, { at: number; data: BuildingDossier }>();
const CACHE_TTL_MS = 1000 * 60 * 30;

export const GET: RequestHandler = async ({ url, platform }) => {
	const rawBbl = (url.searchParams.get('bbl') || '').split('.')[0].trim();
	if (!/^[1-5]\d{9}$/.test(rawBbl)) {
		throw error(400, 'Invalid 10-digit NYC BBL');
	}

	const apiKey = (
		env.GOOGLE_MAPS_API_KEY ||
		(platform?.env as Record<string, string> | undefined)?.GOOGLE_MAPS_API_KEY ||
		''
	).trim();

	const cacheKey = `v5:${rawBbl}:${apiKey ? 'sv' : 'nosv'}`;
	const cached = dossierCache.get(cacheKey);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
		return json(cached.data, {
			headers: { 'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=43200' }
		});
	}

	const boroCode = rawBbl[0];
	const blockNum = parseInt(rawBbl.slice(1, 6), 10);
	const lotNum = parseInt(rawBbl.slice(6, 10), 10);
	const blockPad5 = String(blockNum).padStart(5, '0');
	const lotPad4 = String(lotNum).padStart(4, '0');
	const lotPad5 = String(lotNum).padStart(5, '0');
	const boroUpper = BORO_NAMES[boroCode] || 'MANHATTAN';
	const boroDisplay = BORO_DISPLAY[boroCode] || 'New York';
	const isCondoBilling = lotNum >= 7500;

	// 1. PLUTO full property profile
	const plutoSelect =
		'bbl,address,ownername,zipcode,zonedist1,bldgclass,landuse,yearbuilt,numfloors,lotfront,lotdepth,bldgarea,retailarea,resarea,unitsres,unitstotal,assesstot,assessland,council,latitude,longitude';
	const plutoUrl = `https://data.cityofnewyork.us/resource/64uk-42ks.json?$select=${encodeURIComponent(plutoSelect)}&$where=${encodeURIComponent(`borocode=${boroCode} AND block=${blockNum} AND lot=${lotNum}`)}&$limit=1`;

	// 2. Multi-year NYC DOF Storefront Registry
	// For condo billing lots (7500+), DOF files under condo unit BBLs on the same block (e.g. 1008661202/1203 for 1008667501)
	const dofWhere = isCondoBilling
		? `borough_block_lot like '${boroCode}${blockPad5}%'`
		: `borough_block_lot='${rawBbl}'`;
	const dofUrl = `https://data.cityofnewyork.us/resource/92iy-9c3n.json?$where=${encodeURIComponent(dofWhere)}&$order=reporting_year%20DESC&$limit=${isCondoBilling ? 350 : 120}`;

	// 3. NYC OATH Hearings & Enforcement
	const oathUrl = `https://data.cityofnewyork.us/resource/jz4z-kudi.json?$select=${encodeURIComponent('violation_date,issuing_agency,respondent_last_name,violation_location_house,violation_location_street_name,charge_1_code_description,violation_details,hearing_status,total_violation_amount')}&$where=${encodeURIComponent(`violation_location_borough='${boroUpper}' AND violation_location_block_no='${blockPad5}' AND violation_location_lot_no='${lotPad4}'`)}&$order=violation_date%20DESC&$limit=20`;

	// 4. NYC 311 Service Requests
	const c311Url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?$select=${encodeURIComponent('created_date,incident_address,complaint_type,descriptor,status')}&$where=${encodeURIComponent(`bbl='${rawBbl}' AND created_date >= '2023-01-01'`)}&$order=created_date%20DESC&$limit=20`;

	// 5. NYC DOB NOW + Legacy DOB Permits
	const dobNowUrl = `https://data.cityofnewyork.us/resource/rbx6-tga4.json?$select=${encodeURIComponent('issued_date,job_type,work_type,permit_status,job_description,owner_business_name')}&$where=${encodeURIComponent(`borough='${boroUpper}' AND block in ('${blockNum}','${blockPad5}') AND lot in ('${lotNum}','${lotPad4}','${lotPad5}')`)}&$order=issued_date%20DESC&$limit=14`;

	const dobLegacyUrl = `https://data.cityofnewyork.us/resource/ipu4-2q9a.json?$select=${encodeURIComponent('issuance_date,job_type,work_type,permit_status,permit_subtype,owner_s_business_name')}&$where=${encodeURIComponent(`borough='${boroUpper}' AND block='${blockPad5}' AND lot='${lotPad5}'`)}&$order=issuance_date%20DESC&$limit=12`;

	// 6. NYC DOHMH Restaurant Inspections (full tenant history!)
	const dohmhUrl =
		'https://data.cityofnewyork.us/resource/43nn-pn8j.json?' +
		new URLSearchParams({
			$select: 'dba,cuisine_description,min(inspection_date) as first_dt,max(inspection_date) as last_dt,count(*) as cnt',
			$where: `bbl='${rawBbl}'`,
			$group: 'dba,cuisine_description',
			$limit: '30'
		}).toString();

	// 7. NYC DCWP Legally Operating Businesses (non-food retail, salons, vintage, garages, smoke shops)
	const dcwpUrl =
		'https://data.cityofnewyork.us/resource/w7w3-xahh.json?' +
		new URLSearchParams({
			$select: 'business_name,business_category,license_status,license_creation_date,lic_expir_dd',
			$where: `bbl='${rawBbl}'`,
			$limit: '30'
		}).toString();

	// 7b. NYC Open Restaurants Archive (2020–2023) — preserves closed restaurants purged by DOHMH
	const openRestUrl =
		'https://data.cityofnewyork.us/resource/pitm-atqc.json?' +
		new URLSearchParams({
			$select: 'restaurant_name,doing_business_as_dba,time_of_submission',
			$where: `bbl='${rawBbl}'`,
			$limit: '20'
		}).toString();

	// 7c. Historical OATH grouped respondents — recovers named former storefront businesses at this lot
	const oathHistUrl =
		'https://data.cityofnewyork.us/resource/jz4z-kudi.json?' +
		new URLSearchParams({
			$select: 'respondent_last_name,min(violation_date) as first_dt,max(violation_date) as last_dt,count(*) as cnt',
			$where: `violation_location_borough='${boroUpper}' AND violation_location_block_no='${blockPad5}' AND violation_location_lot_no='${lotPad4}' AND respondent_last_name IS NOT NULL`,
			$group: 'respondent_last_name',
			$order: 'cnt DESC',
			$limit: '60'
		}).toString();

	// 8. Surveyed MapPLUTO parcel polygon for the embedded 3D Parcel / NYC Aerial card
	const parcelUrl =
		'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query?' +
		new URLSearchParams({
			where: `BBL=${rawBbl}`,
			outFields: 'BBL',
			geometryPrecision: '6',
			outSR: '4326',
			f: 'geojson'
		}).toString();

	type ParcelGeo = {
		features?: Array<{ geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon | null }>;
	};

	const [
		plutoRows,
		rawDofRows,
		oathRows,
		c311Rows,
		dobNowRows,
		dobLegacyRows,
		dohmhRows,
		dcwpRows,
		openRestRows,
		oathHistRows,
		parcelGeo
	] = await Promise.all([
		fetchJsonSafe<Record<string, string>>(plutoUrl, 7500),
		fetchJsonSafe<Record<string, string>>(dofUrl, 7500),
		fetchJsonSafe<Record<string, string>>(oathUrl, 7500),
		fetchJsonSafe<Record<string, string>>(c311Url, 7500),
		fetchJsonSafe<Record<string, string>>(dobNowUrl, 6500),
		fetchJsonSafe<Record<string, string>>(dobLegacyUrl, 6500),
		fetchJsonSafe<Record<string, string>>(dohmhUrl, 6000),
		fetchJsonSafe<Record<string, string>>(dcwpUrl, 6000),
		fetchJsonSafe<Record<string, string>>(openRestUrl, 5000),
		fetchJsonSafe<Record<string, string>>(oathHistUrl, 6000),
		fetchObjectSafe<ParcelGeo>(parcelUrl, 5000)
	]);

	const pluto = plutoRows[0] || {};
	const plutoAddr = cleanAddr(pluto.address || '');
	const plutoHouseNum = extractHouseNum(pluto.address || '');
	const plutoStreetWords = (pluto.address || '')
		.toUpperCase()
		.replace(/^\d+[A-Z]?(?:-\d+[A-Z]?)?\s+/i, '')
		.replace(/[^A-Z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length >= 2 && !['ST', 'STREET', 'AVE', 'AVENUE', 'WEST', 'EAST', 'NORTH', 'SOUTH', 'W', 'E', 'N', 'S'].includes(w));

	// Filter condo block-level DOF rows to THIS building's condo unit BBLs (exact BBL first, else matching house number + street)
	let dofRows = rawDofRows.filter((r) => (r.borough_block_lot || r.bbl || '').split('.')[0].trim() === rawBbl);
	if (dofRows.length === 0 && isCondoBilling && rawDofRows.length > 0) {
		dofRows = rawDofRows.filter((r) => {
			const rowBbl = (r.borough_block_lot || r.bbl || '').split('.')[0].trim();
			const rowLot = parseInt(rowBbl.slice(6, 10), 10);
			if (!Number.isFinite(rowLot) || rowLot < 1000) return false;
			const rowAddr = String(
				r.property_street_address_or || `${r.property_number || ''} ${r.property_street || ''}`
			).toUpperCase();
			const rowNum = extractHouseNum(rowAddr);
			if (plutoHouseNum && rowNum && rowNum === plutoHouseNum) {
				if (plutoStreetWords.length === 0) return true;
				return plutoStreetWords.some((w) => rowAddr.includes(w));
			}
			return false;
		});
	}

	// Deduplicate Feb 15 supplemental filings whenever the same (BBL, reporting_year) filed its June Annual RPIE
	dofRows = dedupeDofRows(dofRows);

	// Build multi-year DOF Storefront timeline
	const byYear = new Map<number, BuildingDofYear>();
	for (const r of dofRows) {
		const yr = parseDofYear(r.reporting_year);
		if (!yr) continue;
		const vacant = parseDofVacant(r.vacant_on_12_31);
		if (vacant === null) continue;
		const cleanedAct = cleanDofActivity(r.primary_business_activity, yr, vacant);
		const activity = cleanedAct || (vacant ? 'No business reported' : 'Commercial');
		const construction = String(r.construction_reported || '').trim().toUpperCase() === 'YES' || String(r.construction_reported || '').trim().toUpperCase() === 'Y';
		const rawLease = String(r.expir_dt_of_most_recent_lease || '').slice(0, 10);
		const leaseExpiry = /^\d{4}-\d{2}-\d{2}$/.test(rawLease) && !rawLease.startsWith('1900') ? rawLease : null;
		const addr = cleanAddr(
			r.property_street_address_or || `${r.property_number || ''} ${r.property_street || ''}`
		);

		if (!byYear.has(yr)) {
			byYear.set(yr, { year: yr, total: 0, vacant: 0, occupied: 0, units: [] });
		}
		const bucket = byYear.get(yr)!;
		bucket.total += 1;
		if (vacant) bucket.vacant += 1;
		else bucket.occupied += 1;
		bucket.units.push({ address: addr || plutoAddr, vacant, activity, construction, leaseExpiry });
	}

	const dofHistory = [...byYear.values()].sort((a, b) => b.year - a.year);

	// Detect Dropped / Disappeared Storefront Units
	let droppedSignal: BuildingDroppedSignal | null = null;
	if (dofHistory.length >= 2) {
		const latest = dofHistory[0];
		const recentPrior = dofHistory.filter((y) => y.year < latest.year && y.year >= latest.year - 2);
		let peak: BuildingDofYear | null = null;
		for (const p of recentPrior) {
			if (!peak || p.total > peak.total) peak = p;
		}
		if (peak && peak.total > latest.total) {
			const latestAddrs = new Set(latest.units.map((u) => u.address.toLowerCase()));
			const missing = [
				...new Set(
					peak.units.map((u) => u.address).filter((a) => a && !latestAddrs.has(a.toLowerCase()))
				)
			];
			droppedSignal = {
				priorYear: peak.year,
				priorCount: peak.total,
				latestYear: latest.year,
				latestCount: latest.total,
				droppedCount: peak.total - latest.total,
				priorAddresses: missing.length ? missing : [...new Set(peak.units.map((u) => u.address))]
			};
		}
	} else if (dofHistory.length === 1 && dofHistory[0].year < 2025) {
		const prior = dofHistory[0];
		droppedSignal = {
			priorYear: prior.year,
			priorCount: prior.total,
			latestYear: 2025,
			latestCount: 0,
			droppedCount: prior.total,
			priorAddresses: [...new Set(prior.units.map((u) => u.address))]
		};
	}

	let consecutiveVacantYears = 0;
	for (const yr of dofHistory) {
		if (yr.vacant > 0) consecutiveVacantYears += 1;
		else break;
	}

	// Merge & deduplicate DOHMH + DCWP tenant records
	const tenantMap = new Map<string, BuildingTenantItem>();
	const addTenant = (item: BuildingTenantItem) => {
		const key = item.name.toLowerCase().replace(/[^a-z0-9]/g, '');
		if (!key) return;
		const existing = tenantMap.get(key);
		if (!existing) {
			tenantMap.set(key, item);
			return;
		}
		const rank = { active: 3, recent: 2, former: 1 };
		if (
			rank[item.status] > rank[existing.status] ||
			(rank[item.status] === rank[existing.status] && (item.lastDate || '') > (existing.lastDate || ''))
		) {
			tenantMap.set(key, {
				...item,
				firstDate: existing.firstDate && item.firstDate
					? existing.firstDate < item.firstDate
						? existing.firstDate
						: item.firstDate
					: item.firstDate || existing.firstDate
			});
		}
	};

	for (const row of dohmhRows) {
		if (!row.dba) continue;
		const name = cleanBusinessName(row.dba);
		const rawFirst = (row.first_dt || '').slice(0, 10);
		const rawLast = (row.last_dt || '').slice(0, 10);
		const firstDate = rawFirst && !rawFirst.startsWith('1900') ? rawFirst : null;
		const lastDate = rawLast && !rawLast.startsWith('1900') ? rawLast : null;
		const lastYear = lastDate ? parseInt(lastDate.slice(0, 4), 10) : 0;
		const status: BuildingTenantItem['status'] =
			lastYear >= 2024 ? 'active' : lastYear > 0 ? 'recent' : 'recent';
		const cat =
			row.cuisine_description && row.cuisine_description !== 'Other'
				? row.cuisine_description
				: 'Food & Drink';
		addTenant({
			name,
			category: cat,
			source: 'DOHMH',
			status,
			firstDate,
			lastDate,
			inspections: parseInt(row.cnt || '0', 10) || 0
		});
	}

	for (const row of dcwpRows) {
		if (!row.business_name) continue;
		const name = cleanBusinessName(row.business_name);
		const st = (row.license_status || '').toLowerCase();
		const status: BuildingTenantItem['status'] = st === 'active' ? 'active' : 'former';
		addTenant({
			name,
			category: (row.business_category || 'Licensed Business').split(' - ')[0],
			source: 'DCWP',
			status,
			firstDate: (row.license_creation_date || '').slice(0, 10) || null,
			lastDate: (row.lic_expir_dd || '').slice(0, 10) || null,
			inspections: 0
		});
	}

	// Open Restaurants Archive (2020-2023): recovers closed restaurants deleted from active DOHMH roster
	for (const row of openRestRows) {
		const rawName = row.doing_business_as_dba || row.restaurant_name || '';
		if (!rawName) continue;
		const name = cleanBusinessName(rawName);
		const subDt = (row.time_of_submission || '').slice(0, 10) || null;
		addTenant({
			name,
			category: 'Restaurant (Outdoor Dining Archive)',
			source: 'OPEN_RESTAURANTS',
			status: 'former',
			firstDate: subDt,
			lastDate: subDt,
			inspections: 0
		});
	}

	// Historical OATH commercial respondents: recovers named former storefront businesses (e.g. Grand Sichuan, Pet Central)
	const STOREFRONT_KW =
		/\b(RESTAURANT|RESTAURANTS|CAFE|COFFEE|ESPRESSO|TEA|BAR|PUB|TAVERN|LOUNGE|GRILL|DELI|DELICATESSEN|PIZZA|PIZZERIA|BAKERY|BAKE|MARKET|SUPERMARKET|GROCERY|BODEGA|PHARMACY|DRUGS|CLEANERS|CLEANER|LAUNDRY|LAUNDROMAT|SALON|BARBER|NAIL|SPA|SHOP|STORE|CLOTHING|APPAREL|VINTAGE|BOUTIQUE|GALLERY|STUDIO|GYM|FITNESS|WINE|LIQUOR|SPIRITS|DINER|BISTRO|KITCHEN|NOODLE|SUSHI|RAMEN|TACO|BAGEL|BURGER|CHICKEN|SEAFOOD|STEAK|SICHUAN|THAI|INDIAN|MEXICAN|ITALIAN|PET|FLOWER|FLORIST|BOOKS|BOOKSTORE|OPTICAL|EYEWEAR|DENTAL|BANK|HARDWARE|TAILOR|JEWELRY|SHOES|RECORDS|MUSIC|TOYS|GIFT|SMOKE|VAPE)\b/i;
	const NON_TENANT_KW =
		/\b(OWNER|EQUITIES|EQUITES|REALTY|RLTY|MGMT|MANAGEMENT|PROPERTIES|PROPERTY|HOLDINGS|HOLDING|CONDO|CONDOMINIUM|CONDIMINIUM|BOARD OF MANAGERS|ESTATES|ASSOCIATES|PARTNERS|PARTNERSHIP|TRUST|DEVELOPMENT|DEVELOPERS|HOUSING|RESIDENCE|TOWER|LOFTS|LOFT|CONSOLIDATED EDISON|CON EDISON|CONED|VERIZON|NATIONAL GRID|SPECTRUM|TIME WARNER|EMPIRE CITY SUBWAY|HAULING|TRANSPORT|TRUCKING|ENGINEERING|CONSTRUCTION|CONTRACTING|CONTRACTORS|PLUMBING|ELECTRIC|ELECTRICAL|MECHANICAL|SCAFFOLD|ELEVATOR|FIRE SYSTEMS|TREAS FOR|COMMITTEE|ACTION CENTER|DEPT OF|CITY OF NEW YORK|MTA|NYCHA|C O |C\/O )\b/i;

	const ownerTokens = (pluto.ownername || '')
		.toUpperCase()
		.replace(/[^A-Z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length >= 4 && !['CORP', 'INC', 'LLC', 'LTD', 'REALTY', 'OWNER', 'UNAVAILABLE'].includes(w));

	const inferOathCategory = (upper: string): string => {
		if (/\b(RESTAURANT|SICHUAN|BISTRO|DINER|KITCHEN|PIZZA|SUSHI|RAMEN|TACO|GRILL|THAI|NOODLE|SEAFOOD|STEAK)\b/.test(upper)) {
			return 'Restaurant';
		}
		if (/\b(CAFE|COFFEE|ESPRESSO|BAKERY|BAGEL|TEA)\b/.test(upper)) return 'Cafe / Bakery';
		if (/\b(BAR|PUB|TAVERN|LOUNGE|WINE|LIQUOR)\b/.test(upper)) return 'Bar / Spirits';
		if (/\b(SUPERMARKET|MARKET|GROCERY|DELI|BODEGA)\b/.test(upper)) return 'Grocery / Market';
		if (/\b(CLEANERS|CLEANER|LAUNDRY|LAUNDROMAT|TAILOR)\b/.test(upper)) return 'Cleaners / Services';
		if (/\b(CLOTHING|APPAREL|VINTAGE|BOUTIQUE|SHOES)\b/.test(upper)) return 'Retail / Apparel';
		if (/\b(SALON|BARBER|NAIL|SPA)\b/.test(upper)) return 'Salon / Personal Care';
		if (/\b(PET)\b/.test(upper)) return 'Pet Store';
		if (/\b(PHARMACY|OPTICAL|DENTAL)\b/.test(upper)) return 'Pharmacy / Health';
		return 'Storefront Business';
	};

	// First collapse OATH spelling variants of the same business (e.g. "GRAND SICHUAN INTL" + "GRAND SICHUAN RESTAURANT")
	const oathBizMap = new Map<
		string,
		{ name: string; category: string; firstDate: string; lastDate: string; cnt: number }
	>();

	for (const row of oathHistRows) {
		const raw = String(row.respondent_last_name || '').trim();
		if (!raw || raw.length < 4) continue;
		const upper = raw.toUpperCase();
		if (NON_TENANT_KW.test(upper)) continue;
		// Skip address-based landlord LLCs like "11 EAST 36TH LLC" or "229 9TH AVE"
		if (plutoHouseNum && new RegExp(`^${plutoHouseNum}\\b`).test(upper)) continue;
		// Skip matches to building owner name
		if (ownerTokens.length > 0 && ownerTokens.some((tok) => upper.includes(tok))) continue;
		// Must have an explicit storefront keyword to guarantee high precision (no random person surnames)
		if (!STOREFRONT_KW.test(upper)) continue;

		const cleaned = cleanBusinessName(raw)
			.replace(/\b(Intl|International)\s+\d+$/i, '')
			.replace(/\b24$/i, '')
			.trim();
		if (!cleaned || cleaned.length < 4) continue;

		// Collapse variants sharing the same first 2 distinctive words (including 1-char clerk typos like "Sichnan"/"Sichuan")
		const words = cleaned
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, '')
			.split(/\s+/)
			.filter((w) => w.length >= 2 && !['the', 'lm', 'ny', 'nyc', 'inc', 'llc'].includes(w));
		let stem = words.slice(0, 2).join(' ') || cleaned.toLowerCase();
		if (!oathBizMap.has(stem) && stem.length >= 7) {
			for (const existingKey of oathBizMap.keys()) {
				if (Math.abs(existingKey.length - stem.length) > 1) continue;
				let i = 0,
					j = 0,
					edits = 0;
				while (i < existingKey.length && j < stem.length && edits <= 2) {
					if (existingKey[i] === stem[j]) {
						i++;
						j++;
					} else {
						edits++;
						if (existingKey.length > stem.length) i++;
						else if (stem.length > existingKey.length) j++;
						else {
							i++;
							j++;
						}
					}
				}
				edits += existingKey.length - i + (stem.length - j);
				if (edits <= 2) {
					stem = existingKey;
					break;
				}
			}
		}
		const firstDt = (row.first_dt || '').slice(0, 10);
		const lastDt = (row.last_dt || '').slice(0, 10);
		const cnt = parseInt(row.cnt || '1', 10) || 1;
		const cat = inferOathCategory(upper);

		const prev = oathBizMap.get(stem);
		if (!prev) {
			oathBizMap.set(stem, { name: cleaned, category: cat, firstDate: firstDt, lastDate: lastDt, cnt });
		} else {
			prev.cnt += cnt;
			if (firstDt && (!prev.firstDate || firstDt < prev.firstDate)) prev.firstDate = firstDt;
			if (lastDt && (!prev.lastDate || lastDt > prev.lastDate)) prev.lastDate = lastDt;
			// Prefer the cleaner/more descriptive name (e.g. "Grand Sichuan Restaurant" over "Grand Sichuan Intl")
			if (cnt > 1 && cleaned.length >= prev.name.length && !/internatinal/i.test(cleaned)) {
				prev.name = cleaned;
			}
		}
	}

	for (const biz of oathBizMap.values()) {
		const lastYr = parseInt((biz.lastDate || '').slice(0, 4), 10) || 0;
		addTenant({
			name: biz.name,
			category: biz.category,
			source: 'OATH',
			status: lastYr >= 2025 ? 'recent' : 'former',
			firstDate: biz.firstDate || null,
			lastDate: biz.lastDate || null,
			inspections: 0
		});
	}

	const rank = { active: 3, recent: 2, former: 1 };
	const tenants = [...tenantMap.values()].sort(
		(a, b) => rank[b.status] - rank[a.status] || (b.lastDate || '').localeCompare(a.lastDate || '')
	);

	const oathCases: BuildingOathItem[] = oathRows.slice(0, 16).map((r) => ({
		date: (r.violation_date || '').slice(0, 10),
		agency: titleCase(r.issuing_agency || 'NYC Agency'),
		respondent: r.respondent_last_name || '',
		address: cleanAddr(`${r.violation_location_house || ''} ${r.violation_location_street_name || ''}`),
		description: r.charge_1_code_description || r.violation_details || 'Enforcement notice',
		status: titleCase(r.hearing_status || ''),
		amount: Number.isFinite(parseFloat(r.total_violation_amount || ''))
			? Math.round(parseFloat(r.total_violation_amount))
			: null
	}));

	const complaints311: Building311Item[] = c311Rows.slice(0, 16).map((r) => ({
		date: (r.created_date || '').slice(0, 10),
		address: cleanAddr(r.incident_address || ''),
		type: r.complaint_type || '311 Report',
		descriptor: r.descriptor || '',
		status: r.status || ''
	}));

	const permitsNow: BuildingPermitItem[] = dobNowRows.map((r) => ({
		date: (r.issued_date || '').slice(0, 10),
		jobType: r.job_type || 'DOB NOW',
		workType: r.work_type || '',
		status: titleCase(r.permit_status || 'Issued'),
		description: r.job_description || r.work_type || 'Building work permit',
		owner: r.owner_business_name || ''
	}));

	const permitsLegacy: BuildingPermitItem[] = dobLegacyRows.map((r) => ({
		date: (r.issuance_date || '').slice(0, 10),
		jobType: r.job_type || 'Permit',
		workType: [r.work_type, r.permit_subtype].filter(Boolean).join(' · '),
		status: titleCase(r.permit_status || 'Issued'),
		description: [r.job_type, r.work_type, r.permit_subtype].filter(Boolean).join(' — '),
		owner: r.owner_s_business_name || ''
	}));

	const permits = [...permitsNow, ...permitsLegacy]
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, 16);

	const parseNum = (v: string | undefined): number | null => {
		const n = parseFloat(v || '');
		return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
	};

	const lat = Number.isFinite(parseFloat(pluto.latitude || '')) ? parseFloat(pluto.latitude) : null;
	const lng = Number.isFinite(parseFloat(pluto.longitude || '')) ? parseFloat(pluto.longitude) : null;
	const finalAddress = plutoAddr || dofHistory[0]?.units[0]?.address || `BBL ${rawBbl}`;

	// Optional fast Google Street View metadata check (~120ms) when key is configured
	let streetViewAvailable = false;
	let streetViewDate: string | null = null;
	if (apiKey && (finalAddress || (lat && lng))) {
		const loc = plutoAddr ? `${plutoAddr}, ${boroDisplay}, NY` : `${lat},${lng}`;
		const metaUrl =
			'https://maps.googleapis.com/maps/api/streetview/metadata?' +
			new URLSearchParams({ location: loc, source: 'outdoor', key: apiKey }).toString();
		const svMeta = await fetchObjectSafe<{ status?: string; date?: string }>(metaUrl, 3500);
		if (svMeta?.status === 'OK') {
			streetViewAvailable = true;
			streetViewDate = svMeta.date || null;
		}
	}

	const isCondo = isCondoBilling || /^R/i.test(pluto.bldgclass || '');
	const rawOwner = (pluto.ownername || '').trim();
	const ownerIsUnavailable = !rawOwner || /^UNAVAILABLE\s+OWNER$/i.test(rawOwner);
	const cleanOwner = ownerIsUnavailable
		? isCondo
			? 'Condo association (individually owned units)'
			: 'Not listed in city records'
		: titleCase(rawOwner);

	const dossier: BuildingDossier = {
		bbl: rawBbl,
		borough: boroDisplay,
		block: String(blockNum),
		lot: String(lotNum),
		address: finalAddress,
		ownerName: cleanOwner,
		isCondo,
		zipcode: pluto.zipcode || '',
		zoning: pluto.zonedist1 || '',
		bldgClass: pluto.bldgclass || '',
		landUseLabel: LANDUSE_LABELS[pluto.landuse || ''] || 'Building',
		yearBuilt: parseNum(pluto.yearbuilt),
		floors: parseNum(pluto.numfloors),
		lotFrontFt: parseNum(pluto.lotfront),
		lotDepthFt: parseNum(pluto.lotdepth),
		bldgAreaSqft: parseNum(pluto.bldgarea),
		retailAreaSqft: parseNum(pluto.retailarea),
		resAreaSqft: parseNum(pluto.resarea),
		unitsRes: parseInt(pluto.unitsres || '0', 10) || 0,
		unitsTotal: parseInt(pluto.unitstotal || '0', 10) || 0,
		assessedTotal: parseNum(pluto.assesstot),
		assessedLand: parseNum(pluto.assessland),
		councilDistrict: pluto.council || '',
		lat,
		lng,
		parcelGeometry: parcelGeo?.features?.[0]?.geometry ?? null,
		streetViewAvailable,
		streetViewDate,
		tenants,
		dofHistory,
		droppedSignal,
		consecutiveVacantYears,
		oathCases,
		complaints311,
		permits
	};

	if (plutoRows.length > 0 || dofRows.length > 0) {
		dossierCache.set(cacheKey, { at: Date.now(), data: dossier });
	}

	return json(dossier, {
		headers: {
			'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=43200'
		}
	});
};
