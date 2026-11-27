<script lang="ts">
	import type { PageData } from './$types';
	import { pct, ptsDiff, numFmt, rateTone, deltaPts, deltaTone, signedNum } from '$lib/format';
	import TopBar from '$lib/components/TopBar.svelte';
	import ClusterGridSvg from '$lib/components/ClusterGridSvg.svelte';
	import ClusterCohesion from '$lib/components/ClusterCohesion.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import ShareButton from '$lib/components/ShareButton.svelte';

	let { data }: { data: PageData } = $props();

	let highlightedStreetSlug = $state<string | null>(null);
	let highlightedSegId = $state<string | null>(null);
	let highlightedNeighborId = $state<string | null>(null);
	let blockListTab = $state<'hot' | 'worsening' | 'improving'>('hot');
	let aiTakeaway = $state('');
	let aiTakeawayCites = $state<Array<{ title: string; url: string }>>([]);
	let aiTakeawayId = $state('');
	let aiTakeawayLoading = $state(false);

	const cluster = $derived(data.shard.cluster);
	const cityRate = $derived(data.clustersData.meta.citywideRate);

	// Find specific anchor buildings driving this cluster's vacancy (so AI explains *what* went dark or came online!)
	const topVacantBuildings = $derived.by(() => {
		const byBbl = new Map<
			string,
			{ address: string; street: string; vacant: number; total: number }
		>();
		for (const det of Object.values(data.shard.segmentDetails)) {
			for (const sf of det.storefronts || []) {
				const key = (sf.bbl || '').split('.')[0].trim() || sf.address.toLowerCase();
				if (!key) continue;
				const cur = byBbl.get(key) || {
					address: sf.address,
					street: det.streetName,
					vacant: 0,
					total: 0
				};
				cur.total++;
				if (sf.vacant) cur.vacant++;
				byBbl.set(key, cur);
			}
		}
		const clusterVac = Math.max(1, cluster.vacant_storefronts);
		return [...byBbl.values()]
			.filter((b) => b.vacant > 0)
			.sort((a, b) => b.vacant - a.vacant || b.total - a.total)
			.slice(0, 5)
			.map((b) => ({
				...b,
				shareOfClusterPct: Math.round((b.vacant / clusterVac) * 100)
			}));
	});

	$effect(() => {
		const cid = cluster.id;
		const controller = new AbortController();
		if (aiTakeawayId !== cid) {
			aiTakeaway = '';
			aiTakeawayCites = [];
		}
		aiTakeawayLoading = true;

		const payload = {
			id: cid,
			name: cluster.name,
			borough: cluster.borough,
			rate: Math.round(cluster.vacancy_rate * 1000) / 10,
			cityRate: Math.round(cityRate * 1000) / 10,
			vacant: cluster.vacant_storefronts,
			total: cluster.total_storefronts,
			yoyChange:
				cluster.yoy_change !== null && cluster.yoy_change !== undefined
					? Math.round(cluster.yoy_change * 1000) / 10
					: null,
			history: (cluster.history || []).map((h) => ({
				year: h.year,
				rate: Math.round(h.rate * 1000) / 10,
				vacant: h.vacant,
				total: h.total
			})),
			topStreets: data.shard.streetsList.slice(0, 6).map((s) => ({
				name: s.name,
				rate: Math.round(s.rate * 1000) / 10,
				vacant: s.vacant,
				total: s.total
			})),
			worstBlocks: hardestHitBlocks.slice(0, 4).map((b) => ({
				street: b.streetName,
				between: b.between,
				vacant: b.vacant,
				total: b.total,
				prevVacant: b.prevVacant,
				delta: b.vacantDelta
			})),
			topVacantBuildings,
			neighbors: data.shard.borderClusters.slice(0, 4).map((n) => ({
				name: n.name,
				rate: Math.round(n.vacancy_rate * 1000) / 10
			}))
		};

		fetch('/api/ai/cluster-brief', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal
		})
			.then((r) => (r.ok ? r.json() : null))
			.then(
				(
					res: {
						configured?: boolean;
						summary?: string;
						citations?: Array<{ title: string; url: string }>;
					} | null
				) => {
					if (!controller.signal.aborted && res?.summary) {
						aiTakeaway = res.summary;
						aiTakeawayCites = res.citations || [];
						aiTakeawayId = cid;
					}
				}
			)
			.catch(() => {})
			.finally(() => {
				if (!controller.signal.aborted) aiTakeawayLoading = false;
			});

		return () => controller.abort();
	});

	const clusterSpark = $derived(
		(cluster.history || []).map((h) => ({
			label: `'${String(h.year).slice(-2)}`,
			value: h.rate
		}))
	);

	// Top 5 hardest-hit blocks (prefer meaningful blocks with >= 3 storefronts, sorted by vacancy rate then vacant count)
	const hardestHitBlocks = $derived.by(() => {
		const withVacancy = data.shard.segments.filter((s) => s.vacant > 0);
		const meaningful = withVacancy.filter((s) => s.total >= 3);
		const pool = meaningful.length >= 3 ? meaningful : withVacancy;
		return [...pool]
			.sort((a, b) => b.rate - a.rate || b.vacant - a.vacant)
			.slice(0, 5);
	});

	const worseningBlocks = $derived.by(() =>
		[...data.shard.segments]
			.filter((s) => (s.vacantDelta ?? 0) > 0 || (s.yoyChange ?? 0) > 0.02)
			.sort((a, b) => (b.vacantDelta ?? 0) - (a.vacantDelta ?? 0) || (b.yoyChange ?? 0) - (a.yoyChange ?? 0))
			.slice(0, 5)
	);

	const improvingBlocks = $derived.by(() =>
		[...data.shard.segments]
			.filter((s) => (s.vacantDelta ?? 0) < 0 || (s.yoyChange ?? 0) < -0.02)
			.sort((a, b) => (a.vacantDelta ?? 0) - (b.vacantDelta ?? 0) || (a.yoyChange ?? 0) - (b.yoyChange ?? 0))
			.slice(0, 5)
	);

	const visibleBlocks = $derived(
		blockListTab === 'worsening'
			? worseningBlocks
			: blockListTab === 'improving'
				? improvingBlocks
				: hardestHitBlocks
	);

	function segColor(r: number): string {
		if (r >= 0.25) return '#8f1422';
		if (r >= 0.16) return '#d9381e';
		if (r >= 0.10) return '#e4724e';
		if (r > 0) return '#ebb09c';
		return '#c6c6bf';
	}
</script>

<svelte:head>
	<title>{cluster.name} ({pct(cluster.vacancy_rate, 1)}) — NYC Storefront Vacancy</title>
	<meta property="og:title" content="{cluster.name} · {pct(cluster.vacancy_rate, 1)} Vacant — NYC Storefront Vacancy" />
	<meta
		property="og:description"
		content="{cluster.vacant_storefronts} of {cluster.total_storefronts} storefronts empty across {cluster.segment_count} blocks in {cluster.borough}. Explore block by block on nycstorefront.com."
	/>
	<meta name="twitter:title" content="{cluster.name} · {pct(cluster.vacancy_rate, 1)} Vacant" />
	<meta
		name="twitter:description"
		content="{cluster.vacant_storefronts}/{cluster.total_storefronts} storefronts empty across {cluster.segment_count} blocks in {cluster.borough}."
	/>
</svelte:head>

<div class="shell">
	<TopBar
		{cityRate}
		clustersData={data.clustersData}
		cluster={{ id: cluster.id, name: cluster.name, rate: cluster.vacancy_rate }}
	/>

	<main class="split">
		<section class="grid-pane">
			<ClusterGridSvg
				shard={data.shard}
				clustersData={data.clustersData}
				{highlightedStreetSlug}
				{highlightedSegId}
				{highlightedNeighborId}
				onHoverStreet={(slug) => (highlightedStreetSlug = slug)}
				onHoverSegment={(sid) => (highlightedSegId = sid)}
				onHoverNeighbor={(nid) => (highlightedNeighborId = nid)}
			/>
		</section>

		<aside class="info-pane">
			<!-- 1. Cluster Summary -->
			<div class="cluster-head surface">
				<div class="ch-top">
					<span class="kicker">{cluster.borough} · Cluster</span>
					<ShareButton
						compact
						summary="{cluster.name} ({cluster.borough}): {pct(cluster.vacancy_rate, 1)} storefront vacancy ({cluster.vacant_storefronts}/{cluster.total_storefronts} empty)"
					/>
				</div>
				<h1>{cluster.name}</h1>

				{#if cluster.borders?.summary}
					<div class="head-borders">
						{#if cluster.borders.n}<span><em>N</em> {cluster.borders.n}</span>{/if}
						{#if cluster.borders.s}<span><em>S</em> {cluster.borders.s}</span>{/if}
						{#if cluster.borders.w}<span><em>W</em> {cluster.borders.w}</span>{/if}
						{#if cluster.borders.e}<span><em>E</em> {cluster.borders.e}</span>{/if}
					</div>
				{/if}

				<div class="stat-row">
					<div class="stat-cell">
						<b class="big {rateTone(cluster.vacancy_rate)}">{pct(cluster.vacancy_rate, 1)}</b>
						<span>Vacancy ({ptsDiff(cluster.vacancy_rate, cityRate)})</span>
					</div>
					<div class="stat-cell">
						<b class="big">{numFmt(cluster.vacant_storefronts)}</b>
						<span>of {numFmt(cluster.total_storefronts)} empty</span>
					</div>
					<div class="stat-cell">
						<b class="big">{cluster.segment_count}</b>
						<span>blocks</span>
					</div>
				</div>

				{#if clusterSpark.length >= 2}
					{@const h21 = cluster.history?.find((h) => h.year === 2021)}
					{@const diff21 = h21 && h21.total >= 5 ? cluster.vacancy_rate - h21.rate : null}
					<div class="trend-strip">
						<div class="trend-copy">
							<span class="trend-kicker">5-Yr Cluster Trend · DOF</span>
							{#if cluster.yoy_change !== null && cluster.yoy_change !== undefined}
								<strong class="trend-delta {deltaTone(cluster.yoy_change, 0.01)}">
									{deltaPts(cluster.yoy_change, 1)} YoY
								</strong>
							{:else}
								<strong class="trend-delta flat">Insufficient 2024 base</strong>
							{/if}
							{#if diff21 !== null && h21}
								<span class="trend-nta">
									Since 2021 ({pct(h21.rate, 0)}):
									<em class={deltaTone(diff21, 0.01)}>
										{deltaPts(diff21, 1)}
									</em>
								</span>
							{/if}
						</div>
						<Sparkline
							points={clusterSpark}
							width={98}
							height={26}
							tone={deltaTone(cluster.yoy_change, 0.01)}
							showEndpoints
						/>
					</div>
				{/if}

				{#if aiTakeaway}
					<div class="ai-takeaway">
						<span class="ai-tag">✦ Why It Looks Like This</span>
						<p>{aiTakeaway}</p>
						{#if aiTakeawayCites.length > 0}
							<div class="ai-cites">
								{#each aiTakeawayCites as c}
									<a
										href={c.url}
										target="_blank"
										rel="noopener noreferrer"
										class="ai-cite"
										title={c.url}
									>
										{c.title} ↗
									</a>
								{/each}
							</div>
						{/if}
					</div>
				{:else if aiTakeawayLoading}
					<div class="ai-takeaway">
						<span class="ai-tag muted">✦ Investigating what’s driving this cluster…</span>
						<div class="ai-shimmer" aria-hidden="true">
							<span class="sh-l w1"></span>
							<span class="sh-l w2"></span>
						</div>
					</div>
				{/if}
			</div>

			<!-- 2. Why These Streets Are Grouped -->
			<ClusterCohesion
				shard={data.shard}
				{cityRate}
				{highlightedStreetSlug}
				{highlightedNeighborId}
				onHoverStreet={(slug) => (highlightedStreetSlug = slug)}
				onHoverNeighbor={(nid) => (highlightedNeighborId = nid)}
			/>

			<!-- 3. Block Watchlist: Hardest-Hit / Worsening / Improving -->
			{#if hardestHitBlocks.length > 0}
				<section class="hot-blocks surface">
					<div class="hb-head">
						<span class="kicker">Blocks</span>
						<div class="hb-tabs" role="tablist" aria-label="Filter notable blocks">
							<button
								type="button"
								role="tab"
								aria-selected={blockListTab === 'hot'}
								class:active={blockListTab === 'hot'}
								onclick={() => (blockListTab = 'hot')}
							>
								Most Empty
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={blockListTab === 'worsening'}
								class:active={blockListTab === 'worsening'}
								onclick={() => (blockListTab = 'worsening')}
							>
								Worsening
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={blockListTab === 'improving'}
								class:active={blockListTab === 'improving'}
								onclick={() => (blockListTab = 'improving')}
							>
								Improving
							</button>
						</div>
					</div>
					{#if visibleBlocks.length > 0}
						<div class="hb-list">
							{#each visibleBlocks as s (s.id)}
								<a
									href="/cluster/{cluster.id}/block/{s.id}"
									class="hb-row"
									class:active={highlightedSegId === s.id}
									onmouseenter={() => {
										highlightedStreetSlug = s.streetSlug;
										highlightedSegId = s.id;
									}}
									onmouseleave={() => {
										highlightedStreetSlug = null;
										highlightedSegId = null;
									}}
								>
									<span
										class="hb-dot"
										style="background:{blockListTab === 'improving'
											? '#0e6e48'
											: blockListTab === 'worsening'
												? '#c4281c'
												: segColor(s.rate)}"
									></span>
									<div class="hb-copy">
										<strong>{s.streetName}</strong>
										<span>{s.between}</span>
									</div>
									<div class="hb-stat">
										{#if blockListTab === 'hot'}
											<b>{pct(s.rate, 0)}</b>
											<small>
												{s.vacant}/{s.total}
												{#if s.vacantDelta && s.vacantDelta !== 0}
													<em class={s.vacantDelta > 0 ? 'worse' : 'better'}>
														({signedNum(s.vacantDelta)})
													</em>
												{/if}
											</small>
										{:else}
											<b class={blockListTab === 'worsening' ? 'worse' : 'better'}>
												{s.vacantDelta !== null && s.vacantDelta !== undefined && s.vacantDelta !== 0
													? `${signedNum(s.vacantDelta)} empty`
													: deltaPts(s.yoyChange, 0)}
											</b>
											<small>now {s.vacant}/{s.total} ({pct(s.rate, 0)})</small>
										{/if}
									</div>
								</a>
							{/each}
						</div>
					{:else}
						<p class="hb-empty">
							No blocks in this cluster {blockListTab === 'worsening' ? 'worsened' : 'improved'} meaningfully between 2024 and 2025.
						</p>
					{/if}
				</section>
			{/if}
		</aside>
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

	.split {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr 348px;
	}

	.grid-pane {
		position: relative;
		min-height: 0;
		border-right: 1px solid var(--rule);
	}

	.info-pane {
		overflow-y: auto;
		background: var(--page);
		padding: 14px 16px 24px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.cluster-head {
		padding: 14px 16px;
	}

	.ch-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.cluster-head h1 {
		font-size: 16.5px;
		margin: 3px 0 8px;
		line-height: 1.25;
	}

	.head-borders {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 3px 10px;
		padding-bottom: 10px;
		margin-bottom: 10px;
		border-bottom: 1px solid var(--rule);
		font-size: 11.5px;
		color: var(--ink-soft);
	}

	.head-borders span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.head-borders em {
		font-style: normal;
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 600;
		color: var(--muted);
		margin-right: 4px;
	}

	.stat-row {
		display: grid;
		grid-template-columns: 1.2fr 1fr 0.75fr;
		gap: 8px;
	}

	.stat-cell .big {
		display: block;
		font-family: var(--font-mono);
		font-size: 17px;
		font-weight: 600;
		line-height: 1.1;
		letter-spacing: -0.02em;
	}

	.stat-cell .big.hot {
		color: var(--red);
	}

	.stat-cell .big.thriving {
		color: var(--green);
	}

	.stat-cell span {
		font-size: 10.5px;
		color: var(--muted);
		display: block;
		margin-top: 2px;
	}

	/* Top 5 Hardest-Hit Blocks */
	.hot-blocks {
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.hb-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	.hb-sub {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted-light);
	}

	.hb-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.hb-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		background: var(--page);
		text-decoration: none;
		color: var(--ink);
		transition: border-color 0.1s ease, background 0.1s ease;
	}

	.hb-row:hover,
	.hb-row.active {
		border-color: var(--ink);
		background: var(--panel);
	}

	.hb-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
	}

	.hb-copy {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.hb-copy strong {
		font-size: 12px;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.hb-copy span {
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.hb-stat {
		flex: none;
		text-align: right;
		font-family: var(--font-mono);
	}

	.hb-stat b {
		display: block;
		font-size: 12px;
		font-weight: 600;
		color: var(--red);
		line-height: 1.1;
	}

	.hb-stat small {
		font-size: 10px;
		color: var(--muted);
	}

	.hb-stat small em {
		font-style: normal;
		font-weight: 600;
	}

	.hb-stat .worse,
	.trend-delta.worse,
	.trend-nta em.worse {
		color: var(--red);
	}

	.hb-stat .better,
	.trend-delta.better,
	.trend-nta em.better {
		color: var(--green);
	}

	.ai-takeaway {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.ai-tag {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #b42318;
	}

	.ai-takeaway p {
		margin: 0;
		font-size: 12px;
		line-height: 1.48;
		color: var(--ink-soft);
	}

	.ai-tag.muted {
		color: var(--muted-light);
	}

	.ai-shimmer {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 3px 0 2px;
	}

	.sh-l {
		display: block;
		height: 10px;
		border-radius: 3px;
		background: linear-gradient(90deg, #efefe9 25%, #e4e4dc 50%, #efefe9 75%);
		background-size: 200% 100%;
		animation: cShimmer 1.35s infinite ease-in-out;
	}

	.sh-l.w1 { width: 94%; }
	.sh-l.w2 { width: 72%; }

	@keyframes cShimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

	.ai-cites {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 2px;
	}

	.ai-cite {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--muted);
		text-decoration: none;
		padding: 1px 6px;
		border-radius: 99px;
		background: var(--page);
		border: 1px solid var(--rule);
		max-width: 185px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ai-cite:hover {
		border-color: var(--ink);
		color: var(--ink);
	}

	.trend-strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--rule);
	}

	.trend-copy {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.trend-kicker {
		font-family: var(--font-mono);
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.trend-delta {
		font-family: var(--font-mono);
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.trend-delta.flat {
		color: var(--muted);
	}

	.trend-nta {
		font-size: 10.5px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.trend-nta em {
		font-style: normal;
		font-family: var(--font-mono);
		font-weight: 600;
		color: var(--ink-soft);
	}

	.hb-tabs {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		background: var(--quiet);
		border-radius: 5px;
	}

	.hb-tabs button {
		border: 0;
		background: transparent;
		padding: 2px 7px;
		border-radius: 3.5px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		color: var(--muted);
		cursor: pointer;
	}

	.hb-tabs button.active {
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}

	.hb-empty {
		font-size: 11.5px;
		color: var(--muted);
		margin: 2px 0 0;
		line-height: 1.4;
	}

	@media (max-width: 960px) {
		.split {
			grid-template-columns: 1fr;
			grid-template-rows: 52dvh 1fr;
		}
		.grid-pane {
			border-right: 0;
			border-bottom: 1px solid var(--rule);
		}
	}
</style>
