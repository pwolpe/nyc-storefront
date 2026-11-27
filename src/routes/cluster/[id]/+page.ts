import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { ClusterShard } from '$lib/types';

export const load: PageLoad = async ({ params, fetch }) => {
	const res = await fetch(`/data/clusters/${params.id}.json`);
	if (!res.ok) throw error(404, `Cluster "${params.id}" not found`);
	const shard: ClusterShard = await res.json();
	return { shard };
};
