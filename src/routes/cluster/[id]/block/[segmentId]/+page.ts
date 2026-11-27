import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { BlockLotsResponse, ClusterShard } from '$lib/types';

export const load: PageLoad = async ({ params, fetch }) => {
	const [shardRes, lotsRes] = await Promise.all([
		fetch(`/data/clusters/${params.id}.json`),
		fetch(
			`/api/block-lots?cluster=${encodeURIComponent(params.id)}&segment=${encodeURIComponent(params.segmentId)}&v=7`
		).catch(() => null)
	]);

	if (!shardRes.ok) throw error(404, `Cluster "${params.id}" not found`);
	const shard: ClusterShard = await shardRes.json();

	const segment = shard.segmentDetails[params.segmentId];
	if (!segment) {
		throw error(404, `Block "${params.segmentId}" not found in cluster "${params.id}"`);
	}

	let lotsData: BlockLotsResponse | null = null;
	if (lotsRes && lotsRes.ok) {
		try {
			const parsed: BlockLotsResponse = await lotsRes.json();
			if (parsed && parsed.segmentId === segment.id) {
				lotsData = parsed;
			}
		} catch {
			// Fall back gracefully if response isn't valid JSON
		}
	}

	return { shard, segment, lotsData };
};
