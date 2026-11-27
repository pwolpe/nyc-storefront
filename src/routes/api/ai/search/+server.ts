import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ClustersFile, ClusterProps, ClusterShard, SegmentSummary } from '$lib/types';
import {
	callOpenRouter,
	extractJsonObject,
	getDefaultModel,
	getOpenRouterKey
} from '$lib/server/openrouter';

interface AiSearchResultItem {
	type: 'cluster' | 'block' | 'building';
	title: string;
	subtitle: string;
	badge?: string;
	tone?: 'hot' | 'steady' | 'thriving';
	href: string;
	reason: string;
}

interface AiSearchResponse {
	configured: boolean;
	answer: string;
	results: AiSearchResultItem[];
	error?: string;
}

const searchCache = new Map<string, { at: number; data: AiSearchResponse }>();
const CACHE_TTL_MS = 1000 * 60 * 30;
let cachedClusters: ClustersFile | null = null;
let cachedCatalogText = '';

function rateTone(r: number): 'hot' | 'steady' | 'thriving' {
	if (r >= 0.16) return 'hot';
	if (r >= 0.08) return 'steady';
	return 'thriving';
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

function normStreet(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/\bavenue of the americas\b/g, '6th ave')
		.replace(/\bstreet\b/g, 'st')
		.replace(/\bavenue\b/g, 'ave')
		.replace(/\bwest\b/g, 'w')
		.replace(/\beast\b/g, 'e')
		.replace(/[^a-z0-9]/g, '');
}

async function loadClusters(fetchFn: typeof fetch): Promise<{
	file: ClustersFile;
	catalog: string;
}> {
	if (cachedClusters && cachedCatalogText) {
		return { file: cachedClusters, catalog: cachedCatalogText };
	}
	const res = await fetchFn('/data/nyc-clusters.json');
	const file = (await res.json()) as ClustersFile;
	cachedClusters = file;

	const lines = file.clusters.features.map((f) => {
		const c = f.properties;
		const h21 = c.history?.find((h) => h.year === 2021);
		const d4 =
			h21 && h21.total >= 15 ? `${((c.vacancy_rate - h21.rate) * 100).toFixed(1)}` : 'na';
		const yoy =
			c.yoy_change !== null && c.yoy_change !== undefined
				? `${(c.yoy_change * 100).toFixed(1)}`
				: 'na';
		const streets = (c.top_streets || []).slice(0, 3).join(',');
		return `${c.id}|${c.borough}|${c.name}|${(c.vacancy_rate * 100).toFixed(1)}%|${c.vacant_storefronts}/${c.total_storefronts}|yoy:${yoy}|4y:${d4}|${streets}`;
	});
	cachedCatalogText = lines.join('\n');
	return { file, catalog: cachedCatalogText };
}

async function resolveAddressToTarget(
	addressQuery: string,
	clustersFile: ClustersFile,
	fetchFn: typeof fetch
): Promise<{
	href: string;
	type: 'building' | 'block' | 'cluster';
	label: string;
	subtitle: string;
} | null> {
	try {
		const res = await globalThis.fetch(
			`https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(addressQuery)}&size=1`
		);
		if (!res.ok) return null;
		const geo = await res.json();
		const feat = geo.features?.[0];
		if (!feat?.geometry?.coordinates) return null;

		const [lng, lat] = feat.geometry.coordinates as [number, number];
		const label = String(feat.properties?.name || addressQuery);
		const boro = String(feat.properties?.borough || '');
		const padBbl = String(feat.properties?.addendum?.pad?.bbl || '').replace(/\D/g, '');
		const streetNorm = normStreet(String(feat.properties?.street || ''));

		let hitCluster = clustersFile.clusters.features.find((f) => {
			const b = f.properties.bbox;
			if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return false;
			return pointInGeom(lng, lat, f.geometry);
		});
		if (!hitCluster) {
			let bestD = Infinity;
			for (const f of clustersFile.clusters.features) {
				const d = Math.hypot(f.properties.center[0] - lng, f.properties.center[1] - lat);
				if (d < bestD) {
					bestD = d;
					hitCluster = f;
				}
			}
		}
		if (!hitCluster) return null;

		const cid = hitCluster.properties.id;
		const shardRes = await fetchFn(`/data/clusters/${cid}.json`);
		if (shardRes.ok) {
			const shard = (await shardRes.json()) as ClusterShard;
			let bestSeg: SegmentSummary | null = null;
			let bestScore = Infinity;
			for (const seg of shard.segments) {
				const d = distToLine(lng, lat, seg.line);
				const segNorm = normStreet(seg.streetName);
				const sameStreet =
					streetNorm.length > 2 &&
					(segNorm === streetNorm || segNorm.includes(streetNorm) || streetNorm.includes(segNorm));
				const score = sameStreet ? d * 0.15 : d;
				if (score < bestScore) {
					bestScore = score;
					bestSeg = seg;
				}
			}
			if (bestSeg && bestScore < 0.0025) {
				if (/^[1-5]\d{9}$/.test(padBbl)) {
					return {
						href: `/cluster/${cid}/block/${bestSeg.id}/building/${padBbl}`,
						type: 'building',
						label,
						subtitle: `${bestSeg.streetName} (${bestSeg.between}) · ${boro || hitCluster.properties.borough}`
					};
				}
				return {
					href: `/cluster/${cid}/block/${bestSeg.id}`,
					type: 'block',
					label: `${bestSeg.streetName} (${bestSeg.between})`,
					subtitle: `${hitCluster.properties.name} · ${boro || hitCluster.properties.borough}`
				};
			}
		}
		return {
			href: `/cluster/${cid}`,
			type: 'cluster',
			label: hitCluster.properties.name,
			subtitle: hitCluster.properties.borough
		};
	} catch {
		return null;
	}
}

export const POST: RequestHandler = async ({ request, fetch, platform }) => {
	const apiKey = getOpenRouterKey(platform);
	if (!apiKey) {
		return json({
			configured: false,
			answer: '',
			results: []
		} satisfies AiSearchResponse);
	}

	let query = '';
	try {
		const body = (await request.json()) as { query?: string };
		query = (body.query || '').trim().slice(0, 180);
	} catch {
		return json({
			configured: true,
			answer: '',
			results: [],
			error: 'Invalid request'
		} satisfies AiSearchResponse);
	}

	if (query.length < 3) {
		return json({ configured: true, answer: '', results: [] } satisfies AiSearchResponse);
	}

	const cacheKey = query.toLowerCase();
	const hit = searchCache.get(cacheKey);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
		return json(hit.data);
	}

	try {
		const { file, catalog } = await loadClusters(fetch);
		const byId = new Map<string, ClusterProps>();
		for (const f of file.clusters.features) byId.set(f.properties.id, f.properties);

		const system = `You are the search brain for "NYC Storefront Vacancy", an interactive Swiss-editorial map of NYC's 349 commercial clusters (citywide DOF 2025 vacancy: ${(file.meta.citywideRate * 100).toFixed(2)}%, ${file.meta.vacantStorefronts}/${file.meta.totalStorefronts}).
Given a user's natural-language query, return STRICT JSON (no markdown) matching:
{
  "answer": "Crisp 1-sentence plain-English answer using exact figures from the catalog when applicable.",
  "picks": [
    { "id": "c-102", "reason": "Short 4-8 word reason (e.g. '24.1% vacant, +5.2 pts YoY')" }
  ],
  "places": [
    { "name": "Grand Sichuan (former)", "address": "229 9th Ave, Manhattan, NY", "reason": "Short 4-8 word context" }
  ]
}
Rules:
- Use "picks" (up to 5 cluster IDs that ACTUALLY exist in the catalog) for neighborhood, borough, trend, high-vacancy, low-vacancy, rebound, or street-corridor questions.
- Sort "picks" strictly in the order that best answers the question (e.g., highest vacancy first for "emptiest", most negative yoy/4y first for "rebound"/"improving", most positive yoy/4y first for "worsening", lowest rate first for "lively"/"full"). Prefer clusters with >=40 storefronts unless user asks about a tiny area.
- Use "places" (up to 2 specific NYC addresses) ONLY when the user names a specific restaurant, shop, landmark, or intersection (e.g. "Sushi Seki", "Grand Sichuan", "Washington Square Park"). Leave "places": [] otherwise.
- Never invent cluster IDs. Keep "answer" under 28 words.`;

		const userMsg = `Query: "${query}"

Catalog (id|borough|name|rate|vac/tot|yoy_pts|4yr_pts|top_streets):
${catalog}`;

		const ai = await callOpenRouter({
			apiKey,
			model: getDefaultModel(platform, false),
			system,
			user: userMsg,
			temperature: 0.1,
			maxTokens: 450,
			jsonMode: true,
			timeoutMs: 14000
		});

		const parsed = extractJsonObject<{
			answer?: string;
			picks?: Array<{ id?: string; reason?: string }>;
			places?: Array<{ name?: string; address?: string; reason?: string }>;
		}>(ai.text);

		const results: AiSearchResultItem[] = [];

		// Resolve any named NYC landmarks/businesses to exact building/block links
		if (parsed?.places?.length) {
			const resolved = await Promise.all(
				parsed.places.slice(0, 2).map(async (pl) => {
					if (!pl.address) return null;
					const target = await resolveAddressToTarget(pl.address, file, fetch);
					if (!target) return null;
					return {
						type: target.type,
						title: pl.name ? `${pl.name} · ${target.label}` : target.label,
						subtitle: target.subtitle,
						badge: target.type === 'building' ? 'Building' : target.type === 'block' ? 'Block' : 'Cluster',
						href: target.href,
						reason: pl.reason || 'Matched NYC location'
					} satisfies AiSearchResultItem;
				})
			);
			for (const r of resolved) if (r) results.push(r);
		}

		// Attach verified cluster picks
		const seenIds = new Set<string>();
		for (const p of parsed?.picks ?? []) {
			const cid = (p.id || '').trim();
			const c = byId.get(cid);
			if (!c || seenIds.has(cid)) continue;
			seenIds.add(cid);
			results.push({
				type: 'cluster',
				title: c.name,
				subtitle: `${c.borough} · ${c.vacant_storefronts}/${c.total_storefronts} empty`,
				badge: `${(c.vacancy_rate * 100).toFixed(1)}%`,
				tone: rateTone(c.vacancy_rate),
				href: `/cluster/${c.id}`,
				reason: p.reason || ''
			});
			if (results.length >= 6) break;
		}

		const responseData: AiSearchResponse = {
			configured: true,
			answer: (parsed?.answer || '').trim(),
			results
		};

		if (responseData.answer || responseData.results.length > 0) {
			searchCache.set(cacheKey, { at: Date.now(), data: responseData });
		}
		return json(responseData);
	} catch (e) {
		return json({
			configured: true,
			answer: '',
			results: [],
			error: e instanceof Error ? e.message : 'AI search failed'
		} satisfies AiSearchResponse);
	}
};
