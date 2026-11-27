import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { BlockLot, BlockLotsResponse, ClusterShard } from '$lib/types';

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

	const [res, lotsRes] = await Promise.all([
		fetch(`/data/clusters/${params.id}.json`),
		fetch(
			`/api/block-lots?cluster=${encodeURIComponent(params.id)}&segment=${encodeURIComponent(params.segmentId)}&v=7`
		).catch(() => null)
	]);

	if (!res.ok) throw error(404, `Cluster "${params.id}" not found`);
	const shard: ClusterShard = await res.json();

	const segment = shard.segmentDetails[params.segmentId];
	if (!segment) {
		throw error(404, `Block "${params.segmentId}" not found in cluster "${params.id}"`);
	}

	let prevBuilding: DoorNeighbor | null = null;
	let nextBuilding: DoorNeighbor | null = null;
	let sidewalkLabel: string | null = null;

	if (lotsRes && lotsRes.ok) {
		try {
			const lotsData: BlockLotsResponse = await lotsRes.json();
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
		sidewalkLabel
	};
};
