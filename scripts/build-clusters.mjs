#!/usr/bin/env node
/**
 * Gates Down NYC — 3-Level Straightened-Grid & Street-Block Hierarchy Builder
 *
 * Level 1: Whole City Compact Clusters (static/data/nyc-clusters.json)
 *          Street-aligned compact clusters covering 100% of commercial NYC
 * Level 2: Straightened SVG Street Blueprint Shards (static/data/clusters/<id>.json)
 *          Auto-computed straightening angle (e.g. +29° CCW for Manhattan grid),
 *          complete street network (commercial ribbons + quiet residential context streets),
 *          and every clickable 1-block street stretch with exact cross-street labels
 * Level 3: Per-Block Storefronts + Prev/Next Block Navigation (joined live with PLUTO)
 */

import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import { cleanDofActivity, dedupeDofRows, parseDofVacant } from '../src/lib/dofDedupe.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'static', 'data');
const SHARD_DIR = path.join(OUT_DIR, 'clusters');
const FROM_TMP = process.argv.includes('--from-tmp');

const ORIGIN_LAT = 40.7128;
const ORIGIN_LNG = -74.006;
const M_PER_LAT = 111132.9;
const M_PER_LNG = 111319.5 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

function toXY(lng, lat) {
	return [(lng - ORIGIN_LNG) * M_PER_LNG, (lat - ORIGIN_LAT) * M_PER_LAT];
}

function roundCoord(c) {
	return [Math.round(c[0] * 100000) / 100000, Math.round(c[1] * 100000) / 100000];
}

function pointInRing(lng, lat, ring) {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0],
			yi = ring[i][1];
		const xj = ring[j][0],
			yj = ring[j][1];
		const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function pointInPolygon(lng, lat, polyCoords) {
	if (!pointInRing(lng, lat, polyCoords[0])) return false;
	for (let i = 1; i < polyCoords.length; i++) {
		if (pointInRing(lng, lat, polyCoords[i])) return false;
	}
	return true;
}

function pointInGeometry(lng, lat, geom) {
	if (geom.type === 'Polygon') return pointInPolygon(lng, lat, geom.coordinates);
	if (geom.type === 'MultiPolygon') {
		for (const poly of geom.coordinates) {
			if (pointInPolygon(lng, lat, poly)) return true;
		}
	}
	return false;
}

function geomToMultiPoly(geom) {
	if (!geom) return [];
	if (geom.type === 'Polygon') return [geom.coordinates];
	if (geom.type === 'MultiPolygon') return geom.coordinates;
	return [];
}

function bboxOfMultiPoly(mp) {
	let minLng = 180,
		maxLng = -180,
		minLat = 90,
		maxLat = -90;
	for (const poly of mp) {
		for (const pt of poly[0]) {
			if (pt[0] < minLng) minLng = pt[0];
			if (pt[0] > maxLng) maxLng = pt[0];
			if (pt[1] < minLat) minLat = pt[1];
			if (pt[1] > maxLat) maxLat = pt[1];
		}
	}
	return [minLng, minLat, maxLng, maxLat];
}

function ringMetricsM(ring) {
	let area = 0;
	let perim = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		const [x1, y1] = toXY(ring[i][0], ring[i][1]);
		const [x2, y2] = toXY(ring[i + 1][0], ring[i + 1][1]);
		area += x1 * y2 - x2 * y1;
		perim += Math.hypot(x2 - x1, y2 - y1);
	}
	return { area: Math.abs(area) / 2, perim };
}

function multiPolyMetrics(mp) {
	let totalArea = 0;
	let totalPerim = 0;
	for (const poly of mp) {
		const outer = ringMetricsM(poly[0]);
		totalArea += outer.area;
		totalPerim += outer.perim;
		for (let i = 1; i < poly.length; i++) {
			totalArea = Math.max(0, totalArea - ringMetricsM(poly[i]).area);
		}
	}
	const compactness = totalPerim > 0 ? Math.min(1, (4 * Math.PI * totalArea) / (totalPerim * totalPerim)) : 0;
	return { areaM2: totalArea, perimeterM: totalPerim, compactness };
}

function simplifyRing(ring, tolDeg = 0.00006) {
	if (ring.length <= 5) return ring.map(roundCoord);
	function sqSegDist(p, a, b) {
		let x = a[0],
			y = a[1];
		let dx = b[0] - x,
			dy = b[1] - y;
		if (dx !== 0 || dy !== 0) {
			const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
			if (t > 1) {
				x = b[0];
				y = b[1];
			} else if (t > 0) {
				x += dx * t;
				y += dy * t;
			}
		}
		return (p[0] - x) ** 2 + (p[1] - y) ** 2;
	}
	const sqTol = tolDeg * tolDeg;
	const keep = new Uint8Array(ring.length);
	keep[0] = 1;
	keep[ring.length - 1] = 1;
	const stack = [[0, ring.length - 1]];
	while (stack.length) {
		const [first, last] = stack.pop();
		let maxSq = 0,
			idx = -1;
		for (let i = first + 1; i < last; i++) {
			const d = sqSegDist(ring[i], ring[first], ring[last]);
			if (d > maxSq) {
				maxSq = d;
				idx = i;
			}
		}
		if (maxSq > sqTol && idx !== -1) {
			keep[idx] = 1;
			stack.push([first, idx], [idx, last]);
		}
	}
	const out = [];
	for (let i = 0; i < ring.length; i++) {
		if (keep[i]) out.push(roundCoord(ring[i]));
	}
	if (out.length >= 3 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
		out.push(out[0]);
	}
	return out;
}

function simplifyMultiPoly(mp, tolDeg = 0.00006, minArea = 1200) {
	const cleaned = [];
	for (const poly of mp) {
		if (ringMetricsM(poly[0]).area < minArea) continue;
		const rings = [simplifyRing(poly[0], tolDeg)];
		for (let i = 1; i < poly.length; i++) {
			if (ringMetricsM(poly[i]).area >= 3500) {
				rings.push(simplifyRing(poly[i], tolDeg));
			}
		}
		cleaned.push(rings);
	}
	if (!cleaned.length && mp.length) {
		return { type: 'Polygon', coordinates: [simplifyRing(mp[0][0], tolDeg)] };
	}
	if (cleaned.length === 1) return { type: 'Polygon', coordinates: cleaned[0] };
	return { type: 'MultiPolygon', coordinates: cleaned };
}

function quantizePoly(mp) {
	return mp
		.map((poly) =>
			poly
				.map((ring) => {
					const out = [];
					for (const pt of ring) {
						const qx = Math.round(pt[0] * 1e5);
						const qy = Math.round(pt[1] * 1e5);
						if (!out.length || out[out.length - 1][0] !== qx || out[out.length - 1][1] !== qy) {
							out.push([qx, qy]);
						}
					}
					if (out.length >= 3 && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) {
						out.push(out[0]);
					}
					return out;
				})
				.filter((r) => r.length >= 4)
		)
		.filter((p) => p.length > 0);
}

function unquantizePoly(mp) {
	return mp.map((poly) => poly.map((ring) => ring.map(([qx, qy]) => [qx / 1e5, qy / 1e5])));
}

function unionTracts(tracts) {
	const qPolys = tracts.map((t) => t.qMultiPoly).filter((p) => p.length > 0);
	if (!qPolys.length) return null;
	let merged;
	try {
		merged = qPolys.length === 1 ? qPolys[0] : polygonClipping.union(qPolys[0], ...qPolys.slice(1));
	} catch {
		merged = qPolys[0];
		for (let i = 1; i < qPolys.length; i++) {
			try {
				merged = polygonClipping.union(merged, qPolys[i]);
			} catch {
				// Skip degenerate ring
			}
		}
	}
	const unq = unquantizePoly(merged);
	const mainPolys = unq.filter((p) => ringMetricsM(p[0]).area >= 2000);
	if (!mainPolys.length) return null;
	return { multiPoly: mainPolys, ...multiPolyMetrics(mainPolys) };
}

function ordinal(nStr) {
	const n = Number(nStr);
	const mod100 = n % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${n}TH`;
	const mod10 = n % 10;
	if (mod10 === 1) return `${n}ST`;
	if (mod10 === 2) return `${n}ND`;
	if (mod10 === 3) return `${n}RD`;
	return `${n}TH`;
}

function titleCase(str) {
	return String(str || '')
		.toLowerCase()
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.replace(/\bNyc\b/g, 'NYC')
		.replace(/\bLlc\b/g, 'LLC')
		.replace(/(\d+)(Th|St|Nd|Rd)\b/gi, (_, n, suf) => `${n}${suf.toLowerCase()}`);
}

function cleanStreet(raw) {
	if (!raw) return null;
	const s = String(raw)
		.trim()
		.toUpperCase()
		.replace(/\s+/g, ' ')
		.replace(/\bAVE(?:NUE)?\.?\s+OF\s+THE\s+AMER(?:ICAS)?\.?\b/g, '6TH AVE')
		.replace(/\bFIRST\b/g, '1ST')
		.replace(/\bSECOND\b/g, '2ND')
		.replace(/\bTHIRD\b/g, '3RD')
		.replace(/\bFOURTH\b/g, '4TH')
		.replace(/\bFIFTH\b/g, '5TH')
		.replace(/\bSIXTH\b/g, '6TH')
		.replace(/\bSEVENTH\b/g, '7TH')
		.replace(/\bEIGHTH\b/g, '8TH')
		.replace(/\bNINTH\b/g, '9TH')
		.replace(/\bTENTH\b/g, '10TH')
		.replace(/\bELEVENTH\b/g, '11TH')
		.replace(/\bTWELFTH\b/g, '12TH')
		.replace(/\bSTREET\b/g, 'ST')
		.replace(/\bAVENUE\b/g, 'AVE')
		.replace(/\bBOULEVARD\b/g, 'BLVD')
		.replace(/\bROAD\b/g, 'RD')
		.replace(/\bPLACE\b/g, 'PL')
		.replace(/\bWEST\b/g, 'W')
		.replace(/\bEAST\b/g, 'E')
		.replace(/\bNORTH\b/g, 'N')
		.replace(/\bSOUTH\b/g, 'S')
		.replace(/\b(\d+)\s+(AVE|ST|RD|PL|DR)\b/g, (_, num, suf) => `${ordinal(num)} ${suf}`);
	if (s.length < 3) return null;
	return titleCase(s);
}

function cleanAddress(r) {
	const raw = String(r.property_street_address_or || `${r.property_number || ''} ${r.property_street || ''}`).trim();
	const s = raw
		.toUpperCase()
		.replace(/\s+/g, ' ')
		.replace(/\bAVE(?:NUE)?\.?\s+OF\s+THE\s+AMER(?:ICAS)?\.?\b/g, '6TH AVE')
		.replace(/\bSTREET\b/g, 'ST')
		.replace(/\bAVENUE\b/g, 'AVE')
		.replace(/\bBOULEVARD\b/g, 'BLVD')
		.replace(/\bROAD\b/g, 'RD')
		.replace(/\bPLACE\b/g, 'PL')
		.replace(/\bWEST\b/g, 'W')
		.replace(/\bEAST\b/g, 'E')
		.replace(/(?<=\s)(\d{1,3})\s+(AVE|ST|RD|PL|DR)\b/g, (_, num, suf) => `${ordinal(num)} ${suf}`);
	return titleCase(s);
}

function slugify(str) {
	return String(str || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function formatCrossPair(a, b) {
	if (a && !b) return `near ${a}`;
	if (b && !a) return `near ${b}`;
	if (!a && !b) return '';
	if (a === b) return `near ${a}`;

	const re = /^([WESN]\s+)?(\d+)(?:st|nd|rd|th)\s+(St|Ave|Rd|Pl|Dr)$/i;
	const ma = a.match(re);
	const mb = b.match(re);
	if (ma && mb && (ma[1] || '').toUpperCase() === (mb[1] || '').toUpperCase() && ma[3].toLowerCase() === mb[3].toLowerCase()) {
		const n1 = Number(ma[2]);
		const n2 = Number(mb[2]);
		const [lo, hi] = n1 <= n2 ? [ma, mb] : [mb, ma];
		const pref = lo[1] ? `${lo[1].trim()} ` : '';
		return `${pref}${ordinal(lo[2]).toLowerCase()} – ${ordinal(hi[2]).toLowerCase()} ${lo[3]}`;
	}
	return `${a} – ${b}`;
}

function topEntries(counterMap, n = 3) {
	return [...counterMap.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k]) => k);
}

function distPtToLineSq(px, py, lineXY) {
	let bestSq = Infinity;
	let bestProj = null;
	for (let i = 0; i < lineXY.length - 1; i++) {
		const [ax, ay] = lineXY[i];
		const [bx, by] = lineXY[i + 1];
		const dx = bx - ax;
		const dy = by - ay;
		const lenSq = dx * dx + dy * dy;
		let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
		t = Math.max(0, Math.min(1, t));
		const qx = ax + t * dx;
		const qy = ay + t * dy;
		const dSq = (px - qx) ** 2 + (py - qy) ** 2;
		if (dSq < bestSq) {
			bestSq = dSq;
			bestProj = { qx, qy };
		}
	}
	return { bestSq, bestProj };
}

/**
 * Compute the ideal CCW rotation angle (in degrees, in [-45, +45]) to straighten a cluster's
 * street grid so avenues are dead-vertical and cross-streets are dead-horizontal!
 */
function computeGridAngleDeg(clusterProps, segs) {
	// Manhattan Commissioners' Grid (above Houston St) is famously tilted 28.9° clockwise from true North
	if (clusterProps.borough === 'Manhattan' && clusterProps.center[1] >= 40.722) {
		return 28.9;
	}
	// Elsewhere, find dominant street axis modulo 90° weighted by segment length
	let sumCos = 0;
	let sumSin = 0;
	for (const s of segs) {
		const len = Math.hypot(s.dx, s.dy);
		if (len < 15) continue;
		const ang = Math.atan2(s.dy, s.dx); // radians
		sumCos += len * Math.cos(4 * ang);
		sumSin += len * Math.sin(4 * ang);
	}
	if (Math.hypot(sumCos, sumSin) < 1) return 0;
	const domRad = Math.atan2(sumSin, sumCos) / 4; // in [-pi/4, +pi/4]
	// Rotate by -domRad so dominant axis aligns horizontally/vertically
	return Math.round(((-domRad * 180) / Math.PI) * 10) / 10;
}

async function loadInputs() {
	const tractsPath = '/tmp/nyc_tracts_2020.geojson';
	const p1 = '/tmp/dof_2025_full_p1.json';
	const p2 = '/tmp/dof_2025_full_p2.json';
	const cscl1 = '/tmp/cscl_streets_p1.json';
	const cscl2 = '/tmp/cscl_streets_p2.json';

	const loadOrFetch = async (file, url, label) => {
		if (FROM_TMP && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
		console.log(`Downloading ${label}...`);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
		const json = await res.json();
		fs.writeFileSync(file, JSON.stringify(json));
		return json;
	};

	const baseDof =
		"https://data.cityofnewyork.us/resource/92iy-9c3n.json?$select=latitude,longitude,vacant_on_12_31,filing_due_date,borough_block_lot,bbl,borough,nta,nbhd,property_number,property_street,property_street_address_or,primary_business_activity&$where=reporting_year='2025'+AND+latitude+IS+NOT+NULL&$order=:id&$limit=50000";
	const baseCscl =
		"https://data.cityofnewyork.us/resource/inkn-q76z.json?$select=stname_label,full_street_name,the_geom&$where=rw_type='1'+AND+stname_label+IS+NOT+NULL&$order=:id&$limit=50000";

	const [tractsGeo, d1, d2, s1, s2] = await Promise.all([
		loadOrFetch(tractsPath, 'https://data.cityofnewyork.us/api/geospatial/63ge-mke6?method=export&format=GeoJSON', '2020 Tracts'),
		loadOrFetch(p1, `${baseDof}&$offset=0`, 'DOF 2025 p1'),
		loadOrFetch(p2, `${baseDof}&$offset=50000`, 'DOF 2025 p2'),
		loadOrFetch(cscl1, `${baseCscl}&$offset=0`, 'CSCL Streets p1'),
		loadOrFetch(cscl2, `${baseCscl}&$offset=50000`, 'CSCL Streets p2')
	]);

	// Deduplicate Feb 15 supplemental filings whenever a BBL also filed its June Annual RPIE
	const rawRows = [...d1, ...d2];
	const rows = dedupeDofRows(rawRows, { fixedYear: 2025 });
	console.log(`DOF 2025 deduplicated: ${rawRows.length.toLocaleString()} raw -> ${rows.length.toLocaleString()} authoritative Dec 31 filings`);

	// Optional cached historical DOF years (2021-2024) + Comptroller NTA Q3 2026 quarterly deltas
	const histYears = {};
	for (const y of [2021, 2022, 2023, 2024]) {
		const f = `/tmp/dof_hist_${y}.json`;
		if (fs.existsSync(f)) {
			histYears[y] = JSON.parse(fs.readFileSync(f, 'utf8'));
		}
	}
	let ntaQuarterlyMap = new Map();
	if (fs.existsSync('/tmp/nta_quarterly.geojson')) {
		const ntaGeo = JSON.parse(fs.readFileSync('/tmp/nta_quarterly.geojson', 'utf8'));
		for (const feat of ntaGeo.features || []) {
			const p = feat.properties || {};
			if (p.nta2020) ntaQuarterlyMap.set(p.nta2020, p);
		}
	}

	return { tractsGeo, rows, csclStreets: [...s1, ...s2], histYears, ntaQuarterlyMap };
}

function partitionCity(activeTracts, sharedEdgeLen, cityRate, opts) {
	const { targetRegions, maxAreaM2, maxStorefronts, maxRateDiff, minCompactness } = opts;

	const regions = new Map();
	for (const t of activeTracts.values()) {
		const m = multiPolyMetrics(t.multiPoly);
		regions.set(t.id, {
			id: t.id,
			tracts: [t],
			total: t.total,
			vacant: t.vacant,
			ebRate: t.ebRate,
			areaM2: m.areaM2,
			perimM: m.perimeterM,
			cx: t.cx,
			cy: t.cy,
			boroname: t.boroname,
			neighbors: new Map()
		});
	}

	for (const [pk, lenM] of sharedEdgeLen.entries()) {
		const [a, b] = pk.split('|');
		const ra = regions.get(a);
		const rb = regions.get(b);
		if (!ra || !rb) continue;
		ra.neighbors.set(b, lenM);
		rb.neighbors.set(a, lenM);
	}

	function mergeCost(ra, rb, sharedM) {
		const newArea = ra.areaM2 + rb.areaM2;
		const newPerim = Math.max(100, ra.perimM + rb.perimM - 2 * sharedM);
		const newComp = Math.min(1, (4 * Math.PI * newArea) / (newPerim * newPerim));
		const newTotal = ra.total + rb.total;
		const rateDiff = Math.abs(ra.ebRate - rb.ebRate);

		const tinyBonus = ra.total < 35 || rb.total < 35 ? -0.4 : 0;

		if (tinyBonus === 0) {
			if (newArea > maxAreaM2) return Infinity;
			if (newTotal > maxStorefronts) return Infinity;
			if (rateDiff > maxRateDiff) return Infinity;
			if (newComp < minCompactness && sharedM < 250) return Infinity;
		} else {
			if (newArea > maxAreaM2 * 1.45 || newTotal > maxStorefronts * 1.35) return Infinity;
		}

		const wardPenalty = ((ra.total * rb.total) / (newTotal || 1)) * rateDiff * rateDiff * 0.08;
		const compPenalty = (1 - newComp) * 0.9;
		const sizePenalty = (newArea / maxAreaM2) * 0.3 + (newTotal / maxStorefronts) * 0.25;
		const ratePenalty = rateDiff * 4.0;

		return ratePenalty + wardPenalty + compPenalty + sizePenalty + tinyBonus;
	}

	while (regions.size > targetRegions) {
		let bestCost = Infinity;
		let bestA = null;
		let bestB = null;

		for (const ra of regions.values()) {
			for (const [nbId, sharedM] of ra.neighbors.entries()) {
				if (ra.id >= nbId) continue;
				const rb = regions.get(nbId);
				if (!rb) continue;
				const c = mergeCost(ra, rb, sharedM);
				if (c < bestCost) {
					bestCost = c;
					bestA = ra;
					bestB = rb;
				}
			}
		}

		if (!bestA || !bestB || !Number.isFinite(bestCost)) break;

		const sharedM = bestA.neighbors.get(bestB.id) || 0;
		const newTotal = bestA.total + bestB.total;
		bestA.cx = (bestA.cx * bestA.total + bestB.cx * bestB.total) / Math.max(1, newTotal);
		bestA.cy = (bestA.cy * bestA.total + bestB.cy * bestB.total) / Math.max(1, newTotal);
		bestA.total = newTotal;
		bestA.vacant += bestB.vacant;
		bestA.ebRate = (bestA.vacant + 10 * cityRate) / (bestA.total + 10);
		bestA.areaM2 += bestB.areaM2;
		bestA.perimM = Math.max(100, bestA.perimM + bestB.perimM - 2 * sharedM);
		bestA.tracts.push(...bestB.tracts);

		bestA.neighbors.delete(bestB.id);
		for (const [nId, nLen] of bestB.neighbors.entries()) {
			if (nId === bestA.id) continue;
			const rn = regions.get(nId);
			if (!rn) continue;
			rn.neighbors.delete(bestB.id);
			const combined = (bestA.neighbors.get(nId) || 0) + nLen;
			bestA.neighbors.set(nId, combined);
			rn.neighbors.set(bestA.id, combined);
		}
		regions.delete(bestB.id);
	}

	return [...regions.values()].filter((r) => r.total >= 10);
}

function isNoiseBorderStreet(name) {
	return /\b(ACCESS|RAMP|EXIT|PIER|WALK|PATH|FOOTBRIDGE|PEDESTRIAN|OVERPASS|UNDERPASS|TUNNEL|SUBWAY|ESPLANADE|GREENWAY|PROMENADE|DRWY|DRIVEWAY|BRIDGE APPROACH|SERVICE RD)\b/i.test(
		name
	);
}

function compactPair(a, b) {
	if (a && b && a !== b) {
		const ma = a.match(/^([WE]\s+)?(\d+(?:st|nd|rd|th))\s+(St|Ave)$/i);
		const mb = b.match(/^([WE]\s+)?(\d+(?:st|nd|rd|th))\s+(St|Ave)$/i);
		if (
			ma &&
			mb &&
			(ma[1] || '').toUpperCase() === (mb[1] || '').toUpperCase() &&
			ma[3].toLowerCase() === mb[3].toLowerCase()
		) {
			return `${ma[1] || ''}${ma[2]} – ${mb[2]} ${ma[3]}`;
		}
		return `${a} – ${b}`;
	}
	return a || b || '';
}

function computeClusterBorders(c, gridAngleDeg, segGrid) {
	const S_CELL = 0.002;
	const rad = (gridAngleDeg * Math.PI) / 180;
	const cosA = Math.cos(rad);
	const sinA = Math.sin(rad);

	const bySide = { N: new Map(), S: new Map(), W: new Map(), E: new Map() };
	const polys = c.geometry.type === 'Polygon' ? [c.geometry.coordinates] : c.geometry.coordinates;

	for (const poly of polys) {
		const ring = poly[0];
		if (!ring || ring.length < 4) continue;

		const ringXY = ring.map(([lng, lat]) => toXY(lng, lat));
		let signedArea2 = 0;
		for (let i = 0; i < ringXY.length - 1; i++) {
			signedArea2 += ringXY[i][0] * ringXY[i + 1][1] - ringXY[i + 1][0] * ringXY[i][1];
		}
		const outSign = signedArea2 >= 0 ? 1 : -1;

		for (let i = 0; i < ring.length - 1; i++) {
			const [x1, y1] = ringXY[i];
			const [x2, y2] = ringXY[i + 1];
			const dx = x2 - x1;
			const dy = y2 - y1;
			const edgeLen = Math.hypot(dx, dy);
			if (edgeLen < 22) continue;

			const ux = dx / edgeLen;
			const uy = dy / edgeLen;
			const nx = (dy / edgeLen) * outSign;
			const ny = (-dx / edgeLen) * outSign;

			const rnx = nx * cosA - ny * sinA;
			const rny = nx * sinA + ny * cosA;
			const side = Math.abs(rny) >= Math.abs(rnx) ? (rny >= 0 ? 'N' : 'S') : rnx >= 0 ? 'E' : 'W';

			const steps = Math.max(1, Math.round(edgeLen / 110));
			const stepLen = edgeLen / steps;

			for (let s = 0; s < steps; s++) {
				const f = (s + 0.5) / steps;
				const midLng = ring[i][0] + (ring[i + 1][0] - ring[i][0]) * f;
				const midLat = ring[i][1] + (ring[i + 1][1] - ring[i][1]) * f;
				const [mx, my] = toXY(midLng, midLat);

				const gx = Math.floor(midLng / S_CELL);
				const gy = Math.floor(midLat / S_CELL);
				let bestName = null;
				let bestScore = Infinity;

				for (let ox = -1; ox <= 1; ox++) {
					for (let oy = -1; oy <= 1; oy++) {
						const bucket = segGrid.get(`${gx + ox},${gy + oy}`);
						if (!bucket) continue;
						for (const seg of bucket) {
							if (!seg.name || isNoiseBorderStreet(seg.name)) continue;
							const sLen = Math.hypot(seg.dx, seg.dy);
							if (sLen < 12) continue;
							const parallel = Math.abs(ux * (seg.dx / sLen) + uy * (seg.dy / sLen));
							if (parallel < 0.72) continue;

							// Ensure matched street matches the compass axis (N/S = horizontal, W/E = vertical)
							const srdx = seg.dx * cosA - seg.dy * sinA;
							const srdy = seg.dx * sinA + seg.dy * cosA;
							const segIsHoriz = Math.abs(srdx) >= Math.abs(srdy);
							if ((side === 'N' || side === 'S') && !segIsHoriz) continue;
							if ((side === 'W' || side === 'E') && segIsHoriz) continue;

							const { bestSq } = distPtToLineSq(mx, my, seg.lineXY);
							if (bestSq > 50 * 50) continue;

							const score = Math.sqrt(bestSq) + (1 - parallel) * 20;
							if (score < bestScore) {
								bestScore = score;
								bestName = seg.name;
							}
						}
					}
				}

				if (bestName) {
					const m = bySide[side];
					const cur = m.get(bestName) || { len: 0, sumLng: 0, sumLat: 0, coords: [] };
					cur.len += stepLen;
					cur.sumLng += midLng * stepLen;
					cur.sumLat += midLat * stepLen;
					cur.coords.push([midLng, midLat, stepLen]);
					m.set(bestName, cur);
				}
			}
		}
	}

	const allInternal = [
		...c.segments.map((s) => ({ name: s.name, line: s.line })),
		...c.contextLines.map((cl) => ({ name: cl.name, line: cl.line }))
	].filter((x) => x.name && !isNoiseBorderStreet(x.name));

	const pickCoordOnBorder = (entry) => {
		const avgLng = entry.sumLng / entry.len;
		const avgLat = entry.sumLat / entry.len;
		let best = entry.coords[0];
		let bestD = Infinity;
		for (const pt of entry.coords) {
			const d = Math.hypot(pt[0] - avgLng, pt[1] - avgLat);
			if (d < bestD) {
				bestD = d;
				best = pt;
			}
		}
		return [Math.round(best[0] * 100000) / 100000, Math.round(best[1] * 100000) / 100000];
	};

	const edgeLabels = [];
	const primary = { N: '', S: '', W: '', E: '' };

	for (const side of ['N', 'S', 'W', 'E']) {
		const ranked = [...bySide[side].entries()].sort((a, b) => b[1].len - a[1].len);
		if (ranked.length > 0 && ranked[0][1].len >= 120) {
			const [topName, topEntry] = ranked[0];
			primary[side] = topName;
			const topCoord = pickCoordOnBorder(topEntry);
			edgeLabels.push({ street: topName, side, coord: topCoord });

			// Allow 1 secondary stepped border street if it's a long, distinct stretch far from primary
			for (let k = 1; k < ranked.length; k++) {
				const [secName, secEntry] = ranked[k];
				if (secName === topName) continue;
				if (secEntry.len < 240 || secEntry.len < topEntry.len * 0.32) break;
				const secCoord = pickCoordOnBorder(secEntry);
				const [x1, y1] = toXY(topCoord[0], topCoord[1]);
				const [x2, y2] = toXY(secCoord[0], secCoord[1]);
				if (Math.hypot(x2 - x1, y2 - y1) >= 260) {
					edgeLabels.push({ street: secName, side, coord: secCoord });
					break;
				}
			}
		} else if (allInternal.length > 0) {
			let best = null;
			let bestVal = -Infinity;
			for (const item of allInternal) {
				const a = item.line[0];
				const b = item.line[item.line.length - 1];
				const [ax, ay] = toXY(a[0], a[1]);
				const [bx, by] = toXY(b[0], b[1]);
				const rdx = (bx - ax) * cosA - (by - ay) * sinA;
				const rdy = (bx - ax) * sinA + (by - ay) * cosA;
				const isHoriz = Math.abs(rdx) >= Math.abs(rdy);
				if ((side === 'N' || side === 'S') && !isHoriz) continue;
				if ((side === 'W' || side === 'E') && isHoriz) continue;
				const mx = (ax + bx) / 2;
				const my = (ay + by) / 2;
				const rx = mx * cosA - my * sinA;
				const ry = mx * sinA + my * cosA;
				const val = side === 'N' ? ry : side === 'S' ? -ry : side === 'E' ? rx : -rx;
				if (val > bestVal) {
					bestVal = val;
					const mid = item.line[Math.floor(item.line.length / 2)];
					best = {
						name: item.name,
						coord: [Math.round(mid[0] * 100000) / 100000, Math.round(mid[1] * 100000) / 100000]
					};
				}
			}
			if (best) {
				primary[side] = best.name;
				edgeLabels.push({ street: best.name, side, coord: best.coord });
			}
		}
	}

	const nsPart = compactPair(primary.S, primary.N);
	const wePart = compactPair(primary.W, primary.E);
	const summary = [nsPart, wePart].filter(Boolean).join(' · ');

	return {
		borders: {
			n: primary.N,
			s: primary.S,
			w: primary.W,
			e: primary.E,
			summary
		},
		edge_labels: edgeLabels
	};
}

async function main() {
	const { tractsGeo, rows, csclStreets, histYears, ntaQuarterlyMap } = await loadInputs();

	// 1. Index all 2020 Census Tracts
	const CELL = 0.006;
	const tractGrid = new Map();
	const tractMap = new Map();

	for (const feat of tractsGeo.features) {
		const p = feat.properties || {};
		const id = p.boroct2020 || p.geoid;
		if (!id || !feat.geometry) continue;
		const mp = geomToMultiPoly(feat.geometry);
		if (!mp.length) continue;
		const bbox = bboxOfMultiPoly(mp);
		const centerLng = (bbox[0] + bbox[2]) / 2;
		const centerLat = (bbox[1] + bbox[3]) / 2;
		const [cx, cy] = toXY(centerLng, centerLat);

		const tract = {
			id,
			boroname: p.boroname || '',
			nta2020: p.nta2020 || '',
			ntaname: p.ntaname || '',
			geometry: feat.geometry,
			multiPoly: mp,
			qMultiPoly: quantizePoly(mp),
			bbox,
			centerLng,
			centerLat,
			cx,
			cy,
			total: 0,
			vacant: 0,
			streets: new Map(),
			taxBlocks: new Set()
		};
		tractMap.set(id, tract);

		for (let gx = Math.floor(bbox[0] / CELL); gx <= Math.floor(bbox[2] / CELL); gx++) {
			for (let gy = Math.floor(bbox[1] / CELL); gy <= Math.floor(bbox[3] / CELL); gy++) {
				const k = `${gx},${gy}`;
				if (!tractGrid.has(k)) tractGrid.set(k, []);
				tractGrid.get(k).push(tract);
			}
		}
	}

	// 2. Index all CSCL 1-block street segments + intersection nodes
	const S_CELL = 0.002;
	const segGrid = new Map();
	const nodeStreets = new Map();
	const segments = [];

	const nodeKey = (pt) => `${Math.round(pt[0] / 0.00014)},${Math.round(pt[1] / 0.00014)}`;

	for (const rec of csclStreets) {
		const name = cleanStreet(rec.stname_label || rec.full_street_name);
		const lines =
			rec.the_geom?.type === 'MultiLineString'
				? rec.the_geom.coordinates
				: rec.the_geom?.type === 'LineString'
					? [rec.the_geom.coordinates]
					: [];
		if (!name || !lines.length) continue;

		for (const rawLine of lines) {
			if (rawLine.length < 2) continue;
			const line = rawLine.map(roundCoord);
			const lineXY = line.map(([lng, lat]) => toXY(lng, lat));
			const start = line[0];
			const end = line[line.length - 1];
			const [sx, sy] = lineXY[0];
			const [ex, ey] = lineXY[lineXY.length - 1];
			const spanLen = Math.hypot(ex - sx, ey - sy);
			if (spanLen < 12) continue;

			const mid = line[Math.floor(line.length / 2)];
			const seg = {
				id: `seg-${segments.length + 1}`,
				name,
				line,
				lineXY,
				start,
				end,
				startKey: nodeKey(start),
				endKey: nodeKey(end),
				midLng: mid[0],
				midLat: mid[1],
				dx: ex - sx,
				dy: ey - sy,
				lengthM: Math.round(spanLen),
				storefronts: [],
				clusterIds: new Set()
			};
			segments.push(seg);

			for (const nk of [seg.startKey, seg.endKey]) {
				if (!nodeStreets.has(nk)) nodeStreets.set(nk, new Set());
				nodeStreets.get(nk).add(name);
			}
		}
	}

	// 2.5 Merge mid-block CSCL fragments split only by an unnamed node / driveway / ramp (zero real cross-streets!)
	// Eliminates "two-color half-blocks" like E 34th (near 3rd + near 2nd) and E 38th (near 3rd + near 2nd).
	const isNonCrossName = (s) => /^(Connector|Ramp|Driveway|Path|Walk|Mall|Plaza|Pedestrian|Tunnel\s+Approach)$/i.test(s);
	const segsByNode = new Map();
	for (const seg of segments) {
		for (const nk of [seg.startKey, seg.endKey]) {
			if (!segsByNode.has(nk)) segsByNode.set(nk, []);
			segsByNode.get(nk).push(seg);
		}
	}

	const mergedAway = new Set();
	let mergeCount = 0;
	for (const [nk, list] of segsByNode.entries()) {
		const alive = list.filter((s) => !mergedAway.has(s.id));
		if (alive.length !== 2) continue;
		const [a, b] = alive;
		if (a.id === b.id || a.name !== b.name) continue;
		if (a.lengthM + b.lengthM > 320) continue;

		// Ensure NO real named cross-street meets this node
		const stSet = nodeStreets.get(nk);
		const realCross = [...(stSet || [])].filter((n) => n !== a.name && !isNonCrossName(n));
		if (realCross.length > 0) continue;

		// Verify actual endpoint proximity (< 10m) and collinearity (dot >= 0.75)
		const distM = (p, q) => Math.hypot((p[0] - q[0]) * 84500, (p[1] - q[1]) * 111320);
		let aLine = a.line;
		let bLine = b.line;
		let joined = false;
		if (distM(a.end, b.start) <= 10) {
			joined = true;
		} else if (distM(a.end, b.end) <= 10) {
			bLine = [...b.line].reverse();
			joined = true;
		} else if (distM(a.start, b.start) <= 10) {
			aLine = [...a.line].reverse();
			joined = true;
		} else if (distM(a.start, b.end) <= 10) {
			aLine = [...a.line].reverse();
			bLine = [...b.line].reverse();
			joined = true;
		}
		if (!joined) continue;

		// Check collinearity along the merged direction
		const [ax0, ay0] = toXY(aLine[0][0], aLine[0][1]);
		const [ax1, ay1] = toXY(aLine[aLine.length - 1][0], aLine[aLine.length - 1][1]);
		const [bx0, by0] = toXY(bLine[0][0], bLine[0][1]);
		const [bx1, by1] = toXY(bLine[bLine.length - 1][0], bLine[bLine.length - 1][1]);
		const al = Math.hypot(ax1 - ax0, ay1 - ay0) || 1;
		const bl = Math.hypot(bx1 - bx0, by1 - by0) || 1;
		const dot = ((ax1 - ax0) / al) * ((bx1 - bx0) / bl) + ((ay1 - ay0) / al) * ((by1 - by0) / bl);
		if (dot < 0.75) continue;

		const newLine = [...aLine, ...bLine.slice(1)];
		const newLineXY = newLine.map(([lng, lat]) => toXY(lng, lat));
		const [sx, sy] = newLineXY[0];
		const [ex, ey] = newLineXY[newLineXY.length - 1];
		const newLen = Math.round(Math.hypot(ex - sx, ey - sy));
		const newMid = newLine[Math.floor(newLine.length / 2)];

		a.line = newLine;
		a.lineXY = newLineXY;
		a.start = newLine[0];
		a.end = newLine[newLine.length - 1];
		a.startKey = nodeKey(a.start);
		a.endKey = nodeKey(a.end);
		a.midLng = newMid[0];
		a.midLat = newMid[1];
		a.dx = ex - sx;
		a.dy = ey - sy;
		a.lengthM = newLen;

		// Transfer b's far-end node reference to a so chained 3-piece splits can merge cleanly too
		for (const endNk of [a.startKey, a.endKey]) {
			if (!segsByNode.has(endNk)) segsByNode.set(endNk, []);
			if (!segsByNode.get(endNk).includes(a)) segsByNode.get(endNk).push(a);
		}
		mergedAway.add(b.id);
		mergeCount++;
	}

	const cleanSegments = segments.filter((s) => !mergedAway.has(s.id));
	segments.length = 0;
	for (const seg of cleanSegments) {
		segments.push(seg);
		let minLng = 180,
			maxLng = -180,
			minLat = 90,
			maxLat = -90;
		for (const pt of seg.line) {
			if (pt[0] < minLng) minLng = pt[0];
			if (pt[0] > maxLng) maxLng = pt[0];
			if (pt[1] < minLat) minLat = pt[1];
			if (pt[1] > maxLat) maxLat = pt[1];
		}
		for (let gx = Math.floor(minLng / S_CELL); gx <= Math.floor(maxLng / S_CELL); gx++) {
			for (let gy = Math.floor(minLat / S_CELL); gy <= Math.floor(maxLat / S_CELL); gy++) {
				const k = `${gx},${gy}`;
				if (!segGrid.has(k)) segGrid.set(k, []);
				segGrid.get(k).push(seg);
			}
		}
	}
	if (mergeCount > 0) console.log(`Merged ${mergeCount} unnamed mid-block CSCL fragments into full blocks`);

	// 3. Assign every geocoded 2025 storefront to its Tract & 1-block CSCL segment
	let answeredTotal = 0;
	let answeredVacant = 0;
	const allTaxBlocks = new Set();

	for (const r of rows) {
		const isVac = parseDofVacant(r.vacant_on_12_31);
		if (isVac === null) continue;
		const lat = Number(r.latitude);
		const lng = Number(r.longitude);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

		const tBucket = tractGrid.get(`${Math.floor(lng / CELL)},${Math.floor(lat / CELL)}`);
		let tractHit = null;
		if (tBucket) {
			for (const t of tBucket) {
				if (lng < t.bbox[0] || lng > t.bbox[2] || lat < t.bbox[1] || lat > t.bbox[3]) continue;
				if (pointInGeometry(lng, lat, t.geometry)) {
					tractHit = t;
					break;
				}
			}
		}
		if (!tractHit) continue;

		answeredTotal += 1;
		if (isVac) answeredVacant += 1;
		tractHit.total += 1;
		if (isVac) tractHit.vacant += 1;

		const st = cleanStreet(r.property_street);
		if (st) tractHit.streets.set(st, (tractHit.streets.get(st) || 0) + 1);
		if (r.bbl && String(r.bbl).length >= 6) {
			const tb = String(r.bbl).slice(0, 6);
			tractHit.taxBlocks.add(tb);
			allTaxBlocks.add(tb);
		}

		const [px, py] = toXY(lng, lat);
		const sx0 = Math.floor(lng / S_CELL);
		const sy0 = Math.floor(lat / S_CELL);
		let bestSameName = null;
		let bestSameSq = 60 * 60;
		let bestAny = null;
		let bestAnySq = 45 * 45;

		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const bucket = segGrid.get(`${sx0 + dx},${sy0 + dy}`);
				if (!bucket) continue;
				for (const seg of bucket) {
					const { bestSq, bestProj } = distPtToLineSq(px, py, seg.lineXY);
					if (st && seg.name === st && bestSq < bestSameSq) {
						bestSameSq = bestSq;
						bestSameName = { seg, proj: bestProj };
					}
					if (bestSq < bestAnySq) {
						bestAnySq = bestSq;
						bestAny = { seg, proj: bestProj };
					}
				}
			}
		}

		const picked = bestSameName || bestAny;
		if (picked) {
			const { seg, proj } = picked;
			const rot = tractHit.boroname === 'Manhattan' ? (28.9 * Math.PI) / 180 : 0;
			const cosR = Math.cos(rot);
			const sinR = Math.sin(rot);
			const rdx = seg.dx * cosR - seg.dy * sinR;
			const rdy = seg.dx * sinR + seg.dy * cosR;
			const isEastWestStreet = Math.abs(rdx) >= Math.abs(rdy);

			const offX = px - proj.qx;
			const offY = py - proj.qy;
			const rOffX = offX * cosR - offY * sinR;
			const rOffY = offX * sinR + offY * cosR;
			const side = isEastWestStreet ? (rOffY >= 0 ? 'North' : 'South') : rOffX >= 0 ? 'East' : 'West';

			const activity = cleanDofActivity(r.primary_business_activity, 2025, isVac) || (isVac ? 'Vacant' : 'Open');

			seg.storefronts.push({
				address: cleanAddress(r),
				num: String(r.property_number || '').trim(),
				bbl: r.bbl ? String(r.bbl).trim() : null,
				vacant: isVac,
				activity,
				side,
				tractId: tractHit.id,
				lat: Math.round(lat * 100000) / 100000,
				lng: Math.round(lng * 100000) / 100000
			});
			seg.isEastWest = isEastWestStreet;
			seg.boroname = tractHit.boroname;
		}
	}

	const cityRate = answeredVacant / answeredTotal;
	const EB_STRENGTH = 10;

	// 4. Partition NYC into Compact Clusters
	const activeTracts = new Map();
	const edgeOwners = new Map();

	for (const t of tractMap.values()) {
		if (t.total < 2) continue;
		t.rawRate = t.vacant / t.total;
		t.ebRate = (t.vacant + EB_STRENGTH * cityRate) / (t.total + EB_STRENGTH);
		activeTracts.set(t.id, t);

		const seenV = new Map();
		for (const poly of t.multiPoly) {
			const ring = poly[0];
			for (let i = 0; i < ring.length - 1; i++) {
				const [x1, y1] = toXY(ring[i][0], ring[i][1]);
				const [x2, y2] = toXY(ring[i + 1][0], ring[i + 1][1]);
				const segLen = Math.hypot(x2 - x1, y2 - y1);
				const vk = `${Math.round(ring[i][0] / 0.00018)},${Math.round(ring[i][1] / 0.00018)}`;
				seenV.set(vk, (seenV.get(vk) || 0) + segLen * 0.5);
			}
		}
		for (const [vk, approxLen] of seenV.entries()) {
			if (!edgeOwners.has(vk)) edgeOwners.set(vk, []);
			edgeOwners.get(vk).push({ id: t.id, len: approxLen });
		}
	}

	const pairSharedLen = new Map();
	const pairSharedCount = new Map();
	for (const owners of edgeOwners.values()) {
		if (owners.length < 2 || owners.length > 8) continue;
		for (let i = 0; i < owners.length; i++) {
			for (let j = i + 1; j < owners.length; j++) {
				const a = owners[i].id < owners[j].id ? owners[i].id : owners[j].id;
				const b = owners[i].id < owners[j].id ? owners[j].id : owners[i].id;
				const ta = activeTracts.get(a);
				const tb = activeTracts.get(b);
				if (!ta || !tb) continue;
				if (
					ta.boroname !== tb.boroname &&
					!(ta.boroname === 'Brooklyn' && tb.boroname === 'Queens') &&
					!(ta.boroname === 'Queens' && tb.boroname === 'Brooklyn')
				) {
					continue;
				}
				const pk = `${a}|${b}`;
				pairSharedCount.set(pk, (pairSharedCount.get(pk) || 0) + 1);
				pairSharedLen.set(pk, (pairSharedLen.get(pk) || 0) + Math.min(owners[i].len, owners[j].len));
			}
		}
	}

	const sharedEdgeLen = new Map();
	for (const [pk, cnt] of pairSharedCount.entries()) {
		if (cnt >= 2) sharedEdgeLen.set(pk, Math.max(40, pairSharedLen.get(pk) || 80));
	}

	const rawRegions = partitionCity(activeTracts, sharedEdgeLen, cityRate, {
		targetRegions: 240,
		maxAreaM2: 3_600_000,
		maxStorefronts: 1050,
		maxRateDiff: 0.085,
		minCompactness: 0.40
	});

	const clusterList = [];
	const usedNames = new Set();

	for (const reg of rawRegions) {
		const union = unionTracts(reg.tracts);
		if (!union) continue;

		const streets = new Map();
		const nbhds = new Map();
		const ntas = new Map();
		const boroughs = new Map();
		const taxBlocks = new Set();
		let sumLng = 0,
			sumLat = 0;

		for (const t of reg.tracts) {
			sumLng += t.centerLng * t.total;
			sumLat += t.centerLat * t.total;
			for (const [k, v] of t.streets) streets.set(k, (streets.get(k) || 0) + v);
			if (t.ntaname) nbhds.set(t.ntaname, (nbhds.get(t.ntaname) || 0) + t.total);
			if (t.nta2020) ntas.set(t.nta2020, (ntas.get(t.nta2020) || 0) + t.total);
			if (t.boroname) boroughs.set(t.boroname, (boroughs.get(t.boroname) || 0) + t.total);
			for (const b of t.taxBlocks) taxBlocks.add(b);
		}

		const topStreets = topEntries(streets, 4);
		const topNbhds = topEntries(nbhds, 3);
		const crossedNtas = [...ntas.entries()].filter(([, c]) => c >= 5).sort((a, b) => b[1] - a[1]);
		const primaryBorough = topEntries(boroughs, 1)[0] || reg.boroname || 'NYC';
		const primaryNbhd = topNbhds[0] || primaryBorough;
		const s1 = topStreets[0] || primaryNbhd;
		const s2 = topStreets[1] && topStreets[1] !== s1 ? topStreets[1] : null;
		const s3 = topStreets[2] && topStreets[2] !== s1 && topStreets[2] !== s2 ? topStreets[2] : null;

		let name =
			s2 && !primaryNbhd.toLowerCase().includes(s1.toLowerCase())
				? `${primaryNbhd}: ${s1} & ${s2}`
				: `${primaryNbhd} · ${s1}`;
		if (usedNames.has(name)) {
			name = s3 ? `${primaryNbhd}: ${s1} & ${s3}` : `${name} (${topNbhds[1] || 'Area'})`;
		}
		if (usedNames.has(name)) name = `${name} #${clusterList.length + 1}`;
		usedNames.add(name);

		const rate = Math.round((reg.vacant / reg.total) * 10000) / 10000;
		const tier = rate >= 0.16 ? 'hot' : rate <= 0.085 ? 'thriving' : 'steady';
		const geom = simplifyMultiPoly(union.multiPoly, 0.00007);
		const bbox = bboxOfMultiPoly(union.multiPoly).map((n) => Math.round(n * 10000) / 10000);

		clusterList.push({
			regId: reg.id,
			tracts: reg.tracts,
			tractIds: new Set(reg.tracts.map((t) => t.id)),
			ntaWeights: [...ntas.entries()].sort((a, b) => b[1] - a[1]),
			rawNeighbors: reg.neighbors,
			props: {
				id: '',
				tier,
				name,
				borough: primaryBorough,
				neighborhoods: topNbhds,
				crossed_nta_count: crossedNtas.length,
				crossed_ntas: crossedNtas.slice(0, 4).map(([k]) => k),
				top_streets: topStreets,
				total_storefronts: reg.total,
				vacant_storefronts: reg.vacant,
				vacancy_rate: rate,
				street_count: 0,
				segment_count: 0,
				tax_block_count: taxBlocks.size,
				compactness: Math.round(union.compactness * 100) / 100,
				area_km2: Math.round((union.areaM2 / 1_000_000) * 100) / 100,
				center: [Math.round((sumLng / reg.total) * 10000) / 10000, Math.round((sumLat / reg.total) * 10000) / 10000],
				bbox
			},
			geometry: geom,
			segments: [],
			contextLines: []
		});
	}

	clusterList.sort((a, b) => b.props.vacancy_rate - a.props.vacancy_rate);
	const clusterById = new Map();
	const clusterByRegId = new Map();
	const tractToClusterId = new Map();

	clusterList.forEach((c, idx) => {
		const cid = `c-${idx + 1}`;
		c.props.id = cid;
		clusterById.set(cid, c);
		clusterByRegId.set(c.regId, c);
		for (const tid of c.tractIds) tractToClusterId.set(tid, cid);
	});

	// 4.5 Compute 5-year DOF history (2021-2025) per cluster + 2024 baseline per block + Comptroller NTA Q3 2026 overlay
	const HIST_YEARS = [2021, 2022, 2023, 2024];
	const clusterHist = new Map();
	for (const c of clusterList) {
		const byY = {};
		for (const y of HIST_YEARS) byY[y] = { total: 0, vacant: 0 };
		clusterHist.set(c.props.id, byY);
	}
	const cityHist = {};
	for (const y of HIST_YEARS) cityHist[y] = { total: 0, vacant: 0 };
	const segPrev2024 = new Map();

	for (const y of HIST_YEARS) {
		const hRows = histYears[y];
		if (!Array.isArray(hRows) || hRows.length === 0) continue;
		for (const tuple of hRows) {
			const [lat, lng, isVac, rawStreet] = tuple;
			const tBucket = tractGrid.get(`${Math.floor(lng / CELL)},${Math.floor(lat / CELL)}`);
			let tractHit = null;
			if (tBucket) {
				for (const t of tBucket) {
					if (lng < t.bbox[0] || lng > t.bbox[2] || lat < t.bbox[1] || lat > t.bbox[3]) continue;
					if (pointInGeometry(lng, lat, t.geometry)) {
						tractHit = t;
						break;
					}
				}
			}
			if (!tractHit) continue;
			cityHist[y].total += 1;
			if (isVac) cityHist[y].vacant += 1;

			const cid = tractToClusterId.get(tractHit.id);
			if (cid) {
				const slot = clusterHist.get(cid)[y];
				slot.total += 1;
				if (isVac) slot.vacant += 1;
			}

			// Match 2024 storefronts onto exact 1-block CSCL segments for block-level YoY trend
			if (y === 2024) {
				const st = cleanStreet(rawStreet);
				const [px, py] = toXY(lng, lat);
				const sx0 = Math.floor(lng / S_CELL);
				const sy0 = Math.floor(lat / S_CELL);
				let bestSame = null;
				let bestSameSq = 60 * 60;
				let bestAny = null;
				let bestAnySq = 45 * 45;
				for (let dx = -1; dx <= 1; dx++) {
					for (let dy = -1; dy <= 1; dy++) {
						const bucket = segGrid.get(`${sx0 + dx},${sy0 + dy}`);
						if (!bucket) continue;
						for (const seg of bucket) {
							const { bestSq } = distPtToLineSq(px, py, seg.lineXY);
							if (st && seg.name === st && bestSq < bestSameSq) {
								bestSameSq = bestSq;
								bestSame = seg;
							}
							if (bestSq < bestAnySq) {
								bestAnySq = bestSq;
								bestAny = seg;
							}
						}
					}
				}
				const hitSeg = bestSame || bestAny;
				if (hitSeg) {
					let rec = segPrev2024.get(hitSeg.id);
					if (!rec) {
						rec = { total: 0, vacant: 0 };
						segPrev2024.set(hitSeg.id, rec);
					}
					rec.total += 1;
					if (isVac) rec.vacant += 1;
				}
			}
		}
	}

	const dofHistory = [];
	for (const y of HIST_YEARS) {
		if (cityHist[y].total > 0) {
			dofHistory.push({
				year: y,
				total: cityHist[y].total,
				vacant: cityHist[y].vacant,
				rate: Math.round((cityHist[y].vacant / cityHist[y].total) * 10000) / 10000
			});
		}
	}
	dofHistory.push({
		year: 2025,
		total: answeredTotal,
		vacant: answeredVacant,
		rate: Math.round(cityRate * 10000) / 10000
	});

	for (const c of clusterList) {
		const byY = clusterHist.get(c.props.id);
		const hist = [];
		for (const y of HIST_YEARS) {
			if (byY[y].total > 0) {
				hist.push({
					year: y,
					total: byY[y].total,
					vacant: byY[y].vacant,
					rate: Math.round((byY[y].vacant / byY[y].total) * 10000) / 10000
				});
			}
		}
		hist.push({
			year: 2025,
			total: c.props.total_storefronts,
			vacant: c.props.vacant_storefronts,
			rate: c.props.vacancy_rate
		});
		c.props.history = hist;

		const y24 = byY[2024];
		c.props.yoy_change =
			y24 && y24.total >= 5
				? Math.round((c.props.vacancy_rate - y24.vacant / y24.total) * 10000) / 10000
				: null;

		// Join storefront-weighted Comptroller NTA Q3 2026 rate & QoQ delta
		let wSum = 0;
		let q3RateSum = 0;
		let qoqSum = 0;
		let primaryNtaLabel = null;
		for (const [ntaCode, w] of c.ntaWeights || []) {
			const rec = ntaQuarterlyMap.get(ntaCode);
			if (!rec || rec.valid_overall !== 1) continue;
			if (!primaryNtaLabel && rec.ntaname) primaryNtaLabel = rec.ntaname;
			if (typeof rec.vacancy_rate === 'number' && typeof rec.vacancy_rate_change === 'number') {
				wSum += w;
				q3RateSum += rec.vacancy_rate * w;
				qoqSum += rec.vacancy_rate_change * w;
			}
		}
		c.props.nta_q3_rate = wSum > 0 ? Math.round((q3RateSum / wSum) * 10000) / 10000 : null;
		c.props.nta_qoq_change = wSum > 0 ? Math.round((qoqSum / wSum) * 10000) / 10000 : null;
		c.props.nta_q3_label = primaryNtaLabel;
	}

	// 5. Attach EVERY active commercial segment AND quiet residential context streets inside each cluster!
	let activeSegmentCount = 0;
	let dividingSegmentCount = 0;

	for (const seg of segments) {
		const crossAt = (nk) => {
			const set = nodeStreets.get(nk);
			if (!set) return null;
			const others = [...set].filter((s) => s !== seg.name);
			return others[0] || null;
		};
		seg.crossA = crossAt(seg.startKey);
		seg.crossB = crossAt(seg.endKey);
		seg.betweenLabel = formatCrossPair(seg.crossA, seg.crossB) || 'Block stretch';

		if (seg.storefronts.length > 0) {
			activeSegmentCount += 1;
			for (const sf of seg.storefronts) {
				const cid = tractToClusterId.get(sf.tractId);
				if (cid) {
					sf.clusterId = cid;
					seg.clusterIds.add(cid);
				}
			}
			if (seg.clusterIds.size === 0) continue;
			if (seg.clusterIds.size >= 2) dividingSegmentCount += 1;

			seg.total = seg.storefronts.length;
			seg.vacant = seg.storefronts.filter((s) => s.vacant).length;
			seg.rate = Math.round((seg.vacant / seg.total) * 10000) / 10000;

			for (const cid of seg.clusterIds) {
				clusterById.get(cid).segments.push(seg);
			}
		} else {
			// Quiet residential/non-retail street segment: attach as blueprint context to containing cluster!
			const tBucket = tractGrid.get(`${Math.floor(seg.midLng / CELL)},${Math.floor(seg.midLat / CELL)}`);
			if (!tBucket) continue;
			for (const t of tBucket) {
				if (seg.midLng < t.bbox[0] || seg.midLng > t.bbox[2] || seg.midLat < t.bbox[1] || seg.midLat > t.bbox[3]) {
					continue;
				}
				if (pointInGeometry(seg.midLng, seg.midLat, t.geometry)) {
					const cid = tractToClusterId.get(t.id);
					if (cid) {
						clusterById.get(cid).contextLines.push({
							id: seg.id,
							name: seg.name,
							between: seg.betweenLabel,
							line: seg.line
						});
					}
					break;
				}
			}
		}
	}

	// 5.5 Build citywide spatial index over ALL active blocks across ALL clusters
	// so users can walk continuously across cluster borders (stopping only at water/parks/dead ends!)
	const NAV_CELL = 0.004; // ~400m
	const navGrid = new Map();
	for (const c of clusterList) {
		const cid = c.props.id;
		const boro = c.props.borough;
		for (const seg of c.segments) {
			const gx = Math.floor(seg.midLng / NAV_CELL);
			const gy = Math.floor(seg.midLat / NAV_CELL);
			const k = `${gx},${gy}`;
			if (!navGrid.has(k)) navGrid.set(k, []);
			navGrid.get(k).push({
				clusterId: cid,
				borough: boro,
				seg,
				slug: slugify(seg.name)
			});
		}
	}

	function computeCitywideBlockNav(cid, boro, seg, slug, orderedLine) {
		if (!orderedLine || orderedLine.length < 2) return null;
		const lat0 = orderedLine[0][1];
		const lng0 = orderedLine[0][0];
		const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
		const ky = 111320;
		const toM = ([x, y]) => [(x - lng0) * kx, (y - lat0) * ky];

		const p0 = toM(orderedLine[0]);
		const p1 = toM(orderedLine[orderedLine.length - 1]);
		const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
		const flen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
		const fx = (p1[0] - p0[0]) / flen;
		const fy = (p1[1] - p0[1]) / flen;
		const tx = -fy; // Top sidewalk (Side A) normal
		const ty = fx;

		// Gather same-borough candidates within +-400m, deduplicating dividing segments (prefer staying in current cluster)
		const gx = Math.floor(seg.midLng / NAV_CELL);
		const gy = Math.floor(seg.midLat / NAV_CELL);
		const candMap = new Map();
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const bucket = navGrid.get(`${gx + dx},${gy + dy}`);
				if (!bucket) continue;
				for (const item of bucket) {
					if (item.seg.id === seg.id || item.borough !== boro) continue;
					const prev = candMap.get(item.seg.id);
					if (!prev || (item.clusterId === cid && prev.clusterId !== cid)) {
						candMap.set(item.seg.id, item);
					}
				}
			}
		}

		let left = null;
		let leftScore = Infinity;
		let right = null;
		let rightScore = Infinity;
		let up = null;
		let upScore = Infinity;
		let down = null;
		let downScore = Infinity;
		let turnLeft = null;
		let turnLeftDist = Infinity;
		let turnRight = null;
		let turnRightDist = Infinity;

		for (const cand of candMap.values()) {
			const oLine = cand.seg.line;
			if (!oLine || oLine.length < 2) continue;
			const o0 = toM(oLine[0]);
			const o1 = toM(oLine[oLine.length - 1]);
			const om = [(o0[0] + o1[0]) / 2, (o0[1] + o1[1]) / 2];
			const olen = Math.hypot(o1[0] - o0[0], o1[1] - o0[1]) || 1;
			const ox = (o1[0] - o0[0]) / olen;
			const oy = (o1[1] - o0[1]) / olen;
			const parallelDot = Math.abs(ox * fx + oy * fy);
			const sameStreet = cand.slug === slug;

			const dToP0 = Math.min(Math.hypot(o0[0] - p0[0], o0[1] - p0[1]), Math.hypot(o1[0] - p0[0], o1[1] - p0[1]));
			const dToP1 = Math.min(Math.hypot(o0[0] - p1[0], o0[1] - p1[1]), Math.hypot(o1[0] - p1[0], o1[1] - p1[1]));

			// 1) Left / Right continuation along the same street (or collinear street-name change at intersection)
			const dx = om[0] - mid[0];
			const dy = om[1] - mid[1];
			const along = dx * fx + dy * fy;
			const perp = dx * tx + dy * ty;
			const absPerp = Math.abs(perp);

			if (along < -15 && absPerp <= 52 && parallelDot >= 0.6) {
				if ((sameStreet && dToP0 <= 360) || (!sameStreet && dToP0 <= 32)) {
					const score = dToP0 + absPerp * 1.5 + (sameStreet ? 0 : 80);
					if (score < leftScore) {
						leftScore = score;
						left = cand;
					}
				}
			}
			if (along > 15 && absPerp <= 52 && parallelDot >= 0.6) {
				if ((sameStreet && dToP1 <= 360) || (!sameStreet && dToP1 <= 32)) {
					const score = dToP1 + absPerp * 1.5 + (sameStreet ? 0 : 80);
					if (score < rightScore) {
						rightScore = score;
						right = cand;
					}
				}
			}

			// 2) Cross-street turns touching left (p0) or right (p1) intersection
			if (!sameStreet && parallelDot < 0.55) {
				if (dToP0 <= 28 && dToP0 < turnLeftDist) {
					turnLeftDist = dToP0;
					turnLeft = cand;
				}
				if (dToP1 <= 28 && dToP1 < turnRightDist) {
					turnRightDist = dToP1;
					turnRight = cand;
				}
			}

			// 3) Up / Down parallel step (Top / Bottom sidewalk direction within 360m)
			const dist = Math.hypot(dx, dy);
			if (!sameStreet && dist >= 25 && dist <= 360) {
				if (perp >= 35 && Math.abs(along) <= Math.max(140, perp * 0.95)) {
					const score = perp + Math.abs(along) * 1.4 + (parallelDot >= 0.55 ? 0 : 220);
					if (score < upScore) {
						upScore = score;
						up = cand;
					}
				}
				if (perp <= -35 && Math.abs(along) <= Math.max(140, Math.abs(perp) * 0.95)) {
					const score = Math.abs(perp) + Math.abs(along) * 1.4 + (parallelDot >= 0.55 ? 0 : 220);
					if (score < downScore) {
						downScore = score;
						down = cand;
					}
				}
			}
		}

		const pack = (c) =>
			c
				? {
						clusterId: c.clusterId,
						segId: c.seg.id,
						streetName: c.seg.name,
						between: c.seg.betweenLabel
					}
				: null;

		return {
			up: pack(up),
			down: pack(down),
			left: pack(left),
			right: pack(right),
			turnLeft: pack(turnLeft),
			turnRight: pack(turnRight)
		};
	}

	// 6. Write per-cluster JSON shards (static/data/clusters/c-1.json, ...)
	fs.rmSync(SHARD_DIR, { recursive: true, force: true });
	fs.mkdirSync(SHARD_DIR, { recursive: true });

	for (const c of clusterList) {
		const cid = c.props.id;
		const gridAngleDeg = computeGridAngleDeg(c.props, c.segments);
		const rad = (gridAngleDeg * Math.PI) / 180;
		const cosA = Math.cos(rad);
		const sinA = Math.sin(rad);

		// Neighboring clusters for hop links
		const borderMap = new Map();
		for (const [nbRegId] of c.rawNeighbors.entries()) {
			const nb = clusterByRegId.get(nbRegId);
			if (!nb || nb.props.id === cid) continue;
			borderMap.set(nb.props.id, {
				id: nb.props.id,
				name: nb.props.name,
				vacancy_rate: nb.props.vacancy_rate,
				vacant_storefronts: nb.props.vacant_storefronts,
				total_storefronts: nb.props.total_storefronts,
				tier: nb.props.tier,
				center: nb.props.center,
				sharedStreets: new Set()
			});
		}

		// Group segments by street to compute prevSegId / nextSegId along each street!
		const byStreet = new Map();
		for (const seg of c.segments) {
			const slug = slugify(seg.name);
			if (!byStreet.has(slug)) byStreet.set(slug, []);
			byStreet.get(slug).push(seg);
		}

		const prevNextMap = new Map();
		const streetsList = [];

		for (const [slug, list] of byStreet.entries()) {
			// Sort along the straightened street axis (West->East for horizontal, South->North for vertical)
			const sample = list[0];
			const rdx = sample.dx * cosA - sample.dy * sinA;
			const rdy = sample.dx * sinA + sample.dy * cosA;
			const isHoriz = Math.abs(rdx) >= Math.abs(rdy);

			list.sort((a, b) => {
				const [ax, ay] = toXY(a.midLng, a.midLat);
				const [bx, by] = toXY(b.midLng, b.midLat);
				const rax = ax * cosA - ay * sinA;
				const ray = ax * sinA + ay * cosA;
				const rbx = bx * cosA - by * sinA;
				const rby = bx * sinA + by * cosA;
				return isHoriz ? rax - rbx : ray - rby;
			});

			for (let i = 0; i < list.length; i++) {
				prevNextMap.set(list[i].id, {
					prevSegId: i > 0 ? list[i - 1].id : null,
					prevBetween: i > 0 ? list[i - 1].betweenLabel : null,
					nextSegId: i < list.length - 1 ? list[i + 1].id : null,
					nextBetween: i < list.length - 1 ? list[i + 1].betweenLabel : null,
					isHoriz
				});
			}

			const tot = list.reduce((s, x) => s + x.total, 0);
			const vac = list.reduce((s, x) => s + x.vacant, 0);
			streetsList.push({
				slug,
				name: sample.name,
				isHoriz,
				rate: Math.round((vac / tot) * 10000) / 10000,
				vacant: vac,
				total: tot,
				segmentIds: list.map((x) => x.id)
			});
		}

		streetsList.sort((a, b) => b.total - a.total || b.rate - a.rate);
		c.props.street_count = streetsList.length;
		c.props.segment_count = c.segments.length;

		// 4-bucket 1-block distribution: [0%, 1-14%, 15-29%, 30%+]
		const bZero = c.segments.filter((s) => s.vacant === 0).length;
		const bLow = c.segments.filter((s) => s.vacant > 0 && s.rate < 0.15).length;
		const bMid = c.segments.filter((s) => s.rate >= 0.15 && s.rate < 0.30).length;
		const bHigh = c.segments.filter((s) => s.rate >= 0.30).length;
		c.props.block_dist = [bZero, bLow, bMid, bHigh];

		// Compute true N/S/W/E street borders & perimeter edge callouts for Level 1 city map hover
		const { borders, edge_labels } = computeClusterBorders(c, gridAngleDeg, segGrid);
		c.props.borders = borders;
		c.props.edge_labels = edge_labels;

		// Build full per-segment details (both for the Level 2 SVG Grid AND Level 3 IRL Block View!)
		const segmentsList = [];
		const segmentDetails = {};

		for (const seg of c.segments) {
			const slug = slugify(seg.name);
			const nav = prevNextMap.get(seg.id) || {
				prevSegId: null,
				prevBetween: null,
				nextSegId: null,
				nextBetween: null,
				isHoriz: seg.isEastWest
			};
			const otherClusterIds = [...seg.clusterIds].filter((id) => id !== cid);
			for (const oc of otherClusterIds) {
				if (borderMap.has(oc)) borderMap.get(oc).sharedStreets.add(seg.name);
			}

			// Orient segment line consistently West->East (for horizontal) or South->North (for vertical)
			const [sx, sy] = toXY(seg.start[0], seg.start[1]);
			const [ex, ey] = toXY(seg.end[0], seg.end[1]);
			const rsx = sx * cosA - sy * sinA;
			const rsy = sx * sinA + sy * cosA;
			const rex = ex * cosA - ey * sinA;
			const rey = ex * sinA + ey * cosA;
			const flip = nav.isHoriz ? rsx > rex : rsy > rey;
			const orderedLine = flip ? [...seg.line].reverse() : seg.line;
			const endA = flip ? seg.crossB : seg.crossA; // West or South cross-street
			const endB = flip ? seg.crossA : seg.crossB; // East or North cross-street

			const sideLabels = nav.isHoriz ? ['North', 'South'] : ['West', 'East'];
			const dividingClusters = otherClusterIds
				.map((ocId) => clusterById.get(ocId)?.props)
				.filter(Boolean)
				.map((p) => ({ id: p.id, name: p.name, vacancy_rate: p.vacancy_rate }));

			const prev24 = segPrev2024.get(seg.id);
			const prevTotal = prev24?.total || 0;
			const prevVacant = prev24?.vacant || 0;
			const prevRate = prevTotal >= 2 ? Math.round((prevVacant / prevTotal) * 10000) / 10000 : null;
			const yoyChange =
				prevRate !== null && seg.total >= 2
					? Math.round((seg.rate - prevRate) * 10000) / 10000
					: null;
			const vacantDelta = prevTotal >= 2 ? seg.vacant - prevVacant : null;

			segmentsList.push({
				id: seg.id,
				streetSlug: slug,
				streetName: seg.name,
				between: seg.betweenLabel,
				endA: endA || '',
				endB: endB || '',
				isHoriz: nav.isHoriz,
				rate: seg.rate,
				vacant: seg.vacant,
				total: seg.total,
				prevRate,
				prevVacant,
				prevTotal,
				yoyChange,
				vacantDelta,
				isDividing: otherClusterIds.length > 0,
				line: orderedLine
			});

			const cityNav = computeCitywideBlockNav(cid, c.props.borough, seg, slug, orderedLine);

			segmentDetails[seg.id] = {
				id: seg.id,
				streetSlug: slug,
				streetName: seg.name,
				between: seg.betweenLabel,
				endA: endA || '',
				endB: endB || '',
				isHoriz: nav.isHoriz,
				sideLabels,
				lengthM: seg.lengthM,
				rate: seg.rate,
				vacant: seg.vacant,
				total: seg.total,
				prevRate,
				prevVacant,
				prevTotal,
				yoyChange,
				vacantDelta,
				isDividing: otherClusterIds.length > 0,
				dividingClusters,
				line: orderedLine,
				center: [seg.midLng, seg.midLat],
				prevSegId: nav.prevSegId,
				prevBetween: nav.prevBetween,
				nextSegId: nav.nextSegId,
				nextBetween: nav.nextBetween,
				nav: cityNav,
				storefronts: seg.storefronts.map(({ tractId: _t, ...rest }) => rest)
			};
		}

		const borderClusters = [...borderMap.values()]
			.map((b) => ({
				...b,
				sharedStreets: [...b.sharedStreets].slice(0, 3)
			}))
			.sort((a, b) => Math.abs(b.vacancy_rate - c.props.vacancy_rate) - Math.abs(a.vacancy_rate - c.props.vacancy_rate));

		const tractRates = (c.tracts || [])
			.map((t) => ({
				id: t.id,
				rate: Math.round((t.vacant / Math.max(1, t.total)) * 10000) / 10000,
				ebRate: Math.round(t.ebRate * 10000) / 10000,
				vacant: t.vacant,
				total: t.total
			}))
			.sort((a, b) => a.rate - b.rate);

		const shard = {
			cluster: c.props,
			gridAngleDeg,
			geometry: c.geometry,
			tractRates,
			borderClusters,
			streetsList,
			segments: segmentsList,
			contextLines: c.contextLines.slice(0, 350),
			segmentDetails
		};

		fs.writeFileSync(path.join(SHARD_DIR, `${cid}.json`), JSON.stringify(shard));
	}

	// 7. Write Level 1 City Clusters GeoJSON
	const hotCount = clusterList.filter((c) => c.props.tier === 'hot').length;
	const steadyCount = clusterList.filter((c) => c.props.tier === 'steady').length;
	const thrivingCount = clusterList.filter((c) => c.props.tier === 'thriving').length;
	const improvingCount = clusterList.filter((c) => c.props.yoy_change !== null && c.props.yoy_change <= -0.01).length;
	const worseningCount = clusterList.filter((c) => c.props.yoy_change !== null && c.props.yoy_change >= 0.01).length;
	const crossingCount = clusterList.filter((c) => c.props.crossed_nta_count >= 2).length;
	const avgComp = clusterList.reduce((s, c) => s + c.props.compactness, 0) / Math.max(1, clusterList.length);

	const clustersOut = {
		syncedAt: new Date().toISOString(),
		meta: {
			source: 'NYC DOF 2021–2025 Geocoded Storefronts (92iy-9c3n) + NYC Street Centerlines (inkn-q76z) + PLUTO (64uk-42ks)',
			totalStorefronts: answeredTotal,
			vacantStorefronts: answeredVacant,
			citywideRate: Math.round(cityRate * 10000) / 10000,
			dofHistory,
			segmentCount: activeSegmentCount,
			dividingSegmentCount,
			taxBlockCount: allTaxBlocks.size,
			clusterCount: clusterList.length,
			hotCount,
			steadyCount,
			thrivingCount,
			improvingCount,
			worseningCount,
			crossingNtaCount: crossingCount,
			avgCompactness: Math.round(avgComp * 100) / 100
		},
		clusters: {
			type: 'FeatureCollection',
			features: clusterList.map((c) => ({
				type: 'Feature',
				id: c.props.id,
				properties: c.props,
				geometry: c.geometry
			}))
		}
	};

	fs.writeFileSync(path.join(OUT_DIR, 'nyc-clusters.json'), JSON.stringify(clustersOut));

	console.log('\n=== STRAIGHTENED GRID + IRL BLOCK SHARDS BUILT ===');
	console.log(`Clusters: ${clusterList.length} | Active Street Blocks: ${activeSegmentCount.toLocaleString()} (${dividingSegmentCount} dividing)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
