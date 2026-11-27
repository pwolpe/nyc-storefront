import { error } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { blockLotsClientCache, buildingCache } from '$lib/clientCache';
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

export const load: PageLoad = async ({ params, fetch }) => {
	if (!/^[1-5]\d{9}$/.test(params.bbl)) {
		throw error(400, `Invalid NYC BBL "${params.bbl}"`);
	}

	const lotsKey = `${params.id}:${params.segmentId}`;
	const cachedLots = browser ? blockLotsClientCache.get(lotsKey) : null;
	const cachedDossier = browser ? buildingCache.get(params.bbl) : null;

	// If we came from the Block page, forward any linked storefront/pre-condo BBLs attached to this lot
	const findAliases = (lots: BlockLotsResponse | null): string[] => {
		if (!lots) return [];
		const all = [...(lots.sideA || []), ...(lots.sideB || [])];
		const lot = all.find(
			(l) =>
				l.bbl === params.bbl ||
				l.storefronts.some((sf) => (sf.bbl || '').split('.')[0].trim() === params.bbl)
		);
		if (!lot) return [];
		const set = new Set<string>();
		if (/^[1-5]\d{9}$/.test(lot.bbl) && lot.bbl !== params.bbl) set.add(lot.bbl);
		for (const sf of lot.storefronts) {
			const sb = (sf.bbl || '').split('.')[0].trim();
			if (/^[1-5]\d{9}$/.test(sb) && sb !== params.bbl) set.add(sb);
		}
		return [...set].sort().slice(0, 6);
	};

	const initialAliases = findAliases(cachedLots);
	const buildingApiUrl =
		`/api/building?bbl=${encodeURIComponent(params.bbl)}` +
		(initialAliases.length > 0 ? `&alias=${encodeURIComponent(initialAliases.join(','))}` : '');

	const [res, lotsRes, dossierRes] = await Promise.all([
		fetch(`/data/clusters/${params.id}.json`),
		cachedLots
			? Promise.resolve(null)
			: fetch(
					`/api/block-lots?cluster=${encodeURIComponent(params.id)}&segment=${encodeURIComponent(params.segmentId)}`
				).catch(() => null),
		cachedDossier ? Promise.resolve(null) : fetch(buildingApiUrl).catch(() => null)
	]);

	if (!res.ok) throw error(404, `Cluster "${params.id}" not found`);
	const shard: ClusterShard = await res.json();

	const segment = shard.segmentDetails[params.segmentId];
	if (!segment) {
		throw error(404, `Block "${params.segmentId}" not found in cluster "${params.id}"`);
	}

	let initialDossier: BuildingDossier | null = cachedDossier;
	if (!initialDossier && dossierRes && dossierRes.ok) {
		try {
			const parsed = (await dossierRes.json()) as BuildingDossier;
			if (parsed?.bbl === params.bbl) {
				initialDossier = parsed;
				if (browser) buildingCache.set(params.bbl, parsed);
			}
		} catch {
			// Fall back to client fetch if needed
		}
	}

	let prevBuilding: DoorNeighbor | null = null;
	let nextBuilding: DoorNeighbor | null = null;
	let sidewalkLabel: string | null = null;

	let lotsData: BlockLotsResponse | null = cachedLots;
	if (!lotsData && lotsRes && lotsRes.ok) {
		try {
			lotsData = (await lotsRes.json()) as BlockLotsResponse;
			if (browser && lotsData) blockLotsClientCache.set(lotsKey, lotsData);
		} catch {
			lotsData = null;
		}
	}

	if (lotsData) {
		try {
			const sides = [lotsData.sideA || [], lotsData.sideB || []];
			for (const side of sides) {
				// Find this building by exact BBL or condo unit storefront BBL
				const idx = side.findIndex(
					(l) =>
						l.bbl === params.bbl ||
						l.storefronts.some((sf) => (sf.bbl || '').split('.')[0].trim() === params.bbl)
				);
				if (idx === -1) continue;
				sidewalkLabel = side[idx].sideLabel;
				// Walk left to find nearest navigable neighbor with a valid BBL
				for (let i = idx - 1; i >= 0; i--) {
					if (/^[1-5]\d{9}$/.test(side[i].bbl) && side[i].bbl !== params.bbl) {
						prevBuilding = {
							bbl: side[i].bbl,
							label: shortNeighborLabel(side[i]),
							kind: side[i].kind,
							vacantCount: side[i].vacantCount
						};
						break;
					}
				}
				// Walk right to find nearest navigable neighbor with a valid BBL
				for (let i = idx + 1; i < side.length; i++) {
					if (/^[1-5]\d{9}$/.test(side[i].bbl) && side[i].bbl !== params.bbl) {
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
			// Ignore malformed response; stepper simply stays hidden
		}
	}

	return {
		shard,
		segment,
		bbl: params.bbl,
		prevBuilding,
		nextBuilding,
		sidewalkLabel,
		initialDossier
	};
};
