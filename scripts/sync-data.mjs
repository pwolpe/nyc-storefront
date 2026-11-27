#!/usr/bin/env node
/**
 * Gates Down NYC — Official Data Sync & Tie-Out Pipeline
 *
 * Syncs live data directly from:
 *  1. NYC Comptroller ArcGIS FeatureServers (Live XYZ quarterly NTA polygons + SB net change)
 *  2. NYC Comptroller Public Google Sheet (citywide/borough history + 99 retail subcategories)
 *  3. NYC Open Data DOF Storefronts Reported Vacant or Not (92iy-9c3n)
 *
 * Usage:
 *   node scripts/sync-data.mjs              # Live fetch from NYC APIs
 *   node scripts/sync-data.mjs --from-tmp   # Build from cached /tmp downloads
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { dedupeDofRows } from '../src/lib/dofDedupe.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'static', 'data');
const FROM_TMP = process.argv.includes('--from-tmp');

const URLS = {
	ntaGeoJson:
		'https://services2.arcgis.com/ZpsvDOsGv97WuKRh/arcgis/rest/services/nta_quarterly_gdf/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.0002&f=geojson',
	sbNetChange:
		'https://services2.arcgis.com/ZpsvDOsGv97WuKRh/arcgis/rest/services/sb_net_change_rate_nta_gdf/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json',
	sheetXlsx:
		'https://docs.google.com/spreadsheets/d/1hul6428-S1Azg5hmCc-xFyZSIqsyQZ-CT1tobN8qDbI/export?format=xlsx',
	dofCorridors:
		"https://data.cityofnewyork.us/resource/92iy-9c3n.json?$where=zip_code+in('10011','10014','10001','10012','10013','10003','11211')+AND+reporting_year+in('2025','2024','2023','2022+and+2023','2021+and+2022','2020+and+2021','2019+and+2020')&$limit=50000"
};

fs.mkdirSync(OUT_DIR, { recursive: true });

async function getJson(url, tmpPath) {
	if (FROM_TMP && fs.existsSync(tmpPath)) {
		return JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
	}
	console.log('Fetching', url.slice(0, 90) + '...');
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const data = await res.json();
	fs.writeFileSync(tmpPath, JSON.stringify(data));
	return data;
}

async function getBuffer(url, tmpPath) {
	if (FROM_TMP && fs.existsSync(tmpPath)) {
		return tmpPath;
	}
	console.log('Downloading', url.slice(0, 90) + '...');
	const res = await fetch(url);
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(tmpPath, buf);
	return tmpPath;
}

/**
 * Parse the Comptroller's XLSX workbook via python3 stdlib (zero npm deps).
 */
function parseXlsx(xlsxPath) {
	const py = `
import json, zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile(${JSON.stringify(xlsxPath)}) as z:
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    sheets = [s.attrib.get("name") for s in wb.findall(".//m:sheet", ns)]
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        ss = ["".join(t.text or "" for t in si.findall(".//m:t", ns)) for si in sst.findall(".//m:si", ns)]
    out = {}
    for i, name in enumerate(sheets, 1):
        sf = f"xl/worksheets/sheet{i}.xml"
        if sf not in z.namelist(): continue
        root = ET.fromstring(z.read(sf))
        rows = []
        for r in root.findall(".//m:row", ns):
            # Preserve column letters so empty cells stay aligned
            row_map = {}
            max_idx = 0
            for c in r.findall("m:c", ns):
                ref = c.attrib.get("r", "")
                col_letters = "".join(ch for ch in ref if ch.isalpha())
                idx = 0
                for ch in col_letters:
                    idx = idx * 26 + (ord(ch.upper()) - ord('A') + 1)
                idx -= 1
                max_idx = max(max_idx, idx)
                t = c.attrib.get("t")
                v = c.find("m:v", ns)
                if v is None:
                    val = ""
                elif t == "s":
                    val = ss[int(v.text)]
                else:
                    val = v.text
                row_map[idx] = val
            rows.append([row_map.get(k, "") for k in range(max_idx + 1)])
        out[name] = rows
    print(json.dumps(out))
`;
	return JSON.parse(execSync(`python3 -c '${py.replace(/'/g, "'\\''")}'`, { maxBuffer: 20 * 1024 * 1024 }).toString());
}

function num(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function round(v, d = 4) {
	if (v === null || v === undefined) return null;
	const m = 10 ** d;
	return Math.round(v * m) / m;
}

function normYear(raw) {
	if (!raw) return null;
	const s = String(raw).trim();
	if (s === '2019 and 2020') return 2019;
	if (s === '2020 and 2021') return 2020;
	if (s === '2021 and 2022') return 2021;
	if (s === '2022 and 2023') return 2022;
	const m = s.match(/^(\d{4})$/);
	return m ? Number(m[1]) : null;
}

function isVacant(r) {
	const v = String(r.vacant_on_12_31 || '').trim().toUpperCase();
	return v === 'YES' || v === 'Y';
}

function parseHouseNum(r) {
	const raw = String(r.property_number || r.property_street_address_or || '').trim();
	const m = raw.match(/^(\d+)/);
	return m ? Number(m[1]) : null;
}

function cleanAddr(r) {
	const a = String(r.property_street_address_or || `${r.property_number || ''} ${r.property_street || ''}`).trim();
	return a.replace(/\s+/g, ' ').toUpperCase();
}

function titleCase(str) {
	return String(str || '')
		.toLowerCase()
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.replace(/\bNyc\b/g, 'NYC')
		.replace(/\bLlc\b/g, 'LLC')
		.replace(/\bTh\b/g, 'th')
		.replace(/\bSt\b/g, 'St')
		.replace(/\bAve\b/g, 'Ave')
		.replace(/(\d+)(Th|St|Nd|Rd)\b/gi, (_, n, suf) => `${n}${suf.toLowerCase()}`);
}

const CORRIDOR_DEFS = [
	{
		id: '8th-ave-chelsea',
		name: '8th Avenue — Chelsea',
		subtitle: 'Walking north from W 14th St to W 23rd St (10011)',
		borough: 'Manhattan',
		ntaCode: 'MN0401',
		zipCodes: ['10011'],
		councilDistrict: '3',
		councilMember: 'Erik Bottcher',
		blurb:
			'Walk north up 8th Ave past 15th St and the empty gates jump out at you—yet landlords only reported 3.8% vacant here in 2025 DOF filings, while the Comptroller’s on-foot survey puts Chelsea–Hudson Yards at 14.9%.',
		match: (r) => {
			const st = String(r.property_street || r.property_street_address_or || '').toUpperCase();
			const n = parseHouseNum(r);
			return (
				r.zip_code === '10011' &&
				(/\b8\s*AVE|\b8TH\s*AVE|\bEIGHTH\b/.test(st)) &&
				n !== null &&
				n >= 75 &&
				n <= 280
			);
		},
		sortDir: 'asc', // south to north (house numbers go up going north on 8th Ave)
		centerline: [
			[-74.0021, 40.7399],
			[-73.9978, 40.7453]
		]
	},
	{
		id: 'w-14th-st',
		name: 'West 14th Street',
		subtitle: '5th Avenue to 10th Avenue (10011)',
		borough: 'Manhattan',
		ntaCode: 'MN0401',
		zipCodes: ['10011'],
		councilDistrict: '3',
		councilMember: 'Erik Bottcher',
		blurb:
			'One of the starkest official vacancy corridors on the West Side: 19.3% of registered storefronts on West 14th St (10011) were reported vacant in 2025, with persistent gaps around 7th and 8th Avenues.',
		match: (r) => {
			const st = String(r.property_street || r.property_street_address_or || '').toUpperCase();
			const n = parseHouseNum(r);
			return r.zip_code === '10011' && /WEST\s+14|W\s+14/.test(st) && n !== null && n >= 1 && n <= 520;
		},
		sortDir: 'asc', // east to west
		centerline: [
			[-73.9937, 40.7361],
			[-74.0079, 40.7422]
		]
	},
	{
		id: 'w-15th-st-200',
		name: '200 Block of W 15th Street',
		subtitle: 'Home block of 214 W 15th St (7th Ave → 8th Ave, 10011)',
		borough: 'Manhattan',
		ntaCode: 'MN0401',
		zipCodes: ['10011'],
		councilDistrict: '3',
		councilMember: 'Erik Bottcher',
		blurb:
			'Home block of 214 W 15th St—sitting right between West 14th Street and the 8th Avenue strip, where a former illegal weed shop sits shuttered.',
		match: (r) => {
			const st = String(r.property_street || r.property_street_address_or || '').toUpperCase();
			const n = parseHouseNum(r);
			return r.zip_code === '10011' && /WEST\s+15|W\s+15/.test(st) && n !== null && n >= 200 && n <= 299;
		},
		sortDir: 'asc',
		centerline: [
			[-73.999, 40.7394],
			[-74.0017, 40.7405]
		]
	},
	{
		id: 'bleecker-st',
		name: 'Bleecker Street',
		subtitle: 'Greenwich Village & West Village (10014)',
		borough: 'Manhattan',
		ntaCode: 'MN0203',
		zipCodes: ['10014'],
		councilDistrict: '3',
		councilMember: 'Erik Bottcher',
		blurb:
			'The textbook NYC retail turnaround story: West Village vacancy improved -0.62 pts in Q3 2026 to 12.1%, even as iconic Bleecker storefronts cycle through high rents.',
		match: (r) => {
			const st = String(r.property_street || r.property_street_address_or || '').toUpperCase();
			const n = parseHouseNum(r);
			return r.zip_code === '10014' && /BLEECKER/.test(st) && n !== null && n >= 200 && n <= 430;
		},
		sortDir: 'asc',
		centerline: [
			[-74.0011, 40.7297],
			[-74.0056, 40.7358]
		]
	},
	{
		id: 'broadway-soho',
		name: 'Broadway — SoHo',
		subtitle: 'Canal Street to Houston Street (10012 / 10013)',
		borough: 'Manhattan',
		ntaCode: 'MN0201',
		zipCodes: ['10012', '10013'],
		councilDistrict: '1',
		councilMember: 'Christopher Marte',
		blurb:
			'High-rent flagship territory where massive floorplates swing sharply between luxury pop-ups and multi-year vacancies.',
		match: (r) => {
			const st = String(r.property_street || r.property_street_address_or || '').toUpperCase();
			const n = parseHouseNum(r);
			return (
				(r.zip_code === '10012' || r.zip_code === '10013') &&
				/\bBROADWAY\b/.test(st) &&
				!/WEST\s+BROADWAY/.test(st) &&
				n !== null &&
				n >= 420 &&
				n <= 610
			);
		},
		sortDir: 'asc',
		centerline: [
			[-74.0016, 40.7192],
			[-73.9972, 40.7254]
		]
	},
	{
		id: 'bedford-ave',
		name: 'Bedford Avenue',
		subtitle: 'North Williamsburg (11211)',
		borough: 'Brooklyn',
		ntaCode: 'BK0102',
		zipCodes: ['11211'],
		councilDistrict: '33',
		councilMember: 'Lincoln Restler',
		blurb:
			'Brooklyn’s barometer corridor—tracking how North Williamsburg balances indie small businesses against national retail chains.',
		match: (r) => {
			const st = String(r.property_street || r.property_street_address_or || '').toUpperCase();
			const n = parseHouseNum(r);
			return r.zip_code === '11211' && /\bBEDFORD\b/.test(st) && n !== null && n >= 100 && n <= 320;
		},
		sortDir: 'asc',
		centerline: [
			[-73.9613, 40.7138],
			[-73.9547, 40.7204]
		]
	}
];

async function main() {
	const [ntaGeo, sbNet, xlsxPath, dofRows] = await Promise.all([
		getJson(URLS.ntaGeoJson, '/tmp/nta_quarterly.geojson'),
		getJson(URLS.sbNetChange, '/tmp/sb_net_change.json'),
		getBuffer(URLS.sheetXlsx, '/tmp/comptroller_data.xlsx'),
		getJson(URLS.dofCorridors, '/tmp/dof_corridors.json')
	]);

	// 1. Join SB net change onto NTA GeoJSON and slim down properties
	const sbByNta = new Map();
	for (const f of sbNet.features || []) {
		const a = f.attributes || {};
		sbByNta.set(a.nta2020, {
			sb_net_change_per_1k: round(num(a.net_change_share_per_thousand_sb), 2),
			sb_net_change_qoq: round(num(a.quarterly_change), 2)
		});
	}

	const ntaStatsByCode = new Map();
	const slimFeatures = [];
	for (const feat of ntaGeo.features || []) {
		const p = feat.properties || {};
		const sb = sbByNta.get(p.nta2020) || {};
		const props = {
			nta2020: p.nta2020,
			ntaname: p.ntaname,
			boroname: p.boroname,
			cdtaname: p.cdtaname,
			quarter: p.quarter,
			vacancy_rate: round(num(p.vacancy_rate), 4),
			total_storefronts: num(p.total_storefronts) ?? 0,
			vacant_storefronts: num(p.vacant_storefronts) ?? 0,
			smallbiz_vacancy_rate: round(num(p.smallbiz_vacancy_rate), 4),
			smallbiz_storefronts: num(p.smallbiz_storefronts) ?? 0,
			smallbiz_vacant_storefronts: num(p.smallbiz_vacant_storefronts) ?? 0,
			smallbiz_concentration: round(num(p.smallbiz_concentration), 4),
			prior_vacancy_rate: round(num(p.prior_vacancy_rate), 4),
			vacancy_rate_change: round(num(p.vacancy_rate_change), 4),
			smallbiz_vacancy_rate_change: round(num(p.smallbiz_vacancy_rate_change), 4),
			sb_net_change_per_1k: sb.sb_net_change_per_1k ?? null,
			valid_overall: p.valid_overall === 1
		};
		// Compute centroid for instant flyTo
		let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
		const walk = (coords) => {
			if (typeof coords[0] === 'number') {
				minLng = Math.min(minLng, coords[0]);
				maxLng = Math.max(maxLng, coords[0]);
				minLat = Math.min(minLat, coords[1]);
				maxLat = Math.max(maxLat, coords[1]);
			} else {
				for (const c of coords) walk(c);
			}
		};
		if (feat.geometry?.coordinates) walk(feat.geometry.coordinates);
		props.center = [round((minLng + maxLng) / 2, 4), round((minLat + maxLat) / 2, 4)];

		ntaStatsByCode.set(props.nta2020, props);
		slimFeatures.push({
			type: 'Feature',
			id: props.nta2020,
			properties: props,
			geometry: feat.geometry
		});
	}

	const ntaGeoOut = {
		type: 'FeatureCollection',
		features: slimFeatures
	};
	fs.writeFileSync(path.join(OUT_DIR, 'nyc-ntas.geojson'), JSON.stringify(ntaGeoOut));

	// 2. Parse Comptroller Google Sheet
	const wb = parseXlsx(xlsxPath);
	const genRows = (wb.General_rates || []).slice(1).filter((r) => r[0] && /^\d{4}\s+Q\d/.test(r[0]));
	const vacRows = (wb.VacancyRate || []).slice(1).filter((r) => r[0] && /^\d{4}\s+Q\d/.test(r[0]));
	const netRows = (wb.StorefrontNetChange || []).slice(1).filter((r) => r[0] && /^\d{4}\s+Q\d/.test(r[0]));
	const subRows = (wb.SubCategory || []).slice(1).filter((r) => r[0] && num(r[3]) !== null);

	const vacByQ = new Map(vacRows.map((r) => [r[0].trim(), r]));
	const netByQ = new Map(netRows.map((r) => [r[0].trim(), r]));

	const quarters = genRows.map((r) => {
		const q = r[0].trim();
		const vr = vacByQ.get(q) || [];
		const nr = netByQ.get(q) || [];
		const total = Math.round(num(r[5]) ?? 0);
		const vacant = Math.round(num(r[6]) ?? 0);
		// Tie-out check: computed rate vs reported rate
		const reportedRate = num(r[1]);
		const computedRate = total > 0 ? vacant / total : 0;
		if (reportedRate !== null && Math.abs(reportedRate - computedRate) > 0.002) {
			throw new Error(`Tie-out mismatch in ${q}: reported=${reportedRate} vs computed=${computedRate}`);
		}
		return {
			quarter: q,
			vacancyRate: round(reportedRate ?? computedRate, 5),
			totalStorefronts: total,
			vacantStorefronts: vacant,
			smallBizStorefronts: Math.round(num(r[7]) ?? 0),
			smallBizVacant: Math.round(num(r[8]) ?? 0),
			rateChange: round(num(r[9]), 5),
			openings: num(nr[1]) !== null ? Math.round(num(nr[1])) : null,
			closings: num(nr[2]) !== null ? Math.round(num(nr[2])) : null,
			netChange: num(nr[3]) !== null ? Math.round(num(nr[3])) : num(r[3]) !== null ? Math.round(num(r[3])) : null,
			smallBizOpenings: num(nr[4]) !== null ? Math.round(num(nr[4])) : null,
			smallBizClosings: num(nr[5]) !== null ? Math.round(num(nr[5])) : null,
			smallBizNetChange: num(nr[6]) !== null ? Math.round(num(nr[6])) : num(r[4]) !== null ? Math.round(num(r[4])) : null,
			boroughs: {
				Bronx: round(num(vr[1]), 5),
				Brooklyn: round(num(vr[3]), 5),
				Manhattan: round(num(vr[5]), 5),
				Queens: round(num(vr[7]), 5),
				'Staten Island': round(num(vr[9]), 5)
			}
		};
	});

	const latest = quarters[quarters.length - 1];

	const subcategories = subRows
		.map((r) => ({
			name: r[0].trim(),
			vacancyRate: round(num(r[1]), 4),
			smallBizVacancyRate: round(num(r[2]), 4),
			total: Math.round(num(r[3]) ?? 0),
			vacant: Math.round(num(r[4]) ?? 0),
			share: round(num(r[5]), 4),
			smallBizTotal: Math.round(num(r[6]) ?? 0),
			smallBizVacant: Math.round(num(r[7]) ?? 0)
		}))
		.sort((a, b) => (b.vacancyRate ?? 0) - (a.vacancyRate ?? 0));

	const validNtas = [...ntaStatsByCode.values()].filter((n) => n.valid_overall && n.total_storefronts >= 100);
	const highestVacancyNtas = [...validNtas].sort((a, b) => (b.vacancy_rate ?? 0) - (a.vacancy_rate ?? 0)).slice(0, 12);
	const lowestVacancyNtas = [...validNtas].sort((a, b) => (a.vacancy_rate ?? 0) - (b.vacancy_rate ?? 0)).slice(0, 12);
	const biggestWorseningNtas = [...validNtas]
		.filter((n) => n.vacancy_rate_change !== null)
		.sort((a, b) => (b.vacancy_rate_change ?? 0) - (a.vacancy_rate_change ?? 0))
		.slice(0, 10);
	const biggestImprovingNtas = [...validNtas]
		.filter((n) => n.vacancy_rate_change !== null)
		.sort((a, b) => (a.vacancy_rate_change ?? 0) - (b.vacancy_rate_change ?? 0))
		.slice(0, 10);

	const summaryOut = {
		syncedAt: new Date().toISOString(),
		sourceUpdated: '2026-11-24',
		latestQuarter: latest.quarter,
		headline: latest,
		quarters,
		subcategories,
		rankings: {
			highestVacancyNtas,
			lowestVacancyNtas,
			biggestWorseningNtas,
			biggestImprovingNtas
		}
	};
	fs.writeFileSync(path.join(OUT_DIR, 'comptroller-summary.json'), JSON.stringify(summaryOut));

	// 3. Build Corridors ("Walk the Strip") from deduplicated DOF rows
	const cleanDofRows = dedupeDofRows(dofRows);
	const corridors = CORRIDOR_DEFS.map((def) => {
		const matched = cleanDofRows.filter(def.match);
		// Group into distinct storefront slots by (bbl + normalized address + unit index per year)
		const byYear = new Map();
		for (const r of matched) {
			const yr = normYear(r.reporting_year);
			if (!yr) continue;
			if (!byYear.has(yr)) byYear.set(yr, []);
			byYear.get(yr).push(r);
		}

		// Group into building/address storefronts across years
		const byAddr = new Map();
		for (const r of matched) {
			const yr = normYear(r.reporting_year);
			if (!yr) continue;
			const house = parseHouseNum(r);
			const key = `${r.bbl || cleanAddr(r)}::${house}`;
			if (!byAddr.has(key)) {
				byAddr.set(key, {
					id: `${def.id}-${house}-${r.bbl || 'x'}`,
					houseNumber: house,
					address: titleCase(cleanAddr(r)),
					bbl: r.bbl || r.borough_block_lot || null,
					zip: r.zip_code,
					lat: num(r.latitude),
					lng: num(r.longitude),
					byYear: {}
				});
			}
			const slot = byAddr.get(key);
			if (!slot.lat && num(r.latitude)) slot.lat = num(r.latitude);
			if (!slot.lng && num(r.longitude)) slot.lng = num(r.longitude);
			if (!slot.byYear[yr]) {
				slot.byYear[yr] = { total: 0, vacant: 0, activities: [] };
			}
			slot.byYear[yr].total += 1;
			if (isVacant(r)) slot.byYear[yr].vacant += 1;
			const act = String(r.primary_business_activity || '').trim();
			if (act && act !== 'NO BUSINESS ACTIVITY IDENTIFIED' && !slot.byYear[yr].activities.includes(act)) {
				slot.byYear[yr].activities.push(act);
			}
		}

		const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
		const yearlyStats = years.map((yr) => {
			const rows = byYear.get(yr) || [];
			const vac = rows.filter(isVacant).length;
			return {
				year: yr,
				total: rows.length,
				vacant: vac,
				rate: rows.length > 0 ? round(vac / rows.length, 4) : 0
			};
		});

		const storefronts = [...byAddr.values()]
			.sort((a, b) => (def.sortDir === 'desc' ? b.houseNumber - a.houseNumber : a.houseNumber - b.houseNumber))
			.map((s) => {
				// Compute consecutive vacant years ending at latest year present
				let streak = 0;
				for (const yr of [...years].reverse()) {
					if (!s.byYear[yr]) continue;
					if (s.byYear[yr].vacant > 0) streak += 1;
					else break;
				}
				const latestPresentYr = [...years].reverse().find((yr) => s.byYear[yr]);
				const latestData = latestPresentYr ? s.byYear[latestPresentYr] : null;
				const droppedOff = !s.byYear[2025] && Boolean(s.byYear[2022] || s.byYear[2023] || s.byYear[2024]);
				const history = {};
				for (const yr of years) {
					if (s.byYear[yr]) {
						history[yr] = {
							vacant: s.byYear[yr].vacant > 0,
							vacantCount: s.byYear[yr].vacant,
							unitCount: s.byYear[yr].total,
							activity: titleCase(s.byYear[yr].activities[0] || (s.byYear[yr].vacant > 0 ? 'Vacant' : 'Commercial'))
						};
					}
				}
				return {
					id: s.id,
					houseNumber: s.houseNumber,
					address: s.address,
					side: s.houseNumber % 2 === 0 ? 'even' : 'odd',
					bbl: s.bbl,
					zip: s.zip,
					lat: round(s.lat, 5),
					lng: round(s.lng, 5),
					latestYear: latestPresentYr,
					latestVacant: latestData ? latestData.vacant > 0 : false,
					latestUnits: latestData ? latestData.total : 0,
					latestVacantUnits: latestData ? latestData.vacant : 0,
					activity: titleCase(latestData?.activities[0] || (latestData?.vacant > 0 ? 'Vacant' : 'Retail / Commercial')),
					vacantStreak: streak,
					droppedOff,
					history
				};
			});

		const nta = ntaStatsByCode.get(def.ntaCode);
		const dof2025 = yearlyStats.find((y) => y.year === 2025);
		const coords = def.centerline || storefronts.filter((s) => s.lat && s.lng).map((s) => [s.lng, s.lat]);

		return {
			id: def.id,
			name: def.name,
			subtitle: def.subtitle,
			borough: def.borough,
			ntaCode: def.ntaCode,
			ntaName: nta?.ntaname || def.ntaCode,
			ntaVacancyRate: nta?.vacancy_rate ?? null,
			ntaVacancyChange: nta?.vacancy_rate_change ?? null,
			councilDistrict: def.councilDistrict,
			councilMember: def.councilMember,
			blurb: def.blurb,
			dof2025Rate: dof2025?.rate ?? 0,
			dof2025Vacant: dof2025?.vacant ?? 0,
			dof2025Total: dof2025?.total ?? 0,
			realityGap: nta?.vacancy_rate != null ? round(nta.vacancy_rate - (dof2025?.rate ?? 0), 4) : null,
			yearlyStats,
			lineCoords: coords,
			storefronts
		};
	});

	fs.writeFileSync(path.join(OUT_DIR, 'corridors.json'), JSON.stringify({ syncedAt: new Date().toISOString(), corridors }));

	// Print crisp tie-out summary
	console.log('\n=== GATES DOWN NYC — DATA TIE-OUT COMPLETE ===');
	console.log(`Latest Quarter: ${latest.quarter}`);
	console.log(`Citywide: ${latest.vacantStorefronts.toLocaleString()} / ${latest.totalStorefronts.toLocaleString()} = ${(latest.vacancyRate * 100).toFixed(2)}%`);
	console.log(`NTAs exported: ${slimFeatures.length}`);
	console.log(`Subcategories exported: ${subcategories.length} (#1: ${subcategories[0].name} @ ${(subcategories[0].vacancyRate * 100).toFixed(1)}%)`);
	for (const c of corridors) {
		console.log(
			`  Corridor [${c.id}]: ${c.storefronts.length} buildings | DOF 2025: ${c.dof2025Vacant}/${c.dof2025Total} (${(c.dof2025Rate * 100).toFixed(1)}%) | Comptroller NTA (${c.ntaName}): ${(c.ntaVacancyRate * 100).toFixed(1)}%`
		);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
