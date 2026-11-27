<script lang="ts">
	import type { PageData } from './$types';
	import type { ClusterProps } from '$lib/types';
	import { pct, numFmt, deltaPts, deltaTone, signedNum } from '$lib/format';
	import TopBar from '$lib/components/TopBar.svelte';

	let { data }: { data: PageData } = $props();

	const comp = $derived(data.comptroller);
	const cityRate = $derived(data.clustersData.meta.citywideRate);

	// Quarter selector for interactive chart hover
	let hoveredQIdx = $state<number | null>(null);
	let hoveredFlowIdx = $state<number | null>(null);

	// Toggleable series on the multi-quarter line chart
	const SERIES = [
		{ key: 'Citywide', label: 'Citywide', color: '#111111', width: 2.4 },
		{ key: 'Manhattan', label: 'Manhattan', color: '#c4281c', width: 1.7 },
		{ key: 'Brooklyn', label: 'Brooklyn', color: '#d97706', width: 1.6 },
		{ key: 'Queens', label: 'Queens', color: '#2563eb', width: 1.6 },
		{ key: 'Bronx', label: 'Bronx', color: '#0e6e48', width: 1.5 },
		{ key: 'Staten Island', label: 'Staten Island', color: '#7c3aed', width: 1.5 }
	] as const;

	let visibleSeries = $state<Record<string, boolean>>({
		Citywide: true,
		Manhattan: true,
		Brooklyn: true,
		Queens: true,
		Bronx: true,
		'Staten Island': false
	});

	function toggleSeries(key: string) {
		const activeCount = Object.values(visibleSeries).filter(Boolean).length;
		if (visibleSeries[key] && activeCount <= 1) return;
		visibleSeries = { ...visibleSeries, [key]: !visibleSeries[key] };
	}

	const quarters = $derived(comp?.quarters ?? []);
	const flowQuarters = $derived(quarters.filter((q) => q.netChange !== null));
	const latest = $derived(comp?.headline ?? null);
	const priorQ = $derived(quarters.length >= 2 ? quarters[quarters.length - 2] : null);

	const openingsDiff = $derived(
		latest?.openings != null && priorQ?.openings != null ? latest.openings - priorQ.openings : null
	);
	const closingsDiff = $derived(
		latest?.closings != null && priorQ?.closings != null ? latest.closings - priorQ.closings : null
	);

	// SVG geometry for 13-quarter vacancy chart
	const LINE_W = 580;
	const LINE_H = 228;
	const L_PAD = { top: 16, right: 18, bottom: 28, left: 42 };

	const lineChart = $derived.by(() => {
		if (quarters.length < 2) return null;
		const activeKeys = SERIES.filter((s) => visibleSeries[s.key]).map((s) => s.key);
		const vals: number[] = [];
		for (const q of quarters) {
			for (const k of activeKeys) {
				const v = k === 'Citywide' ? q.vacancyRate : q.boroughs[k];
				if (typeof v === 'number') vals.push(v);
			}
		}
		const rawMin = Math.min(...vals);
		const rawMax = Math.max(...vals);
		const minY = Math.max(0, Math.floor((rawMin - 0.008) * 100) / 100);
		const maxY = Math.ceil((rawMax + 0.008) * 100) / 100;
		const spanY = Math.max(0.02, maxY - minY);
		const plotW = LINE_W - L_PAD.left - L_PAD.right;
		const plotH = LINE_H - L_PAD.top - L_PAD.bottom;

		const xOf = (i: number) => L_PAD.left + (i / (quarters.length - 1)) * plotW;
		const yOf = (v: number) => L_PAD.top + (1 - (v - minY) / spanY) * plotH;

		const yTicks: number[] = [];
		const step = spanY <= 0.06 ? 0.01 : 0.02;
		for (let t = Math.ceil(minY / step) * step; t <= maxY + 1e-6; t += step) {
			yTicks.push(Math.round(t * 1000) / 1000);
		}

		const paths = SERIES.filter((s) => visibleSeries[s.key]).map((s) => {
			const pts = quarters.map((q, i) => {
				const v = s.key === 'Citywide' ? q.vacancyRate : q.boroughs[s.key];
				return { x: xOf(i), y: yOf(v), v, q: q.quarter };
			});
			const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
			return { ...s, pts, d };
		});

		return { minY, maxY, xOf, yOf, yTicks, paths };
	});

	const activeQ = $derived(
		hoveredQIdx !== null && quarters[hoveredQIdx] ? quarters[hoveredQIdx] : latest
	);

	// SVG geometry for Net Storefront Change bar chart
	const BAR_W = 460;
	const BAR_H = 228;
	const B_PAD = { top: 18, right: 16, bottom: 28, left: 42 };

	const flowChart = $derived.by(() => {
		if (flowQuarters.length === 0) return null;
		const maxAbs = Math.max(
			50,
			...flowQuarters.map((q) => Math.abs(q.netChange ?? 0)),
			...flowQuarters.map((q) => Math.abs(q.smallBizNetChange ?? 0))
		);
		const ceilAbs = Math.ceil(maxAbs / 100) * 100;
		const minV = -ceilAbs;
		const maxV = Math.max(100, Math.ceil(Math.max(0, ...flowQuarters.map((q) => q.netChange ?? 0)) / 100) * 100);
		const span = maxV - minV;
		const plotW = BAR_W - B_PAD.left - B_PAD.right;
		const plotH = BAR_H - B_PAD.top - B_PAD.bottom;
		const zeroY = B_PAD.top + (maxV / span) * plotH;
		const colW = plotW / flowQuarters.length;
		const barW = Math.max(10, Math.min(22, colW * 0.56));

		const bars = flowQuarters.map((q, i) => {
			const val = q.netChange ?? 0;
			const cx = B_PAD.left + colW * (i + 0.5);
			const yVal = B_PAD.top + ((maxV - val) / span) * plotH;
			const y = Math.min(zeroY, yVal);
			const h = Math.max(2, Math.abs(yVal - zeroY));
			return { q, i, cx, x: cx - barW / 2, y, w: barW, h, val };
		});

		return { zeroY, minV, maxV, bars, plotH };
	});

	const activeFlow = $derived(
		hoveredFlowIdx !== null && flowQuarters[hoveredFlowIdx]
			? flowQuarters[hoveredFlowIdx]
			: flowQuarters[flowQuarters.length - 1] ?? null
	);

	// Biggest cluster movers: 1-Yr (2024->25) vs 4-Yr (2021->25)
	let moversSpan = $state<'1yr' | '4yr'>('1yr');

	const clusterMovers = $derived.by(() => {
		const scored: Array<{ c: ClusterProps; delta: number; baseRate: number }> = [];
		for (const f of data.clustersData.clusters.features) {
			const c = f.properties;
			if (c.total_storefronts < 45) continue;
			if (moversSpan === '1yr') {
				const h24 = c.history?.find((h) => h.year === 2024);
				if (c.yoy_change !== null && c.yoy_change !== undefined && h24 && h24.total >= 20) {
					scored.push({ c, delta: c.yoy_change, baseRate: h24.rate });
				}
			} else {
				const h21 = c.history?.find((h) => h.year === 2021);
				if (h21 && h21.total >= 20) {
					scored.push({
						c,
						delta: Math.round((c.vacancy_rate - h21.rate) * 10000) / 10000,
						baseRate: h21.rate
					});
				}
			}
		}
		const improving = [...scored]
			.filter((x) => x.delta < -0.005)
			.sort((a, b) => a.delta - b.delta)
			.slice(0, 8);
		const worsening = [...scored]
			.filter((x) => x.delta > 0.005)
			.sort((a, b) => b.delta - a.delta)
			.slice(0, 8);
		return { improving, worsening };
	});

	// Subcategories table (Comptroller census)
	let catSort = $state<'largest' | 'highest' | 'lowest'>('largest');

	const subcategories = $derived.by(() => {
		const list = (comp?.subcategories ?? []).filter((s) => s.total >= 200);
		if (catSort === 'highest') {
			return [...list].sort((a, b) => b.vacancyRate - a.vacancyRate).slice(0, 14);
		}
		if (catSort === 'lowest') {
			return [...list].sort((a, b) => a.vacancyRate - b.vacancyRate).slice(0, 14);
		}
		return [...list].sort((a, b) => b.total - a.total).slice(0, 14);
	});

	const maxCatRate = $derived(
		Math.max(0.25, ...subcategories.map((s) => s.vacancyRate))
	);
</script>

<svelte:head>
	<title>Trends — NYC Storefront Vacancy</title>
</svelte:head>

<div class="trends-shell">
	<TopBar {cityRate} clustersData={data.clustersData} section="Trends" />

	<main class="container trends-main">
		<header class="trends-header">
			<div>
				<span class="kicker">NYC Comptroller Quarterly Census · {comp?.latestQuarter ?? '2026 Q3'}</span>
				<h1>Citywide Storefront Trends</h1>
			</div>
			<a href="/" class="back-map-btn">← Explore Map</a>
		</header>

		{#if latest}
			<!-- 1. Swiss 5-Metric Scorecard Strip (exact Comptroller Q3 2026 figures) -->
			<section class="scorecard surface" aria-label="Citywide headline metrics">
				<div class="sc-cell">
					<span class="sc-label">Vacancy Rate</span>
					<strong class="sc-val">{pct(latest.vacancyRate, 2)}</strong>
					<span class="sc-sub {deltaTone(latest.rateChange, 0.0002)}">
						{deltaPts(latest.rateChange, 2)} from {priorQ?.quarter ?? 'Q2'} ({pct(priorQ?.vacancyRate, 2)})
					</span>
				</div>

				<div class="sc-cell">
					<span class="sc-label">Storefront Openings</span>
					<strong class="sc-val">{numFmt(latest.openings)}</strong>
					<span class="sc-sub">
						{numFmt(latest.smallBizOpenings)} small biz
						{#if openingsDiff !== null}
							· <em class={openingsDiff < 0 ? 'worse' : 'better'}>{signedNum(openingsDiff)} vs Q2</em>
						{/if}
					</span>
				</div>

				<div class="sc-cell">
					<span class="sc-label">Storefront Closings</span>
					<strong class="sc-val">{numFmt(latest.closings)}</strong>
					<span class="sc-sub">
						{numFmt(latest.smallBizClosings)} small biz
						{#if closingsDiff !== null}
							· <em class={closingsDiff > 0 ? 'worse' : 'better'}>{signedNum(closingsDiff)} vs Q2</em>
						{/if}
					</span>
				</div>

				<div class="sc-cell">
					<span class="sc-label">Net Storefront Change</span>
					<strong class="sc-val {latest.netChange !== null && latest.netChange < 0 ? 'worse' : 'better'}">
						{signedNum(latest.netChange)}
					</strong>
					<span class="sc-sub">
						<em class={latest.smallBizNetChange !== null && latest.smallBizNetChange < 0 ? 'worse' : 'better'}>
							{signedNum(latest.smallBizNetChange)}
						</em>
						small business net
					</span>
				</div>

				<div class="sc-cell">
					<span class="sc-label">Tracked Storefronts</span>
					<strong class="sc-val">{numFmt(latest.totalStorefronts)}</strong>
					<span class="sc-sub">
						{numFmt(latest.vacantStorefronts)} empty · {numFmt(latest.smallBizVacant)} of {numFmt(latest.smallBizStorefronts)} small biz
					</span>
				</div>
			</section>

			<!-- 2. Trajectory Charts: 13-Quarter Vacancy Rate + Net Openings/Closings Flow -->
			<section class="charts-grid">
				<!-- Left: Multi-Quarter Vacancy Rate by Borough -->
				<article class="chart-card surface">
					<div class="chart-head">
						<div>
							<span class="kicker">2023 Q3 – {comp?.latestQuarter}</span>
							<h2>Vacancy Rate by Borough</h2>
						</div>
						{#if activeQ}
							<div class="chart-readout">
								<span class="cr-q">{activeQ.quarter}</span>
								<b>{pct(activeQ.vacancyRate, 2)}</b>
							</div>
						{/if}
					</div>

					<div class="series-toggles" role="group" aria-label="Toggle borough lines">
						{#each SERIES as s (s.key)}
							{@const val = activeQ
								? s.key === 'Citywide'
									? activeQ.vacancyRate
									: activeQ.boroughs[s.key]
								: null}
							<button
								type="button"
								class="series-pill"
								class:on={visibleSeries[s.key]}
								onclick={() => toggleSeries(s.key)}
							>
								<i style="background:{s.color}"></i>
								<span>{s.label}</span>
								{#if visibleSeries[s.key] && val !== null}
									<b>{pct(val, 1)}</b>
								{/if}
							</button>
						{/each}
					</div>

					{#if lineChart}
						<svg
							viewBox="0 0 {LINE_W} {LINE_H}"
							class="chart-svg"
							role="img"
							aria-label="Quarterly storefront vacancy rate from 2023 Q3 to 2026 Q3"
							onmouseleave={() => (hoveredQIdx = null)}
						>
							{#each lineChart.yTicks as t}
								{@const y = lineChart.yOf(t)}
								<line
									x1={L_PAD.left}
									y1={y}
									x2={LINE_W - L_PAD.right}
									y2={y}
									stroke="#ecece7"
									stroke-width="1"
								/>
								<text
									x={L_PAD.left - 7}
									y={y + 3.5}
									text-anchor="end"
									font-size="9.5"
									fill="#8c8c86"
									font-family="JetBrains Mono, ui-monospace, monospace"
								>
									{Math.round(t * 100)}%
								</text>
							{/each}

							{#each quarters as q, i}
								{#if i === 0 || i === quarters.length - 1 || i % 3 === 0}
									<text
										x={lineChart.xOf(i)}
										y={LINE_H - 8}
										text-anchor={i === 0 ? 'start' : i === quarters.length - 1 ? 'end' : 'middle'}
										font-size="9.5"
										fill="#8c8c86"
										font-family="JetBrains Mono, ui-monospace, monospace"
									>
										{q.quarter.replace(/^20/, "'")}
									</text>
								{/if}
							{/each}

							{#if hoveredQIdx !== null}
								<line
									x1={lineChart.xOf(hoveredQIdx)}
									y1={L_PAD.top}
									x2={lineChart.xOf(hoveredQIdx)}
									y2={LINE_H - L_PAD.bottom}
									stroke="#111111"
									stroke-width="1"
									stroke-dasharray="2 3"
									opacity="0.4"
								/>
							{/if}

							{#each lineChart.paths as s (s.key)}
								<path
									d={s.d}
									fill="none"
									stroke={s.color}
									stroke-width={s.width}
									stroke-linecap="round"
									stroke-linejoin="round"
									opacity={s.key === 'Citywide' ? 1 : 0.85}
								/>
								{@const pt = s.pts[hoveredQIdx ?? s.pts.length - 1]}
								{#if pt}
									<circle
										cx={pt.x}
										cy={pt.y}
										r={s.key === 'Citywide' ? 3.4 : 2.7}
										fill={s.color}
										stroke="#ffffff"
										stroke-width="1.2"
									/>
								{/if}
							{/each}

							<!-- Hover columns -->
							{#each quarters as _q, i}
								{@const cx = lineChart.xOf(i)}
								{@const stepW = (LINE_W - L_PAD.left - L_PAD.right) / Math.max(1, quarters.length - 1)}
								<rect
									x={cx - stepW / 2}
									y={L_PAD.top}
									width={stepW}
									height={LINE_H - L_PAD.top - L_PAD.bottom}
									fill="transparent"
									role="presentation"
									onmouseenter={() => (hoveredQIdx = i)}
								/>
							{/each}
						</svg>
					{/if}
				</article>

				<!-- Right: Quarterly Net Storefront Change -->
				<article class="chart-card surface">
					<div class="chart-head">
						<div>
							<span class="kicker">Openings Minus Closings</span>
							<h2>Quarterly Net Storefront Change</h2>
						</div>
						{#if activeFlow}
							<div class="chart-readout">
								<span class="cr-q">{activeFlow.quarter}</span>
								<b class={activeFlow.netChange !== null && activeFlow.netChange < 0 ? 'worse' : 'better'}>
									{signedNum(activeFlow.netChange)}
								</b>
							</div>
						{/if}
					</div>

					{#if activeFlow}
						<div class="flow-summary-line">
							<span><b>{numFmt(activeFlow.openings)}</b> opened</span>
							<span class="dot">·</span>
							<span><b>{numFmt(activeFlow.closings)}</b> closed</span>
							<span class="dot">·</span>
							<span>Small biz net: <b class={activeFlow.smallBizNetChange !== null && activeFlow.smallBizNetChange < 0 ? 'worse' : 'better'}>{signedNum(activeFlow.smallBizNetChange)}</b></span>
						</div>
					{/if}

					{#if flowChart}
						<svg
							viewBox="0 0 {BAR_W} {BAR_H}"
							class="chart-svg"
							role="img"
							aria-label="Quarterly net storefront change bars"
							onmouseleave={() => (hoveredFlowIdx = null)}
						>
							<!-- Zero baseline -->
							<line
								x1={B_PAD.left}
								y1={flowChart.zeroY}
								x2={BAR_W - B_PAD.right}
								y2={flowChart.zeroY}
								stroke="#111111"
								stroke-width="1"
								opacity="0.35"
							/>
							<text
								x={B_PAD.left - 7}
								y={flowChart.zeroY + 3.5}
								text-anchor="end"
								font-size="9.5"
								fill="#5c5c58"
								font-family="JetBrains Mono, ui-monospace, monospace"
							>
								0
							</text>
							<text
								x={B_PAD.left - 7}
								y={BAR_H - B_PAD.bottom + 3}
								text-anchor="end"
								font-size="9.5"
								fill="#8c8c86"
								font-family="JetBrains Mono, ui-monospace, monospace"
							>
								{flowChart.minV}
							</text>

							{#each flowChart.bars as b (b.q.quarter)}
								{@const isHot = hoveredFlowIdx === b.i || (hoveredFlowIdx === null && b.i === flowChart.bars.length - 1)}
								<rect
									x={b.x}
									y={b.y}
									width={b.w}
									height={b.h}
									rx="2.5"
									fill={b.val < 0 ? (isHot ? '#b42318' : '#e07a6e') : (isHot ? '#0e6e48' : '#58a883')}
								/>
								{#if isHot}
									<text
										x={b.cx}
										y={b.val < 0 ? b.y + b.h + 11 : b.y - 5}
										text-anchor="middle"
										font-size="9.5"
										font-weight="600"
										fill={b.val < 0 ? '#b42318' : '#0e6e48'}
										font-family="JetBrains Mono, ui-monospace, monospace"
									>
										{signedNum(b.val)}
									</text>
								{/if}
								{#if b.i === 0 || b.i === flowChart.bars.length - 1 || b.i % 3 === 0}
									<text
										x={b.cx}
										y={BAR_H - 7}
										text-anchor="middle"
										font-size="9.5"
										fill="#8c8c86"
										font-family="JetBrains Mono, ui-monospace, monospace"
									>
										{b.q.quarter.replace(/^20/, "'")}
									</text>
								{/if}
								<rect
									x={b.cx - 18}
									y={B_PAD.top}
									width="36"
									height={BAR_H - B_PAD.top - B_PAD.bottom}
									fill="transparent"
									role="presentation"
									onmouseenter={() => (hoveredFlowIdx = b.i)}
								/>
							{/each}
						</svg>
					{/if}
				</article>
			</section>
		{/if}

		<!-- 3. Biggest Cluster Movers: Improving vs Worsening -->
		<section class="movers-section surface">
			<div class="section-head">
				<div>
					<span class="kicker">
						NYC DOF Tax Filings · {moversSpan === '1yr' ? '2024 → 2025' : '2021 → 2025'} (45+ Storefront Clusters)
					</span>
					<h2>Biggest Cluster Movers</h2>
				</div>
				<div class="seg-tabs" role="group" aria-label="Trend timeframe">
					<button
						type="button"
						class:active={moversSpan === '1yr'}
						onclick={() => (moversSpan = '1yr')}
					>
						1-Yr (2024→25)
					</button>
					<button
						type="button"
						class:active={moversSpan === '4yr'}
						onclick={() => (moversSpan = '4yr')}
					>
						4-Yr (2021→25)
					</button>
				</div>
			</div>

			<div class="movers-cols">
				<div class="mover-col">
					<div class="col-title better">
						<span class="dot-ind better"></span>
						Improving Most
					</div>
					<div class="mover-list">
						{#each clusterMovers.improving as item (item.c.id)}
							<a href="/cluster/{item.c.id}" class="mover-row">
								<div class="mr-copy">
									<strong>{item.c.name}</strong>
									<span>{item.c.borough} · {numFmt(item.c.vacant_storefronts)}/{numFmt(item.c.total_storefronts)} vacant</span>
								</div>
								<div class="mr-nums">
									<b class="better">{deltaPts(item.delta, 1)}</b>
									<small>{pct(item.baseRate, 0)} → {pct(item.c.vacancy_rate, 1)}</small>
								</div>
							</a>
						{/each}
					</div>
				</div>

				<div class="mover-col">
					<div class="col-title worse">
						<span class="dot-ind worse"></span>
						Worsening Most
					</div>
					<div class="mover-list">
						{#each clusterMovers.worsening as item (item.c.id)}
							<a href="/cluster/{item.c.id}" class="mover-row">
								<div class="mr-copy">
									<strong>{item.c.name}</strong>
									<span>{item.c.borough} · {numFmt(item.c.vacant_storefronts)}/{numFmt(item.c.total_storefronts)} vacant</span>
								</div>
								<div class="mr-nums">
									<b class="worse">{deltaPts(item.delta, 1)}</b>
									<small>{pct(item.baseRate, 0)} → {pct(item.c.vacancy_rate, 1)}</small>
								</div>
							</a>
						{/each}
					</div>
				</div>
			</div>
		</section>

		<!-- 4. Vacancy by Business Category -->
		{#if subcategories.length > 0}
			<section class="cats-section surface">
				<div class="section-head">
					<div>
						<span class="kicker">Comptroller Category Census · 200+ Storefronts</span>
						<h2>Vacancy by Business Type</h2>
					</div>
					<div class="seg-tabs" role="group" aria-label="Sort categories">
						<button type="button" class:active={catSort === 'largest'} onclick={() => (catSort = 'largest')}>
							Largest Sectors
						</button>
						<button type="button" class:active={catSort === 'highest'} onclick={() => (catSort = 'highest')}>
							Highest Vacancy
						</button>
						<button type="button" class:active={catSort === 'lowest'} onclick={() => (catSort = 'lowest')}>
							Lowest Vacancy
						</button>
					</div>
				</div>

				<div class="cat-table">
					{#each subcategories as s (s.name)}
						<div class="cat-row">
							<div class="cat-name">{s.name}</div>
							<div class="cat-bar-track" aria-hidden="true">
								<div
									class="cat-bar-fill"
									class:hot={s.vacancyRate >= 0.14}
									style="width: {Math.min(100, (s.vacancyRate / maxCatRate) * 100)}%"
								></div>
							</div>
							<div class="cat-rate">{pct(s.vacancyRate, 1)}</div>
							<div class="cat-count">{numFmt(s.vacant)} / {numFmt(s.total)}</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<footer class="trends-footnote">
			<strong>About the two datasets:</strong> Citywide quarterly trends, openings/closings, and category rates come from the NYC Comptroller's Storefront Vacancy Dashboard ({comp?.latestQuarter ?? '2026 Q3'}, covering {numFmt(latest?.totalStorefronts)} tracked storefronts). Street-cluster and block-level 5-year trends come from NYC Department of Finance Local Law 157 landlord filings (2021–2025, {numFmt(data.clustersData.meta.totalStorefronts)} geocoded storefronts).
		</footer>
	</main>
</div>

<style>
	.trends-shell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--page);
	}

	.trends-main {
		padding-top: 22px;
		padding-bottom: 48px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.trends-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	.trends-header h1 {
		font-size: clamp(22px, 2.6vw, 28px);
		margin-top: 3px;
		letter-spacing: -0.025em;
	}

	.back-map-btn {
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink);
		text-decoration: none;
		padding: 6px 11px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--panel);
	}

	.back-map-btn:hover {
		border-color: var(--ink);
	}

	/* 5-Metric Swiss Scorecard */
	.scorecard {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		overflow: hidden;
	}

	.sc-cell {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-right: 1px solid var(--rule);
	}

	.sc-cell:last-child {
		border-right: 0;
	}

	.sc-label {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.sc-val {
		font-family: var(--font-mono);
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.03em;
		color: var(--ink);
		line-height: 1.1;
	}

	.sc-sub {
		font-size: 11.5px;
		color: var(--muted);
		line-height: 1.35;
	}

	.sc-sub em {
		font-style: normal;
		font-family: var(--font-mono);
		font-weight: 600;
	}

	.worse {
		color: var(--red) !important;
	}

	.better {
		color: var(--green) !important;
	}

	/* Charts */
	.charts-grid {
		display: grid;
		grid-template-columns: 1.25fr 1fr;
		gap: 16px;
	}

	.chart-card {
		padding: 16px 18px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.chart-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.chart-head h2,
	.section-head h2 {
		font-size: 16px;
		margin-top: 2px;
		letter-spacing: -0.015em;
	}

	.chart-readout {
		display: flex;
		align-items: baseline;
		gap: 7px;
		font-family: var(--font-mono);
		white-space: nowrap;
	}

	.cr-q {
		font-size: 10.5px;
		color: var(--muted);
	}

	.chart-readout b {
		font-size: 16px;
		font-weight: 600;
		color: var(--ink);
	}

	.series-toggles {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.series-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: 4px;
		border: 1px solid var(--rule);
		background: var(--page);
		font-size: 11px;
		color: var(--muted);
		cursor: pointer;
		transition: border-color 0.1s ease, background 0.1s ease;
	}

	.series-pill i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		opacity: 0.35;
	}

	.series-pill.on {
		background: var(--panel);
		border-color: var(--line);
		color: var(--ink);
	}

	.series-pill.on i {
		opacity: 1;
	}

	.series-pill b {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
	}

	.flow-summary-line {
		font-size: 12px;
		color: var(--muted);
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		min-height: 24px;
	}

	.flow-summary-line b {
		font-family: var(--font-mono);
		color: var(--ink);
		font-weight: 600;
	}

	.flow-summary-line .dot {
		color: var(--line);
	}

	.chart-svg {
		width: 100%;
		height: auto;
		display: block;
		user-select: none;
	}

	/* Movers & Categories */
	.movers-section,
	.cats-section {
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.seg-tabs {
		display: inline-flex;
		padding: 3px;
		gap: 2px;
		background: var(--quiet);
		border-radius: var(--radius-sm);
	}

	.seg-tabs button {
		border: 0;
		background: transparent;
		padding: 4px 10px;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
		cursor: pointer;
	}

	.seg-tabs button.active {
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}

	.movers-cols {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 18px;
	}

	.col-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		margin-bottom: 8px;
	}

	.dot-ind {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.dot-ind.better {
		background: var(--green);
	}

	.dot-ind.worse {
		background: var(--red);
	}

	.mover-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.mover-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 11px;
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		background: var(--page);
		text-decoration: none;
		color: var(--ink);
		transition: border-color 0.1s ease, background 0.1s ease;
	}

	.mover-row:hover {
		border-color: var(--ink);
		background: var(--panel);
	}

	.mr-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.mr-copy strong {
		font-size: 12.5px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.mr-copy span {
		font-size: 11px;
		color: var(--muted);
	}

	.mr-nums {
		text-align: right;
		flex: none;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}

	.mr-nums b {
		font-family: var(--font-mono);
		font-size: 12.5px;
		font-weight: 600;
	}

	.mr-nums small {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
	}

	/* Categories */
	.cat-table {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.cat-row {
		display: grid;
		grid-template-columns: minmax(160px, 260px) 1fr 56px 96px;
		align-items: center;
		gap: 12px;
		font-size: 12.5px;
	}

	.cat-name {
		color: var(--ink);
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cat-bar-track {
		height: 7px;
		border-radius: 3px;
		background: var(--quiet);
		overflow: hidden;
	}

	.cat-bar-fill {
		height: 100%;
		border-radius: 3px;
		background: #4b4b47;
	}

	.cat-bar-fill.hot {
		background: #c4281c;
	}

	.cat-rate {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		text-align: right;
		color: var(--ink);
	}

	.cat-count {
		font-family: var(--font-mono);
		font-size: 11px;
		text-align: right;
		color: var(--muted);
	}

	.trends-footnote {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.55;
		padding-top: 6px;
		border-top: 1px solid var(--rule);
	}

	.trends-footnote strong {
		color: var(--ink-soft);
		font-weight: 600;
	}

	@media (max-width: 960px) {
		.scorecard {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.sc-cell {
			border-bottom: 1px solid var(--rule);
		}

		.charts-grid,
		.movers-cols {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 600px) {
		.cat-row {
			grid-template-columns: 1fr 64px 52px;
		}

		.cat-count {
			display: none;
		}
	}
</style>
