import { error } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { blockLotsClientCache, buildingCache, getClusterShard } from '$lib/clientCache';
import type { PageLoad } from './$types';
import type { BlockLot, BlockLotsResponse, BuildingDossier, ClusterShard } from '$lib/types';

export interface DoorNeighbor {
	bbl: string;
	label: string;
	kind: BlockLot['kind'];
	vacantCount: number;
}

function shortNeighborLabel(lot: BlockLot): string {
	return lot.address
		.replace(/\bAvenue Of The Americas\b/i, '6th Ave')
		.replace(/\bAvenue\b/i, 'Ave')
		.replace(/\bStreet\b/i, 'St')
		.replace(/\bWest\b(?=\s+\d)/i, 'W')
		.replace(/\bEast\b(?=\s+\d)/i, 'E');
}

export function _extractDoorNeighbors(
	lotsData: BlockLotsResponse | null,
	targetBbl: string
): {
	prevBuilding: DoorNeighbor | null;
	nextBuilding: DoorNeighbor | null;
	sidewalkLabel: string | null;
} {
	let prevBuilding: DoorNeighbor | null = null;
	let nextBuilding: DoorNeighbor | null = null;
	let sidewalkLabel: string | null = null;
	if (!lotsData) return { prevBuilding, nextBuilding, sidewalkLabel };

	try {
		const sides = [lotsData.sideA || [], lotsData.sideB || []];
		for (const side of sides) {
			const idx = side.findIndex(
				(l) =>
					l.bbl === targetBbl ||
					l.storefronts.some((sf) => (sf.bbl || '').split('.')[0].trim() === targetBbl)
			);
			if (idx === -1) continue;
			sidewalkLabel = side[idx].sideLabel;
			for (let i = idx - 1; i >= 0; i--) {
				if (/^[1-5]\d{9}$/.test(side[i].bbl) && side[i].bbl !== targetBbl) {
					prevBuilding = {
						bbl: side[i].bbl,
						label: shortNeighborLabel(side[i]),
						kind: side[i].kind,
						vacantCount: side[i].vacantCount
					};
					break;
				}
			}
			for (let i = idx + 1; i < side.length; i++) {
				if (/^[1-5]\d{9}$/.test(side[i].bbl) && side[i].bbl !== targetBbl) {
					nextBuilding = {
						bbl: side[i].bbl,
						label: shortNeighborLabel(side[i]),
						kind: side[i].kind,
						vacantCount: side[i].vacantCount
					};
					break;
				}
			}
			break;
		}
	} catch {
		// Ignore malformed response; stepper stays hidden
	}
	return { prevBuilding, nextBuilding, sidewalkLabel };
}

function findBblAliases(lots: BlockLotsResponse | null, targetBbl: string): string[] {
	if (!lots) return [];
	const all = [...(lots.sideA || []), ...(lots.sideB || [])];
	const lot = all.find(
		(l) =>
			l.bbl === targetBbl ||
			l.storefronts.some((sf) => (sf.bbl || '').split('.')[0].trim() === targetBbl)
	);
	if (!lot) return [];
	const set = new Set<string>();
	if (/^[1-5]\d{9}$/.test(lot.bbl) && lot.bbl !== targetBbl) set.add(lot.bbl);
	for (const sf of lot.storefronts) {
		const sb = (sf.bbl || '').split('.')[0].trim();
		if (/^[1-5]\d{9}$/.test(sb) && sb !== targetBbl) set.add(sb);
	}
	return [...set].sort().slice(0, 6);
}

export const load: PageLoad = async ({ params, fetch }) => {
	if (!/^[1-5]\d{9}$/.test(params.bbl)) {
		throw error(400, `Invalid NYC BBL "${params.bbl}"`);
	}

	const lotsKey = `${params.id}:${params.segmentId}`;
	const cachedLots = browser ? blockLotsClientCache.get(lotsKey) : null;
	const cachedDossier = browser ? buildingCache.get(params.bbl) : null;

	// Client-side navigation: enter the building page IMMEDIATELY using the cached cluster shard
	// (0ms when coming from Search or Block) instead of blocking the whole transition for 2-3s on
	// cold NYC API calls. The building page streams the dossier (joining any in-flight hover prefetch!)
	// and fills in prev/next door neighbors asynchronously.
	if (browser) {
		const shard = await getClusterShard(params.id, fetch);
		if (!shard) throw error(404, `Cluster "${params.id}" not found`);
		const segment = shard.segmentDetails[params.segmentId];
		if (!segment) {
			throw error(404, `Block "${params.segmentId}" not found in cluster "${params.id}"`);
		}
		const { prevBuilding, nextBuilding, sidewalkLabel } = _extractDoorNeighbors(
			cachedLots,
			params.bbl
		);
		return {
			shard,
			segment,
			bbl: params.bbl,
			prevBuilding,
			nextBuilding,
			sidewalkLabel,
			initialDossier: cachedDossier,
			initialAliases: findBblAliases(cachedLots, params.bbl)
		};
	}

	// SSR (direct URL visits / crawlers / shared links): fetch all three in parallel for complete HTML
	const initialAliases = findBblAliases(cachedLots, params.bbl);
	const buildingApiUrl =
		`/api/building?bbl=${encodeURIComponent(params.bbl)}` +
		(initialAliases.length > 0 ? `&alias=${encodeURIComponent(initialAliases.join(','))}` : '');

	const [res, lotsRes, dossierRes] = await Promise.all([
		fetch(`/data/clusters/${params.id}.json`),
		fetch(
			`/api/block-lots?cluster=${encodeURIComponent(params.id)}&segment=${encodeURIComponent(params.segmentId)}`
		).catch(() => null),
		fetch(buildingApiUrl).catch(() => null)
	]);

	if (!res.ok) throw error(404, `Cluster "${params.id}" not found`);
	const shard: ClusterShard = await res.json();

	const segment = shard.segmentDetails[params.segmentId];
	if (!segment) {
		throw error(404, `Block "${params.segmentId}" not found in cluster "${params.id}"`);
	}

	let initialDossier: BuildingDossier | null = null;
	if (dossierRes && dossierRes.ok) {
		try {
			const parsed = (await dossierRes.json()) as BuildingDossier;
			if (parsed?.bbl === params.bbl) initialDossier = parsed;
		} catch {
			// Fall back to client fetch if needed
		}
	}

	let lotsData: BlockLotsResponse | null = null;
	if (lotsRes && lotsRes.ok) {
		try {
			lotsData = (await lotsRes.json()) as BlockLotsResponse;
		} catch {
			lotsData = null;
		}
	}

	const { prevBuilding, nextBuilding, sidewalkLabel } = _extractDoorNeighbors(lotsData, params.bbl);

	return {
		shard,
		segment,
		bbl: params.bbl,
		prevBuilding,
		nextBuilding,
		sidewalkLabel,
		initialDossier,
		initialAliases: findBblAliases(lotsData, params.bbl)
	};
};
