import type { LayoutLoad } from './$types';
import type { ClustersFile, ComptrollerSummary } from '$lib/types';

export const load: LayoutLoad = async ({ fetch }) => {
	const [clustersRes, comptrollerRes] = await Promise.all([
		fetch('/data/nyc-clusters.json'),
		fetch('/data/comptroller-summary.json')
	]);
	const clustersData: ClustersFile = await clustersRes.json();
	const comptroller: ComptrollerSummary | null = comptrollerRes.ok
		? await comptrollerRes.json()
		: null;
	return { clustersData, comptroller };
};
