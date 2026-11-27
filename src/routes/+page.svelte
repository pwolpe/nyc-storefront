<script lang="ts">
	import type { PageData } from './$types';
	import TopBar from '$lib/components/TopBar.svelte';
	import CityMap from '$lib/components/CityMap.svelte';

	let { data }: { data: PageData } = $props();
</script>

<div class="shell">
	<TopBar cityRate={data.clustersData.meta.citywideRate} clustersData={data.clustersData} />
	<main class="stage">
		<CityMap clustersData={data.clustersData} comptroller={data.comptroller} />
	</main>
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		width: 100vw;
		overflow: hidden;
	}

	.stage {
		flex: 1;
		min-height: 0;
	}
</style>
