import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import type {
	BlockLot,
	BlockLotKind,
	BlockLotsResponse,
	ClusterShard,
	SegmentDetail,
	StorefrontItem
} from '$lib/types';

interface MapPlutoProps {
	BBL?: number | string;
	Address?: string;
	LotFront?: number | string;
	LotDepth?: number | string;
	NumFloors?: number | string;
	UnitsRes?: number | string;
	YearBuilt?: number | string;
	BldgClass?: string;
	LandUse?: string | number;
}

interface GeoJsonPolygonFeature {
	type: 'Feature';
	properties: MapPlutoProps;
	geometry:
		| { type: 'Polygon'; coordinates: number[][][] }
		| { type: 'MultiPolygon'; coordinates: number[][][][] }
		| null;
}

interface ProjectedPoly {
	bbl: string;
	props: MapPlutoProps;
	/** Local-meter outer & inner rings for point-in-polygon tests */
	ringsM: [number, number][][];
	/** Flattened boundary edges [x1, y1, x2, y2] in local meters */
	edgesM: [number, number, number, number][];
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	centroidLat: number;
	centroidLng: number;
}

const ORDINAL_WORDS: Record<string, string> = {
	FIRST: '1st',
	SECOND: '2nd',
	THIRD: '3rd',
	FOURTH: '4th',
	FIFTH: '5th',
	SIXTH: '6th',
	SEVENTH: '7th',
	EIGHTH: '8th',
	NINTH: '9th',
	TENTH: '10th',
	ELEVENTH: '11th',
	TWELFTH: '12th'
};

function addOrdinal(n: string): string {
	const v = parseInt(n, 10);
	if (Number.isNaN(v)) return n;
	const mod100 = v % 100;
	if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
	const m = v % 10;
	if (m === 1) return `${v}st`;
	if (m === 2) return `${v}nd`;
	if (m === 3) return `${v}rd`;
	return `${v}th`;
}

function cleanStreetName(raw: string): string {
	let s = raw.trim().toUpperCase().replace(/\s+/g, ' ');
	if (!s) return '';
	s = s.replace(/\bAVE(?:NUE)?\.?\s+OF\s+THE\s+AMER(?:ICAS)?\.?\b/g, '6TH AVE');
	s = s.replace(/\bWEST\s+(?=\d)/g, 'W ');
	s = s.replace(/\bEAST\s+(?=\d)/g, 'E ');
	s = s.replace(/\bNORTH\s+(?=\d)/g, 'N ');
	s = s.replace(/\bSOUTH\s+(?=\d)/g, 'S ');
	s = s.replace(/\bSTREET\b/g, 'ST');
	s = s.replace(/\bAVENUE\b/g, 'AVE');
	s = s.replace(/\bBOULEVARD\b/g, 'BLVD');
	s = s.replace(/\bPLACE\b/g, 'PL');
	s = s.replace(/\bROAD\b/g, 'RD');
	s = s.replace(/\bDRIVE\b/g, 'DR');
	s = s.replace(/\bPARKWAY\b/g, 'PKWY');
	s = s.replace(/\bSQUARE\b/g, 'SQ');
	s = s.replace(/\bTERRACE\b/g, 'TER');

	for (const [word, ord] of Object.entries(ORDINAL_WORDS)) {
		s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), ord.toUpperCase());
	}
	s = s.replace(/\b(\d{1,3})\s+(ST|AVE|PL|RD|DR|BLVD)\b/g, (_, n, suf) => `${addOrdinal(n).toUpperCase()} ${suf}`);
	return s;
}

function normalizeStreetKey(raw: string): string {
	return cleanStreetName(raw).replace(/[^A-Z0-9]/g, '');
}

function dedupeAddress(raw: string): string {
	const s = (raw || '').trim().replace(/\s+/g, ' ');
	if (!s) return '';
	const words = s.split(' ');
	if (words.length >= 4 && words.length % 2 === 0) {
		const half = words.length / 2;
		const a = words.slice(0, half).join(' ');
		const b = words.slice(half).join(' ');
		if (a.toLowerCase() === b.toLowerCase()) return a;
	}
	return s;
}

function cleanHouseNum(raw: string, fallbackAddr: string): string {
	const m = (raw || '').trim().match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)/i);
	if (m) return m[1];
	const m2 = (fallbackAddr || '').trim().match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)/i);
	return m2 ? m2[1] : (raw || '').trim();
}

function parsePlutoAddress(raw: string): { houseNum: string; streetPart: string; display: string } {
	const trimmed = (raw || '').trim().replace(/\s+/g, ' ');
	const m = trimmed.match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)\s+(.+)$/i);
	const houseNum = m ? m[1] : '';
	const streetPart = m ? m[2] : trimmed;

	const cleaned = cleanStreetName(streetPart)
		.toLowerCase()
		.replace(/\b([a-z])/g, (c) => c.toUpperCase())
		.replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_, n, s) => `${n}${s.toLowerCase()}`);

	return {
		houseNum,
		streetPart,
		display: houseNum ? `${houseNum} ${cleaned}` : cleaned || 'Unnumbered Lot'
	};
}

function landUseInfo(rawLanduse: string | number | undefined, bldgclass: string): { kind: BlockLotKind; label: string } {
	// MapPLUTO ArcGIS pads landuse as '01'..'11'; strip leading zero
	const luNum = parseInt(String(rawLanduse ?? ''), 10);
	const landuse = Number.isFinite(luNum) ? String(luNum) : '';
	const bc = (bldgclass || '').toUpperCase();
	if (bc.startsWith('Q') || landuse === '9') return { kind: 'park', label: 'Park / Open Space' };
	if (landuse === '8' || /^[MWNP]/.test(bc)) return { kind: 'civic', label: 'Civic / Institutional' };
	if (landuse === '1') return { kind: 'residential', label: '1–2 Family Residential' };
	if (landuse === '2') return { kind: 'residential', label: 'Multi-Family Walk-Up' };
	if (landuse === '3') return { kind: 'residential', label: 'Elevator Apartment' };
	if (landuse === '4') return { kind: 'residential', label: 'Mixed Res / Comm' };
	if (landuse === '5') return { kind: 'commercial', label: 'Commercial / Office' };
	if (landuse === '6' || landuse === '7') return { kind: 'other', label: 'Industrial / Utility' };
	if (landuse === '10') return { kind: 'other', label: 'Parking / Garage' };
	if (landuse === '11') return { kind: 'other', label: 'Vacant Lot' };
	return { kind: 'residential', label: 'Building' };
}

function normalizeBbl(raw: unknown): string {
	if (raw === null || raw === undefined) return '';
	if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.round(raw));
	const s = String(raw).split('.')[0].trim();
	return /^\d{10}$/.test(s) ? s : '';
}

/** Ray from P=(px,py) in unit direction D=(dx,dy) vs segment AB=(ax,ay)->(bx,by). Returns distance >= 0 or Infinity. */
function raySegDist(
	px: number,
	py: number,
	dx: number,
	dy: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const vx = bx - ax;
	const vy = by - ay;
	const denom = dx * vy - dy * vx;
	if (Math.abs(denom) < 1e-10) return Infinity;
	const qx = ax - px;
	const qy = ay - py;
	const tRay = (qx * vy - qy * vx) / denom;
	const uSeg = (qx * dy - qy * dx) / denom;
	if (tRay >= 0 && uSeg >= 0 && uSeg <= 1) return tRay;
	return Infinity;
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0];
		const yi = ring[i][1];
		const xj = ring[j][0];
		const yj = ring[j][1];
		const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function pointInPoly(x: number, y: number, poly: ProjectedPoly): boolean {
	if (x < poly.minX || x > poly.maxX || y < poly.minY || y > poly.maxY) return false;
	for (const ring of poly.ringsM) {
		if (pointInRing(x, y, ring)) return true;
	}
	return false;
}

function projectToPolyline(
	lng: number,
	lat: number,
	line: [number, number][],
	lat0: number,
	lng0: number
): { t: number; perpM: number; totalLenM: number } {
	const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
	const ky = 111320;
	const qx = (lng - lng0) * kx;
	const qy = (lat - lat0) * ky;

	const pts = line.map(([x, y]) => [(x - lng0) * kx, (y - lat0) * ky] as [number, number]);
	let totalLen = 0;
	const segLens: number[] = [];
	for (let i = 0; i < pts.length - 1; i++) {
		const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
		segLens.push(d);
		totalLen += d;
	}
	if (totalLen < 1) return { t: 0.5, perpM: 0, totalLenM: 1 };

	let bestDist2 = Infinity;
	let bestAlong = 0;
	let bestSignedPerp = 0;
	let accum = 0;

	for (let i = 0; i < pts.length - 1; i++) {
		const ax = pts[i][0];
		const ay = pts[i][1];
		const bx = pts[i + 1][0];
		const by = pts[i + 1][1];
		const vx = bx - ax;
		const vy = by - ay;
		const l2 = vx * vx + vy * vy;
		const segLen = segLens[i];
		if (l2 < 1e-6) continue;

		const rawU = ((qx - ax) * vx + (qy - ay) * vy) / l2;
		const u = Math.max(0, Math.min(1, rawU));
		const px = ax + u * vx;
		const py = ay + u * vy;
		const dist2 = (qx - px) ** 2 + (qy - py) ** 2;

		if (dist2 < bestDist2) {
			bestDist2 = dist2;
			bestAlong = accum + rawU * segLen;
			const cross = vx * (qy - ay) - vy * (qx - ax);
			bestSignedPerp = cross / segLen;
		}
		accum += segLen;
	}

	return {
		t: bestAlong / totalLen,
		perpM: bestSignedPerp,
		totalLenM: totalLen
	};
}

interface HitRun {
	bbl: string;
	poly: ProjectedPoly;
	s0: number;
	s1: number;
	count: number;
	minDist: number;
}

/**
 * Group per-station ray hits along one side into clean non-overlapping lot intervals.
 * Merges 1-station micro-gaps of the same BBL; if a BBL appears in disjoint intervals separated by another lot,
 * keeps its longest run.
 */
function extractRuns(
	hits: Array<{ bbl: string; poly: ProjectedPoly; dist: number } | null>,
	storefrontBbls: Set<string>
): HitRun[] {
	const N = hits.length;
	// 1) Bridge single-sample null gaps between identical BBLs (e.g., exact vertex hit miss)
	const smoothed = [...hits];
	for (let i = 1; i < N - 1; i++) {
		if (!smoothed[i] && smoothed[i - 1] && smoothed[i + 1] && smoothed[i - 1]!.bbl === smoothed[i + 1]!.bbl) {
			smoothed[i] = smoothed[i - 1];
		}
	}

	// 2) Collect contiguous runs
	const rawRuns: HitRun[] = [];
	let cur: HitRun | null = null;
	for (let s = 0; s < N; s++) {
		const h = smoothed[s];
		if (!h) {
			if (cur) {
				rawRuns.push(cur);
				cur = null;
			}
			continue;
		}
		if (cur && cur.bbl === h.bbl) {
			cur.s1 = s;
			cur.count++;
			if (h.dist < cur.minDist) cur.minDist = h.dist;
		} else {
			if (cur) rawRuns.push(cur);
			cur = { bbl: h.bbl, poly: h.poly, s0: s, s1: s, count: 1, minDist: h.dist };
		}
	}
	if (cur) rawRuns.push(cur);

	// 3) Drop 1-sample corner grazes unless that lot owns a DOF storefront on this segment
	const filtered = rawRuns.filter((r) => r.count >= 2 || storefrontBbls.has(r.bbl));

	// 4) For each BBL, always keep its longest run PLUS any additional genuine wing (>= 4 stations, ~15+ ft)
	//    so U-shaped / wrap-around superblocks (e.g. Penn South wrapping around 315 W 23rd St) fill the entire block!
	const maxCountByBbl = new Map<string, number>();
	for (const r of filtered) {
		const prev = maxCountByBbl.get(r.bbl) || 0;
		if (r.count > prev) maxCountByBbl.set(r.bbl, r.count);
	}
	const kept = filtered.filter((r) => r.count >= 4 || r.count === maxCountByBbl.get(r.bbl));

	return kept.sort((a, b) => a.s0 - b.s0);
}

/**
 * Survey-grade 1D Curb Raycast against real NYC MapPLUTO Tax Lot Polygons.
 * Eliminates every centroid / lotfront / corner / through-block / condo heuristic:
 * casts perpendicular rays every ~0.5% along the street centerline to both curbs and records
 * the exact tax lot polygon touched at each station.
 */
function buildBlockLotsFromPolygons(
	clusterId: string,
	seg: SegmentDetail,
	features: GeoJsonPolygonFeature[],
	plutoLoaded: boolean
): BlockLotsResponse {
	const line = seg.line;
	const lat0 = line.reduce((s, p) => s + p[1], 0) / line.length;
	const lng0 = line.reduce((s, p) => s + p[0], 0) / line.length;
	const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
	const ky = 111320;
	const targetStreetKey = normalizeStreetKey(seg.streetName);
	const endAKey = normalizeStreetKey(seg.endA || '');
	const endBKey = normalizeStreetKey(seg.endB || '');

	// 1. Project centerline to local meters
	const lPts = line.map(([x, y]) => [(x - lng0) * kx, (y - lat0) * ky] as [number, number]);
	const segLens: number[] = [];
	let totalLenM = 0;
	for (let i = 0; i < lPts.length - 1; i++) {
		const d = Math.hypot(lPts[i + 1][0] - lPts[i][0], lPts[i + 1][1] - lPts[i][1]);
		segLens.push(d);
		totalLenM += d;
	}
	if (totalLenM < 1) totalLenM = Math.max(seg.lengthM, 30);

	// 2. Project all MapPLUTO polygons to local meters + precompute bboxes
	const polys: ProjectedPoly[] = [];
	const polyByBbl = new Map<string, ProjectedPoly>();
	for (const feat of features) {
		if (!feat.geometry) continue;
		const bbl = normalizeBbl(feat.properties?.BBL);
		if (!bbl || polyByBbl.has(bbl)) continue;

		const rawRings: number[][][] =
			feat.geometry.type === 'Polygon'
				? feat.geometry.coordinates
				: feat.geometry.type === 'MultiPolygon'
					? feat.geometry.coordinates.flat()
					: [];
		if (rawRings.length === 0) continue;

		const ringsM: [number, number][][] = [];
		const edgesM: [number, number, number, number][] = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let sumLng = 0;
		let sumLat = 0;
		let ptCount = 0;

		for (let rIdx = 0; rIdx < rawRings.length; rIdx++) {
			const ring = rawRings[rIdx];
			if (ring.length < 3) continue;
			const rm: [number, number][] = [];
			for (let i = 0; i < ring.length; i++) {
				const lng = ring[i][0];
				const lat = ring[i][1];
				const mx = (lng - lng0) * kx;
				const my = (lat - lat0) * ky;
				rm.push([mx, my]);
				if (mx < minX) minX = mx;
				if (mx > maxX) maxX = mx;
				if (my < minY) minY = my;
				if (my > maxY) maxY = my;
				if (rIdx === 0 && i < ring.length - 1) {
					sumLng += lng;
					sumLat += lat;
					ptCount++;
				}
			}
			ringsM.push(rm);
			for (let i = 0; i < rm.length - 1; i++) {
				edgesM.push([rm[i][0], rm[i][1], rm[i + 1][0], rm[i + 1][1]]);
			}
		}

		if (edgesM.length === 0) continue;
		const poly: ProjectedPoly = {
			bbl,
			props: feat.properties,
			ringsM,
			edgesM,
			minX,
			minY,
			maxX,
			maxY,
			centroidLat: ptCount > 0 ? sumLat / ptCount : lat0,
			centroidLng: ptCount > 0 ? sumLng / ptCount : lng0
		};
		polys.push(poly);
		polyByBbl.set(bbl, poly);
	}

	// 3. Index DOF storefronts on this segment by 10-digit BBL
	const sfByBbl = new Map<string, StorefrontItem[]>();
	const sfUnmatched: StorefrontItem[] = [];
	for (const sf of seg.storefronts) {
		const bbl = normalizeBbl(sf.bbl);
		if (bbl) {
			if (!sfByBbl.has(bbl)) sfByBbl.set(bbl, []);
			sfByBbl.get(bbl)!.push(sf);
		} else {
			sfUnmatched.push(sf);
		}
	}
	const sfBblSet = new Set(sfByBbl.keys());

	// 3b. Detect mapped private streetbed parcels (e.g. Freedom Pl S / Riverside South roadbed lot 1011710274)
	// When a 0-floor / LandUse 11 ("Vacant Lot") polygon literally contains the street centerline across >=35% of stations,
	// it is the private roadbed underneath the street, not a building on either sidewalk — exclude it so rays hit the real towers!
	const centerlineHits = new Map<string, number>();
	const probeSteps = 20;
	for (let pIdx = 1; pIdx < probeSteps; pIdx++) {
		const target = (pIdx / probeSteps) * totalLenM;
		let acc = 0;
		let segIdx = 0;
		while (segIdx < segLens.length - 1 && acc + segLens[segIdx] < target) {
			acc += segLens[segIdx];
			segIdx++;
		}
		const segLen = segLens[segIdx] || 1;
		const frac = Math.max(0, Math.min(1, (target - acc) / segLen));
		const px = lPts[segIdx][0] + frac * (lPts[segIdx + 1][0] - lPts[segIdx][0]);
		const py = lPts[segIdx][1] + frac * (lPts[segIdx + 1][1] - lPts[segIdx][1]);
		for (const poly of polys) {
			if (pointInPoly(px, py, poly)) {
				centerlineHits.set(poly.bbl, (centerlineHits.get(poly.bbl) || 0) + 1);
			}
		}
	}
	const roadbedBbls = new Set<string>();
	for (const [bbl, hits] of centerlineHits.entries()) {
		if (hits >= Math.ceil(probeSteps * 0.35)) {
			const poly = polys.find((p) => p.bbl === bbl);
			const luCode = String(poly?.props.LandUse || '').trim();
			const floorsNum = Number(poly?.props.NumFloors) || 0;
			if (luCode === '11' || luCode === '07' || floorsNum === 0) {
				roadbedBbls.add(bbl);
			}
		}
	}
	const buildingPolys =
		roadbedBbls.size > 0 && polys.length > roadbedBbls.size
			? polys.filter((p) => !roadbedBbls.has(p.bbl))
			: polys;

	// 4. Cast perpendicular rays to Side A (left normal, perpM > 0) and Side B (right normal, perpM < 0)
	// Start 2.0m off the centerline and check point-in-polygon first so private/campus streetbeds
	// (e.g. Industry City 33rd St where lot lines meet right on the street centerline) resolve cleanly!
	const N = 200;
	const START_OFFSET_M = 2.0;
	const MAX_RAY_M = 45;
	const rawHitsA: Array<{ bbl: string; poly: ProjectedPoly; dist: number } | null> = new Array(N + 1).fill(null);
	const rawHitsB: Array<{ bbl: string; poly: ProjectedPoly; dist: number } | null> = new Array(N + 1).fill(null);

	for (let s = 0; s <= N; s++) {
		const target = (s / N) * totalLenM;
		let acc = 0;
		let segIdx = 0;
		while (segIdx < segLens.length - 1 && acc + segLens[segIdx] < target) {
			acc += segLens[segIdx];
			segIdx++;
		}
		const segLen = segLens[segIdx] || 1;
		const frac = Math.max(0, Math.min(1, (target - acc) / segLen));
		const ax = lPts[segIdx][0];
		const ay = lPts[segIdx][1];
		const bx = lPts[segIdx + 1][0];
		const by = lPts[segIdx + 1][1];
		const px = ax + frac * (bx - ax);
		const py = ay + frac * (by - ay);
		const tx = (bx - ax) / segLen;
		const ty = (by - ay) / segLen;

		// Side A = left normal (-ty, tx); Side B = right normal (ty, -tx)
		const dirs: [number, number, typeof rawHitsA][] = [
			[-ty, tx, rawHitsA],
			[ty, -tx, rawHitsB]
		];

		for (const [dx, dy, outArr] of dirs) {
			const ox = px + dx * START_OFFSET_M;
			const oy = py + dy * START_OFFSET_M;

			// 4a. Private streetbed / setback-zero lot check: is (ox, oy) already inside a tax lot polygon?
			let insidePoly: ProjectedPoly | null = null;
			for (const poly of buildingPolys) {
				if (pointInPoly(ox, oy, poly)) {
					insidePoly = poly;
					break;
				}
			}
			if (insidePoly) {
				outArr[s] = { bbl: insidePoly.bbl, poly: insidePoly, dist: START_OFFSET_M };
				continue;
			}

			// 4b. Standard public streetbed: cast ray outward to nearest curb polygon edge
			let bestDist = MAX_RAY_M;
			let bestPoly: ProjectedPoly | null = null;
			const endX = ox + dx * MAX_RAY_M;
			const endY = oy + dy * MAX_RAY_M;
			const rMinX = Math.min(ox, endX);
			const rMaxX = Math.max(ox, endX);
			const rMinY = Math.min(oy, endY);
			const rMaxY = Math.max(oy, endY);

			for (const poly of buildingPolys) {
				// Fast AABB rejection
				if (poly.maxX < rMinX || poly.minX > rMaxX || poly.maxY < rMinY || poly.minY > rMaxY) continue;
				for (const [ex1, ey1, ex2, ey2] of poly.edgesM) {
					const d = raySegDist(ox, oy, dx, dy, ex1, ey1, ex2, ey2);
					if (d < bestDist) {
						bestDist = d;
						bestPoly = poly;
					}
				}
			}
			if (bestPoly) {
				outArr[s] = { bbl: bestPoly.bbl, poly: bestPoly, dist: bestDist + START_OFFSET_M };
			}
		}
	}

	// 5. Adaptive curb-distance outlier filter per side:
	// prevents a diagonal intersection ray at s=0 or s=N from shooting down a cross-street into the next block
	for (const arr of [rawHitsA, rawHitsB]) {
		const midDists: number[] = [];
		for (let s = Math.floor(N * 0.2); s <= Math.ceil(N * 0.8); s++) {
			if (arr[s]) midDists.push(arr[s]!.dist);
		}
		if (midDists.length >= 5) {
			midDists.sort((a, b) => a - b);
			const medianCurb = midDists[Math.floor(midDists.length / 2)];
			const maxAllowed = Math.max(24, medianCurb * 1.85);
			for (let s = 0; s <= N; s++) {
				if (arr[s] && arr[s]!.dist > maxAllowed) {
					arr[s] = null;
				}
			}
		}
	}

	const runsA = extractRuns(rawHitsA, sfBblSet);
	const runsB = extractRuns(rawHitsB, sfBblSet);

	// 6. Compute exact shared building-line-to-building-line span across BOTH sides!
	// Cross-street asphalt naturally has zero polygon hits, so [minHitS, maxHitS] maps corners flush to [0, 1].
	let minHitS = Infinity;
	let maxHitS = -Infinity;
	for (const r of [...runsA, ...runsB]) {
		if (r.s0 < minHitS) minHitS = r.s0;
		if (r.s1 > maxHitS) maxHitS = r.s1;
	}
	if (!Number.isFinite(minHitS) || !Number.isFinite(maxHitS) || maxHitS <= minHitS) {
		minHitS = 0;
		maxHitS = N;
	}
	const spanStart = minHitS - 0.5;
	const spanEnd = maxHitS + 0.5;
	const spanLen = Math.max(1, spanEnd - spanStart);

	// 7. Attach DOF storefronts to hit polygons keyed by (side, bbl, s0) so neither multi-side nor U-shaped multi-wing lots ever duplicate storefronts!
	const usedSfBbls = new Set<string>();
	const attachedSfByRunKey = new Map<string, StorefrontItem[]>();
	const runKey = (side: 'A' | 'B', run: HitRun) => `${side}:${run.bbl}:${run.s0}`;
	const attachToRun = (side: 'A' | 'B', run: HitRun, items: StorefrontItem[]) => {
		const k = runKey(side, run);
		attachedSfByRunKey.set(k, [...(attachedSfByRunKey.get(k) || []), ...items]);
	};

	const allHitRuns: Array<{ run: HitRun; side: 'A' | 'B' }> = [
		...runsA.map((run) => ({ run, side: 'A' as const })),
		...runsB.map((run) => ({ run, side: 'B' as const }))
	];

	// Pass 1: Direct 10-digit BBL match (each storefront assigned strictly once!)
	for (const [sfBbl, sfs] of sfByBbl.entries()) {
		const matchingRuns = allHitRuns.filter(({ run }) => run.bbl === sfBbl);
		if (matchingRuns.length === 0) continue;
		if (matchingRuns.length === 1) {
			attachToRun(matchingRuns[0].side, matchingRuns[0].run, sfs);
		} else {
			// Super-lot spanning multiple wings or both sides: assign each storefront to its nearest matching run on its side
			for (const sf of sfs) {
				const sfSide: 'A' | 'B' = sf.side === seg.sideLabels[0] ? 'A' : 'B';
				const sameSideRuns = matchingRuns.filter((m) => m.side === sfSide);
				const pool = sameSideRuns.length > 0 ? sameSideRuns : matchingRuns;
				const sfStation = projectToPolyline(sf.lng, sf.lat, line, lat0, lng0).t * N;
				let best = pool[0];
				let bestDist = Infinity;
				for (const m of pool) {
					const d = sfStation < m.run.s0 ? m.run.s0 - sfStation : sfStation > m.run.s1 ? sfStation - m.run.s1 : 0;
					if (d < bestDist) {
						bestDist = d;
						best = m;
					}
				}
				attachToRun(best.side, best.run, [sf]);
			}
		}
		usedSfBbls.add(sfBbl);
	}

	// Pass 2: Condo unit BBLs (e.g. 1007291401 -> billing lot 1007297505) & sidewalk-geocoded storefronts
	for (const [sfBbl, sfs] of sfByBbl.entries()) {
		if (usedSfBbls.has(sfBbl)) continue;
		const first = sfs[0];
		const sfSide: 'A' | 'B' = first.side === seg.sideLabels[0] ? 'A' : 'B';
		const qx = (first.lng - lng0) * kx;
		const qy = (first.lat - lat0) * ky;
		const sfProj = projectToPolyline(first.lng, first.lat, line, lat0, lng0);
		const sfStation = sfProj.t * N;
		const sfBlock = sfBbl.slice(0, 6);
		const sfNum = cleanHouseNum(first.num, first.address);

		// 1) Exact point-in-polygon on the same side
		let matchedRun = allHitRuns.find(({ run, side }) => side === sfSide && pointInPoly(qx, qy, run.poly));
		// 2) Same tax block + same house number on the same side
		if (!matchedRun) {
			matchedRun = allHitRuns.find(({ run, side }) => {
				if (side !== sfSide || run.bbl.slice(0, 6) !== sfBlock) return false;
				const parsed = parsePlutoAddress(run.poly.props.Address || '');
				return Boolean(sfNum && parsed.houseNum && sfNum === parsed.houseNum);
			});
		}
		// 3) Same tax block covering this storefront's along-street station on the same side (e.g. Manhattan West condo billing lots)
		if (!matchedRun) {
			matchedRun = allHitRuns.find(
				({ run, side }) =>
					side === sfSide &&
					run.bbl.slice(0, 6) === sfBlock &&
					sfStation >= run.s0 - 3 &&
					sfStation <= run.s1 + 3
			);
		}
		// 4) Same tax block condo billing lot (lot >= 7500) on the same side
		if (!matchedRun) {
			matchedRun = allHitRuns.find(
				({ run, side }) =>
					side === sfSide &&
					run.bbl.slice(0, 6) === sfBlock &&
					parseInt(run.bbl.slice(6), 10) >= 7500
			);
		}
		// 5) Point-in-polygon on either side (rare DOF side-label typo)
		if (!matchedRun) {
			matchedRun = allHitRuns.find(({ run }) => pointInPoly(qx, qy, run.poly));
		}
		// 6) Curb-geocoded storefront falling directly inside a surveyed polygon's frontage span on the same side
		//    (prevents ever dropping an overlapping orphan box on top of an existing building!)
		if (!matchedRun) {
			matchedRun = allHitRuns.find(
				({ run, side }) => side === sfSide && sfStation >= run.s0 - 1 && sfStation <= run.s1 + 1
			);
		}
		if (matchedRun) {
			attachToRun(matchedRun.side, matchedRun.run, sfs);
			usedSfBbls.add(sfBbl);
		}
	}

	// 8. Build BlockLot records directly from the surveyed polygon hit runs
	function buildSideLots(runs: HitRun[], side: 'A' | 'B'): BlockLot[] {
		const out: BlockLot[] = [];
		const inset = 0.0012; // subtle hairline gap between adjacent buildings without altering real alignment

		for (let i = 0; i < runs.length; i++) {
			const run = runs[i];
			const p = run.poly.props;
			const parsed = parsePlutoAddress(p.Address || '');
			const streetKey = normalizeStreetKey(parsed.streetPart);
			const sameStreet = streetKey === targetStreetKey;
			const onCrossStreet = Boolean((endAKey && streetKey === endAKey) || (endBKey && streetKey === endBKey));

			const rawX0 = Math.max(0, Math.min(1, (run.s0 - 0.5 - spanStart) / spanLen));
			const rawX1 = Math.max(0, Math.min(1, (run.s1 + 0.5 - spanStart) / spanLen));
			// Snap outer corners within 15% of the block edge flush to 0% / 100%
			// (absorbs staggered wide-avenue building lines like Park Ave viaduct / Riverside Blvd plazas while keeping real half-block parks!)
			const snapLeft = i === 0 && rawX0 <= 0.15;
			const snapRight = i === runs.length - 1 && rawX1 >= 0.85;
			const x0 = snapLeft || rawX0 <= 0.004 ? 0 : rawX0 + inset;
			const x1 = snapRight || rawX1 >= 0.996 ? 1 : Math.max(x0 + 0.008, rawX1 - inset);
			const tMid = (x0 + x1) / 2;

			// True surveyed frontage along THIS street in feet!
			const surveyedFrontFt = Math.max(12, Math.round(((run.s1 - run.s0 + 1) / N) * totalLenM * 3.28084));
			const floors = Math.max(1, Math.round(Number(p.NumFloors) || 3));
			const unitsRes = Math.max(0, Math.round(Number(p.UnitsRes) || 0));
			const yb = parseInt(String(p.YearBuilt ?? '0'), 10);
			const yearBuilt = yb > 1750 && yb <= 2030 ? yb : null;
			const lu = landUseInfo(p.LandUse, p.BldgClass || '');

			const sfs = attachedSfByRunKey.get(runKey(side, run)) || [];
			const vacantCount = sfs.filter((s) => s.vacant).length;
			const occupiedCount = sfs.length - vacantCount;

			const baseLuLabel =
				sfs.length > 0 && lu.label === 'Vacant Lot' ? 'Commercial / Mixed' : lu.label;

			let kind: BlockLotKind = lu.kind;
			if (vacantCount > 0 && occupiedCount > 0) kind = 'mixed';
			else if (vacantCount > 0) kind = 'vacant';
			else if (occupiedCount > 0) kind = 'occupied';

			const isCorner = !sameStreet && (onCrossStreet || x0 <= 0.04 || x1 >= 0.96);
			const isThrough = !sameStreet && !isCorner;

			const matchingStreetSf = sfs.find(
				(s) => normalizeStreetKey(parsePlutoAddress(s.address).streetPart) === targetStreetKey
			);
			const rawDisplayAddr = sameStreet
				? matchingStreetSf?.address || parsed.display
				: matchingStreetSf?.address || sfs[0]?.address || parsed.display;
			const displayAddress = dedupeAddress(rawDisplayAddr);
			const displayNum = cleanHouseNum(
				sameStreet
					? matchingStreetSf?.num || parsed.houseNum
					: matchingStreetSf?.num || sfs[0]?.num || parsed.houseNum,
				displayAddress
			);

			out.push({
				id: `lot-${side}-${run.bbl}-${run.s0}`,
				bbl: run.bbl,
				address: displayAddress,
				houseNum: displayNum,
				side,
				sideLabel: side === 'A' ? seg.sideLabels[0] : seg.sideLabels[1],
				t: Number(tMid.toFixed(4)),
				x0: Number(x0.toFixed(4)),
				x1: Number(x1.toFixed(4)),
				frontFt: surveyedFrontFt,
				floors,
				unitsRes,
				yearBuilt,
				bldgClass: p.BldgClass || '',
				landUseLabel: isThrough
					? `${baseLuLabel} (Through-Block)`
					: isCorner
						? `${baseLuLabel} (Corner)`
						: baseLuLabel,
				kind,
				isCorner,
				vacantCount,
				occupiedCount,
				clusterId: sfs[0]?.clusterId || null,
				lat: Number(run.poly.centroidLat.toFixed(6)),
				lng: Number(run.poly.centroidLng.toFixed(6)),
				storefronts: sfs
			});
		}

		return out;
	}

	const sideA = buildSideLots(runsA, 'A');
	const sideB = buildSideLots(runsB, 'B');

	// 9. Guarantee 100% DOF tie-out: any DOF storefront still unmatched (e.g. MapPLUTO outage or interior lot) gets placed cleanly
	const orphanLotsA: BlockLot[] = [];
	const orphanLotsB: BlockLot[] = [];

	for (const [bbl, sfs] of sfByBbl.entries()) {
		if (usedSfBbls.has(bbl)) continue;
		const first = sfs[0];
		const proj = projectToPolyline(first.lng, first.lat, line, lat0, lng0);
		const side: 'A' | 'B' = first.side === seg.sideLabels[0] ? 'A' : 'B';
		const normT = Math.max(0.03, Math.min(0.97, (proj.t * N - spanStart) / spanLen));
		const halfW = 0.035;
		const vacantCount = sfs.filter((s) => s.vacant).length;
		const occupiedCount = sfs.length - vacantCount;
		const kind: BlockLotKind =
			vacantCount > 0 && occupiedCount > 0 ? 'mixed' : vacantCount > 0 ? 'vacant' : 'occupied';

		const lot: BlockLot = {
			id: `dof-${bbl}`,
			bbl,
			address: dedupeAddress(first.address),
			houseNum: cleanHouseNum(first.num, first.address),
			side,
			sideLabel: side === 'A' ? seg.sideLabels[0] : seg.sideLabels[1],
			t: Number(normT.toFixed(4)),
			x0: Number(Math.max(0, normT - halfW).toFixed(4)),
			x1: Number(Math.min(1, normT + halfW).toFixed(4)),
			frontFt: Math.min(80, Math.max(22, 20 + sfs.length * 6)),
			floors: 4,
			unitsRes: 0,
			yearBuilt: null,
			bldgClass: '',
			landUseLabel: 'Commercial Building',
			kind,
			isCorner: false,
			vacantCount,
			occupiedCount,
			clusterId: first.clusterId || null,
			lat: first.lat,
			lng: first.lng,
			storefronts: sfs
		};
		if (side === 'A') orphanLotsA.push(lot);
		else orphanLotsB.push(lot);
	}

	for (let idx = 0; idx < sfUnmatched.length; idx++) {
		const sf = sfUnmatched[idx];
		const proj = projectToPolyline(sf.lng, sf.lat, line, lat0, lng0);
		const side: 'A' | 'B' = sf.side === seg.sideLabels[0] ? 'A' : 'B';
		const normT = Math.max(0.03, Math.min(0.97, (proj.t * N - spanStart) / spanLen));
		const lot: BlockLot = {
			id: `dof-nobbl-${idx}`,
			bbl: '',
			address: dedupeAddress(sf.address),
			houseNum: cleanHouseNum(sf.num, sf.address),
			side,
			sideLabel: side === 'A' ? seg.sideLabels[0] : seg.sideLabels[1],
			t: Number(normT.toFixed(4)),
			x0: Number(Math.max(0, normT - 0.03).toFixed(4)),
			x1: Number(Math.min(1, normT + 0.03).toFixed(4)),
			frontFt: 25,
			floors: 4,
			unitsRes: 0,
			yearBuilt: null,
			bldgClass: '',
			landUseLabel: 'Commercial Storefront',
			kind: sf.vacant ? 'vacant' : 'occupied',
			isCorner: false,
			vacantCount: sf.vacant ? 1 : 0,
			occupiedCount: sf.vacant ? 0 : 1,
			clusterId: sf.clusterId || null,
			lat: sf.lat,
			lng: sf.lng,
			storefronts: [sf]
		};
		if (side === 'A') orphanLotsA.push(lot);
		else orphanLotsB.push(lot);
	}

	// If MapPLUTO failed completely (plutoLoaded=false), distribute orphan DOF cards cleanly without overlap
	function mergeOrphans(base: BlockLot[], orphans: BlockLot[]): BlockLot[] {
		if (orphans.length === 0) return base;
		if (base.length === 0) {
			const sorted = [...orphans].sort((a, b) => a.t - b.t);
			const w = Math.min(0.18, 0.96 / Math.max(1, sorted.length));
			return sorted.map((l, i) => {
				const cx = sorted.length === 1 ? l.t : (i + 0.5) / sorted.length;
				const x0 = Math.max(0, Math.min(1 - w, cx - w / 2));
				return { ...l, x0: Number(x0.toFixed(4)), x1: Number((x0 + w - 0.004).toFixed(4)) };
			});
		}
		return [...base, ...orphans].sort((a, b) => a.x0 - b.x0);
	}

	return {
		clusterId,
		segmentId: seg.id,
		plutoLoaded,
		plutoCount: features.length,
		sideA: mergeOrphans(sideA, orphanLotsA),
		sideB: mergeOrphans(sideB, orphanLotsB)
	};
}

const plutoCache = new Map<string, { at: number; data: BlockLotsResponse }>();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour in-isolate cache

export const GET: RequestHandler = async ({ url, fetch }) => {
	const clusterId = url.searchParams.get('cluster') || '';
	const segmentId = url.searchParams.get('segment') || '';

	if (!/^c-\d+$/.test(clusterId) || !/^seg-\d+$/.test(segmentId)) {
		throw error(400, 'Invalid cluster or segment identifier');
	}

	const cacheKey = `v10:${clusterId}:${segmentId}`;
	const cached = plutoCache.get(cacheKey);
	if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.data.plutoLoaded) {
		return json(cached.data, {
			headers: { 'Cache-Control': dev ? 'no-store' : 'public, max-age=3600, s-maxage=86400' }
		});
	}

	const shardRes = await fetch(`/data/clusters/${clusterId}.json`);
	if (!shardRes.ok) throw error(404, `Cluster ${clusterId} not found`);
	const shard: ClusterShard = await shardRes.json();

	const seg = shard.segmentDetails[segmentId];
	if (!seg) throw error(404, `Segment ${segmentId} not found in cluster ${clusterId}`);

	// Tight bounding envelope around the street centerline (~55m padding covers even 200ft boulevards)
	let minLng = Infinity;
	let maxLng = -Infinity;
	let minLat = Infinity;
	let maxLat = -Infinity;
	for (const [lng, lat] of seg.line) {
		if (lng < minLng) minLng = lng;
		if (lng > maxLng) maxLng = lng;
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
	}
	const padLat = 0.0005;
	const padLng = 0.00065;

	const mapPlutoUrl =
		'https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query?' +
		new URLSearchParams({
			geometry: `${minLng - padLng},${minLat - padLat},${maxLng + padLng},${maxLat + padLat}`,
			geometryType: 'esriGeometryEnvelope',
			inSR: '4326',
			spatialRel: 'esriSpatialRelIntersects',
			outFields: 'BBL,Address,LotFront,LotDepth,NumFloors,UnitsRes,YearBuilt,BldgClass,LandUse',
			geometryPrecision: '6',
			outSR: '4326',
			f: 'geojson'
		}).toString();

	let features: GeoJsonPolygonFeature[] = [];
	let plutoLoaded = false;

	for (let attempt = 0; attempt < 2 && !plutoLoaded; attempt++) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 7500);
			const pRes = await globalThis.fetch(mapPlutoUrl, {
				signal: controller.signal,
				headers: { Accept: 'application/json' }
			});
			clearTimeout(timer);
			if (pRes.ok) {
				const geo = await pRes.json();
				if (geo && Array.isArray(geo.features)) {
					features = geo.features;
					plutoLoaded = true;
				}
			}
		} catch {
			// Retry once on transient timeout/reset
		}
	}

	const payload = buildBlockLotsFromPolygons(clusterId, seg, features, plutoLoaded);
	if (plutoLoaded) {
		plutoCache.set(cacheKey, { at: Date.now(), data: payload });
	}

	return json(payload, {
		headers: {
			'Cache-Control': dev
				? 'no-store'
				: plutoLoaded
					? 'public, max-age=3600, s-maxage=86400'
					: 'public, max-age=60'
		}
	});
};
