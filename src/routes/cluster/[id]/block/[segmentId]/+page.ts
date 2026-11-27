import { error } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { blockLotsClientCache } from '$lib/clientCache';
import type { PageLoad } from './$types';
import type { BlockLotsResponse, ClusterShard } from '$lib/types';

export const load: PageLoad = async ({ params, fetch }) => {
	const lotsKey = `${params.id}:${params.segmentId}`;
	const cachedLots = browser ? blockLotsClientCache.get(lotsKey) : null;

	const [shardRes, lotsRes] = await Promise.all([
		fetch(`/data/clusters/${params.id}.json`),
		cachedLots
			? Promise.resolve(null)
			: fetch(
					`/api/block-lots?cluster=${encodeURIComponent(params.id)}&segment=${encodeURIComponent(params.segmentId)}`
				).catch(() => null)
	]);

	if (!shardRes.ok) throw error(404, `Cluster "${params.id}" not found`);
	const shard: ClusterShard = await shardRes.json();

	const segment = shard.segmentDetails[params.segmentId];
	if (!segment) {
		throw error(404, `Block "${params.segmentId}" not found in cluster "${params.id}"`);
	}

	let lotsData: BlockLotsResponse | null = cachedLots;
	if (!lotsData && lotsRes && lotsRes.ok) {
		try {
			const parsed: BlockLotsResponse = await lotsRes.json();
			if (parsed && parsed.segmentId === segment.id) {
				lotsData = parsed;
				if (browser) blockLotsClientCache.set(lotsKey, parsed);
			}
		} catch {
			// Fall back gracefully if response isn't valid JSON
		}
	}

	return { shard, segment, lotsData };
};
