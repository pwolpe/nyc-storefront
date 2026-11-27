<script lang="ts">
	import type { PageData } from './$types';
	import type { BlockLot, BlockTenantInfo, BlockTenantsResponse } from '$lib/types';
	import { pct, rateTone, signedNum } from '$lib/format';
	import { blockTenantsClientCache, warmBlock, warmBuilding } from '$lib/clientCache';
	import TopBar from '$lib/components/TopBar.svelte';
	import BlockElevation from '$lib/components/BlockElevation.svelte';
	import ShareButton from '$lib/components/ShareButton.svelte';

	let { data }: { data: PageData } = $props();

	const cluster = $derived(data.shard.cluster);
	const seg = $derived(data.segment);
	const cityRate = $derived(data.clustersData.meta.citywideRate);
	const lotsData = $derived(data.lotsData);

	let tenantsByBbl = $state<Record<string, BlockTenantInfo>>({});
	let availableYears = $state<number[]>([]);

	const fallbackSideA = $derived<BlockLot[]>(
		seg.storefronts
			.filter((sf) => sf.side === seg.sideLabels[0])
			.map((sf, i, arr) => ({
				id: `fb-a-${i}`,
				bbl: sf.bbl || '',
				address: sf.address,
				houseNum: sf.num,
				side: 'A',
				sideLabel: seg.sideLabels[0],
				t: (i + 0.5) / Math.max(1, arr.length),
				x0: i / Math.max(1, arr.length),
				x1: (i + 0.94) / Math.max(1, arr.length),
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
			}))
	);

	const fallbackSideB = $derived<BlockLot[]>(
		seg.storefronts
			.filter((sf) => sf.side !== seg.sideLabels[0])
			.map((sf, i, arr) => ({
				id: `fb-b-${i}`,
				bbl: sf.bbl || '',
				address: sf.address,
				houseNum: sf.num,
				side: 'B',
				sideLabel: seg.sideLabels[1],
				t: (i + 0.5) / Math.max(1, arr.length),
				x0: i / Math.max(1, arr.length),
				x1: (i + 0.94) / Math.max(1, arr.length),
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
			}))
	);

	const activeSideA = $derived(
		lotsData && lotsData.segmentId === seg.id ? lotsData.sideA : fallbackSideA
	);
	const activeSideB = $derived(
		lotsData && lotsData.segmentId === seg.id ? lotsData.sideB : fallbackSideB
	);
	const plutoLoaded = $derived(Boolean(lotsData && lotsData.segmentId === seg.id && lotsData.plutoLoaded));
	const loadingLots = false;

	// Non-blocking enrichment: immediately seed with 0ms pre-baked business names from SSR lotsData,
	// then hydrate 2019–2025 Time Machine & live Socrata updates (with 0ms client cache on revisit!)
	$effect(() => {
		const lots = [...activeSideA, ...activeSideB];
		const initial = lotsData?.initialTenants ?? {};
		const bblSet = new Set<string>();
		const vacSet = new Set<string>();
		for (const l of lots) {
			if (/^[1-5]\d{9}$/.test(l.bbl)) {
				if (l.storefronts.length > 0 || l.kind === 'commercial') bblSet.add(l.bbl);
				if (l.vacantCount > 0) vacSet.add(l.bbl);
			}
			for (const sf of l.storefronts) {
				const sb = (sf.bbl || '').split('.')[0].trim();
				if (/^[1-5]\d{9}$/.test(sb)) {
					bblSet.add(sb);
					if (sf.vacant) vacSet.add(sb);
				}
			}
		}

		if (bblSet.size === 0) {
			tenantsByBbl = initial;
			availableYears = [];
			return;
		}

		const sortedBbls = [...bblSet].sort();
		const sortedVac = [...vacSet].sort();
		const cacheKey = `${sortedBbls.join(',')}|${sortedVac.join(',')}`;
		const clientHit = blockTenantsClientCache.get(cacheKey);
		if (clientHit) {
			tenantsByBbl = clientHit.byBbl;
			availableYears = clientHit.years ?? [];
			return;
		}

		// Instant 0ms paint of pre-baked NYC business names while live Socrata history hydrates
		tenantsByBbl = initial;

		const controller = new AbortController();
		const params = new URLSearchParams({
			bbls: sortedBbls.join(','),
			vacant: sortedVac.join(',')
		});
		fetch(`/api/block-tenants?${params.toString()}`, { signal: controller.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((res: BlockTenantsResponse | null) => {
				if (res?.byBbl && !controller.signal.aborted) {
					blockTenantsClientCache.set(cacheKey, res);
					tenantsByBbl = res.byBbl;
					availableYears = res.years ?? [];
				}
			})
			.catch(() => {});

		return () => controller.abort();
	});

	// Predictive Spatial Pre-Warming: quietly warm the 4 adjacent blocks + top vacant/commercial buildings
	// 550ms after landing so walking via arrow keys or clicking a storefront opens instantaneously!
	$effect(() => {
		const nav = seg.nav;
		const lots = [...activeSideA, ...activeSideB];
		const timer = setTimeout(() => {
			if (nav) {
				for (const target of [nav.left, nav.right, nav.up, nav.down]) {
					if (target) warmBlock(target.clusterId, target.segId);
				}
			}
			const featuredLots = lots
				.filter((l) => /^[1-5]\d{9}$/.test(l.bbl) && (l.vacantCount > 0 || l.storefronts.length > 0))
				.sort((a, b) => b.vacantCount - a.vacantCount || b.storefronts.length - a.storefronts.length)
				.slice(0, 4);
			for (const l of featuredLots) {
				warmBuilding(
					l.bbl,
					l.storefronts.map((sf) => sf.bbl).filter((b): b is string => Boolean(b))
				);
			}
		}, 550);
		return () => clearTimeout(timer);
	});
</script>

<svelte:head>
	<title>{seg.streetName} ({seg.between}) — NYC Storefront Vacancy</title>
	<meta property="og:title" content="{seg.streetName} ({seg.between}) · {pct(seg.rate, 1)} Vacant — NYC Storefront Vacancy" />
	<meta
		property="og:description"
		content="{seg.vacant} of {seg.total} storefronts vacant on {seg.streetName} between {seg.between} ({cluster.borough}). Walk every door and scrub 2019–2025 history."
	/>
	<meta name="twitter:title" content="{seg.streetName} ({seg.between}) · {pct(seg.rate, 1)} Vacant" />
	<meta
		name="twitter:description"
		content="{seg.vacant}/{seg.total} storefronts vacant in {cluster.borough}. Explore the 2019–2025 Time Machine on nycstorefront.com."
	/>
</svelte:head>

<div class="page-shell">
	<TopBar
		{cityRate}
		clustersData={data.clustersData}
		cluster={{ id: cluster.id, name: cluster.name, rate: cluster.vacancy_rate }}
		block={{
			id: seg.id,
			label: `${seg.streetName} (${seg.between})`,
			rate: seg.rate
		}}
	/>

	<main class="container block-body">
		<!-- Compact Single-Row Block Header + Inline Prev/Next Block Walker -->
		<header class="block-hero">
			<div class="hero-left">
				<div class="hero-title-row">
					<h1>
						{seg.streetName}
						<span class="between-sub">{seg.between}</span>
					</h1>
					<span class="rate-pill {rateTone(seg.rate)}">
						{pct(seg.rate, 1)} · {seg.vacant}/{seg.total} vacant
					</span>
					{#if seg.vacantDelta !== null && seg.vacantDelta !== undefined}
						<span
							class="delta-pill"
							class:worse={seg.vacantDelta > 0}
							class:better={seg.vacantDelta < 0}
							title="2024 baseline: {seg.prevVacant ?? 0}/{seg.prevTotal ?? 0} vacant"
						>
							{#if seg.vacantDelta > 0}
								↑ {signedNum(seg.vacantDelta)} empty vs 2024
							{:else if seg.vacantDelta < 0}
								↓ {Math.abs(seg.vacantDelta)} fewer empty vs 2024
							{:else}
								Unchanged vs 2024
							{/if}
						</span>
					{/if}
					{#if seg.isDividing}
						<span class="div-tag">Border street</span>
					{/if}
				</div>
				<div class="hero-sub">
					<a href="/cluster/{cluster.id}" class="back-link">← {cluster.name}</a>
					<span class="dot-sep">·</span>
					<span>{cluster.borough}</span>
					{#if seg.dividingClusters.length > 0}
						<span class="dot-sep">·</span>
						<span>
							Borders
							{#each seg.dividingClusters as dc, i}
								{#if i > 0}, {/if}
								<a href="/cluster/{dc.id}" class="border-link">
									{dc.name} ({pct(dc.vacancy_rate, 1)}) ↗
								</a>
							{/each}
						</span>
					{/if}
				</div>
			</div>
			<div class="hero-actions">
				<span class="kb-hint" title="Use arrow keys to walk blocks, Space to play Time Machine">←→↑↓ walk · Space play</span>
				<ShareButton
					summary="{seg.streetName} ({seg.between}), {cluster.borough}: {pct(seg.rate, 1)} storefront vacancy ({seg.vacant}/{seg.total} empty)"
				/>
			</div>
		</header>

		<!-- Pure Zero-Scroll Two-Sided Street Elevation -->
		<BlockElevation
			segment={seg}
			shardSegments={data.shard.segments}
			sideA={activeSideA}
			sideB={activeSideB}
			{tenantsByBbl}
			{availableYears}
			{plutoLoaded}
			loading={loadingLots}
			clusterId={cluster.id}
		/>
	</main>
</div>

<style>
	.page-shell {
		min-height: 100dvh;
		width: 100%;
		max-width: 100%;
		overflow-x: hidden;
		display: flex;
		flex-direction: column;
		background: var(--page);
	}

	.block-body {
		flex: 1;
		width: 100%;
		max-width: 1240px;
		min-width: 0;
		padding-top: 14px;
		padding-bottom: 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.block-hero {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.hero-left {
		min-width: 0;
	}

	.hero-actions {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}

	.kb-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted-light);
	}

	.hero-title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.block-hero h1 {
		font-size: clamp(20px, 2.4vw, 25px);
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}

	.between-sub {
		font-size: clamp(14px, 1.8vw, 17px);
		font-weight: 400;
		color: var(--muted);
	}

	.rate-pill {
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-weight: 600;
		padding: 3px 9px;
		border-radius: 5px;
		background: var(--quiet);
		color: var(--ink);
	}

	.delta-pill {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		padding: 3px 8px;
		border-radius: 5px;
		background: var(--quiet);
		color: var(--muted);
	}

	.delta-pill.worse {
		background: var(--red-bg);
		color: var(--red);
	}

	.delta-pill.better {
		background: var(--green-bg);
		color: var(--green);
	}

	.rate-pill.hot {
		background: var(--red-bg);
		color: var(--red);
	}

	.rate-pill.thriving {
		background: var(--green-bg);
		color: var(--green);
	}

	.div-tag {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--accent);
		background: var(--accent-soft);
		padding: 2px 7px;
		border-radius: 4px;
	}

	.hero-sub {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		font-size: 12px;
		color: var(--muted);
	}

	.back-link {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		text-decoration: none;
		color: var(--ink);
	}

	.back-link:hover {
		color: var(--accent);
	}

	.dot-sep {
		color: var(--line);
	}

	.border-link {
		font-weight: 500;
		color: var(--ink);
	}
</style>
