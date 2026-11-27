<script lang="ts">
	import { goto } from '$app/navigation';
	import type { ClusterShard, StreetSummary, BorderCluster, TractRateItem } from '$lib/types';
	import { pct } from '$lib/format';

	interface Props {
		shard: ClusterShard;
		cityRate: number;
		highlightedStreetSlug?: string | null;
		highlightedNeighborId?: string | null;
		onHoverStreet?: (slug: string | null) => void;
		onHoverNeighbor?: (id: string | null) => void;
	}

	let {
		shard,
		cityRate,
		highlightedStreetSlug = null,
		highlightedNeighborId = null,
		onHoverStreet = () => {},
		onHoverNeighbor = () => {}
	}: Props = $props();

	let hoveredTract = $state<TractRateItem | null>(null);
	let hoveredNeighbor = $state<BorderCluster | null>(null);
	let hoveredStreet = $state<StreetSummary | null>(null);

	const cluster = $derived(shard.cluster);
	const tracts = $derived(shard.tractRates ?? []);
	const neighbors = $derived(shard.borderClusters.slice(0, 6));
	const streets = $derived(shard.streetsList);

	const activeNeighbor = $derived.by(() => {
		if (hoveredNeighbor) return hoveredNeighbor;
		if (highlightedNeighborId) {
			return shard.borderClusters.find((n) => n.id === highlightedNeighborId) ?? null;
		}
		return null;
	});

	// Shared clean horizontal scale from 0% up to at least 40% (or enough to fit tracts + neighbors)
	const maxScale = $derived.by(() => {
		const vals = [
			cluster.vacancy_rate,
			cityRate,
			...tracts.map((t) => t.rate),
			...neighbors.map((n) => n.vacancy_rate),
			...streets.filter((s) => s.total >= 5).map((s) => s.rate)
		];
		const hi = Math.max(0.35, ...vals);
		return Math.min(0.8, Math.ceil(hi * 10) / 10);
	});

	function xPct(rate: number): number {
		return Math.max(0, Math.min(100, (rate / maxScale) * 100));
	}

	// Tract min-max spread (what our clustering algorithm grouped together)
	const tractSpan = $derived.by(() => {
		if (tracts.length === 0) return null;
		const sorted = [...tracts].map((t) => t.rate).sort((a, b) => a - b);
		return { min: sorted[0], max: sorted[sorted.length - 1] };
	});

	// Street IQR (25th-75th percentile across streets with >= 5 storefronts)
	const streetIqr = $derived.by(() => {
		const list = streets.filter((s) => s.total >= 5).map((s) => s.rate).sort((a, b) => a - b);
		if (list.length < 3) return null;
		const q25 = list[Math.floor(list.length * 0.25)];
		const q75 = list[Math.floor(list.length * 0.75)];
		return { q25, q75 };
	});

	const activeStreet = $derived.by(() => {
		if (hoveredStreet) return hoveredStreet;
		if (highlightedStreetSlug) {
			return streets.find((s) => s.slug === highlightedStreetSlug) ?? null;
		}
		return null;
	});

	function dotColor(r: number): string {
		if (r >= 0.25) return '#8f1422';
		if (r >= 0.16) return '#d9381e';
		if (r >= 0.10) return '#e4724e';
		if (r > 0) return '#ebb09c';
		return '#9e9e98';
	}

	function dotSize(total: number): number {
		return Math.round(Math.max(5.5, Math.min(11, 4.5 + Math.sqrt(total) * 0.7)));
	}

	const blockDist = $derived(cluster.block_dist ?? [0, 0, 0, 0]);
	const blockTotal = $derived(Math.max(1, blockDist[0] + blockDist[1] + blockDist[2] + blockDist[3]));
</script>

<section class="cohesion surface">
	<div class="coh-head">
		<span class="kicker">Why These Streets Are Grouped</span>
		<span class="coh-summary">
			{#if tractSpan && tracts.length > 1}
				Range here: {pct(tractSpan.min, 0)}–{pct(tractSpan.max, 0)}
			{:else}
				Cluster avg {pct(cluster.vacancy_rate, 1)}
			{/if}
		</span>
	</div>

	<!-- TRACK 1: Inside This Cluster vs. Neighboring Clusters -->
	<div class="track-block">
		<div class="track-label">
			{#if hoveredTract}
				<span class="tl-left">
					<i class="swatch-fill" style="background:{dotColor(hoveredTract.rate)}"></i>
					<strong>Area inside cluster</strong>
				</span>
				<span class="track-readout">{pct(hoveredTract.rate, 1)} ({hoveredTract.vacant}/{hoveredTract.total})</span>
			{:else if activeNeighbor}
				<span class="tl-left">
					<i class="swatch-ring"></i>
					<strong>{activeNeighbor.name.split(':')[0]}</strong>
				</span>
				<span class="track-readout">{pct(activeNeighbor.vacancy_rate, 1)} ↗</span>
			{:else}
				<span class="tl-left">Inside <i class="swatch-fill"></i> vs. neighbors <i class="swatch-ring"></i></span>
				<span class="track-readout">NYC avg {pct(cityRate, 1)}</span>
			{/if}
		</div>

		<div class="axis-track">
			<!-- Baseline rule -->
			<div class="axis-line"></div>

			<!-- NYC average hairline -->
			<div
				class="nyc-tick"
				style="left:{xPct(cityRate)}%"
				title="NYC citywide average: {pct(cityRate, 1)}"
			></div>

			<!-- Cluster tract span band -->
			{#if tractSpan}
				<div
					class="span-band"
					style="left:{xPct(tractSpan.min)}%; width:{Math.max(1.5, xPct(tractSpan.max) - xPct(tractSpan.min))}%"
				></div>
			{/if}

			<!-- Cluster mean vertical tick -->
			<div
				class="mean-tick"
				style="left:{xPct(cluster.vacancy_rate)}%"
				title="This cluster: {pct(cluster.vacancy_rate, 1)}"
			></div>

			<!-- Hollow clickable rings for bordering clusters -->
			{#each neighbors as nb (nb.id)}
				<button
					type="button"
					class="nb-ring"
					class:hot={activeNeighbor?.id === nb.id}
					style="left:{xPct(nb.vacancy_rate)}%"
					title="{nb.name}: {pct(nb.vacancy_rate, 1)} (click to open)"
					aria-label="Neighboring cluster {nb.name} at {pct(nb.vacancy_rate, 1)}"
					onmouseenter={() => {
						hoveredNeighbor = nb;
						onHoverNeighbor(nb.id);
					}}
					onmouseleave={() => {
						hoveredNeighbor = null;
						onHoverNeighbor(null);
					}}
					onclick={() => goto(`/cluster/${nb.id}`)}
				></button>
			{/each}

			<!-- Filled dots for constituent Census Tracts inside this cluster -->
			{#each tracts as tr (tr.id)}
				<span
					class="tract-dot"
					style="left:{xPct(tr.rate)}%; background:{dotColor(tr.rate)}"
					role="presentation"
					title="Area inside cluster: {pct(tr.rate, 1)} ({tr.vacant}/{tr.total} storefronts)"
					onmouseenter={() => (hoveredTract = tr)}
					onmouseleave={() => (hoveredTract = null)}
				></span>
			{/each}
		</div>
	</div>

	<!-- TRACK 2: Street-by-Street Spread (bidirectionally synced with SVG grid!) -->
	<div class="track-block">
		<div class="track-label">
			{#if activeStreet}
				<span class="tl-left">
					<i class="swatch-fill" style="background:{dotColor(activeStreet.rate)}"></i>
					<strong>{activeStreet.name}</strong>
				</span>
				<span class="track-readout">{pct(activeStreet.rate, 1)} ({activeStreet.vacant}/{activeStreet.total})</span>
			{:else}
				<span class="tl-left">Individual streets ({streets.length})</span>
				<span class="track-readout">
					{#if streetIqr}
						Mid 50%: {pct(streetIqr.q25, 0)}–{pct(streetIqr.q75, 0)}
					{:else}
						Hover any dot
					{/if}
				</span>
			{/if}
		</div>

		<div class="axis-track">
			<div class="axis-line"></div>
			<div class="nyc-tick" style="left:{xPct(cityRate)}%"></div>

			{#if streetIqr}
				<div
					class="span-band iqr"
					style="left:{xPct(streetIqr.q25)}%; width:{Math.max(1.5, xPct(streetIqr.q75) - xPct(streetIqr.q25))}%"
				></div>
			{/if}

			<div class="mean-tick" style="left:{xPct(cluster.vacancy_rate)}%"></div>

			{#each streets as st (st.slug)}
				{@const isHot = activeStreet?.slug === st.slug}
				{@const sz = dotSize(st.total)}
				<button
					type="button"
					class="street-dot"
					class:hot={isHot}
					style="left:{xPct(st.rate)}%; width:{sz}px; height:{sz}px; background:{dotColor(st.rate)}"
					title="{st.name}: {pct(st.rate, 1)} ({st.vacant}/{st.total})"
					aria-label="{st.name}: {pct(st.rate, 1)}"
					onmouseenter={() => {
						hoveredStreet = st;
						onHoverStreet(st.slug);
					}}
					onmouseleave={() => {
						hoveredStreet = null;
						onHoverStreet(null);
					}}
					onclick={() => {
						if (st.segmentIds[0]) goto(`/cluster/${cluster.id}/block/${st.segmentIds[0]}`);
					}}
				></button>
			{/each}
		</div>

		<!-- Shared Numeric Axis Ticks -->
		<div class="axis-scale">
			<span>0%</span>
			<span>{Math.round(maxScale * 50)}%</span>
			<span>{Math.round(maxScale * 100)}%+</span>
		</div>
	</div>

	<!-- Compact 4-Bucket 1-Block Distribution Bar -->
	<div class="dist-footer">
		<div class="dist-bar" aria-hidden="true">
			{#if blockDist[0] > 0}<span class="d0" style="width:{(blockDist[0] / blockTotal) * 100}%"></span>{/if}
			{#if blockDist[1] > 0}<span class="d1" style="width:{(blockDist[1] / blockTotal) * 100}%"></span>{/if}
			{#if blockDist[2] > 0}<span class="d2" style="width:{(blockDist[2] / blockTotal) * 100}%"></span>{/if}
			{#if blockDist[3] > 0}<span class="d3" style="width:{(blockDist[3] / blockTotal) * 100}%"></span>{/if}
		</div>
		<div class="dist-labels">
			<span><b>{blockDist[0]}</b> clear (0%)</span>
			<span><b>{blockDist[1]}</b> 1–14%</span>
			<span><b>{blockDist[2]}</b> 15–29%</span>
			<span class="hot"><b>{blockDist[3]}</b> 30%+</span>
		</div>
	</div>
</section>

<style>
	.cohesion {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.coh-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.coh-summary {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-soft);
	}

	.track-block {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.track-label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		height: 18px;
		line-height: 18px;
		flex-wrap: nowrap;
		overflow: hidden;
		font-size: 11px;
		color: var(--muted);
	}

	.tl-left {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tl-left strong {
		color: var(--ink);
		font-weight: 600;
	}

	.swatch-fill,
	.swatch-ring {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		vertical-align: -1px;
		margin: 0 3px 0 0;
	}

	.swatch-fill {
		background: var(--red);
	}

	.swatch-ring {
		background: #ffffff;
		border: 1.5px solid var(--ink);
	}

	.track-readout {
		flex: none;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-soft);
		white-space: nowrap;
		text-align: right;
	}

	.axis-track {
		position: relative;
		height: 24px;
		width: 100%;
	}

	.axis-line {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 1px;
		background: var(--rule);
	}

	.nyc-tick {
		position: absolute;
		top: 3px;
		bottom: 3px;
		width: 0;
		border-left: 1px dashed #b5b5ae;
		pointer-events: none;
	}

	.span-band {
		position: absolute;
		top: 6px;
		bottom: 6px;
		background: rgba(217, 56, 30, 0.11);
		border-radius: 3px;
		pointer-events: none;
	}

	.span-band.iqr {
		background: rgba(17, 17, 17, 0.06);
	}

	.mean-tick {
		position: absolute;
		top: 2px;
		bottom: 2px;
		width: 1.5px;
		background: var(--ink);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.tract-dot {
		position: absolute;
		top: 50%;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1.5px solid #ffffff;
		transform: translate(-50%, -50%);
		cursor: default;
		z-index: 3;
	}

	.nb-ring {
		position: absolute;
		top: 50%;
		width: 10px;
		height: 10px;
		padding: 0;
		border-radius: 50%;
		background: #ffffff;
		border: 1.5px solid #6b6b66;
		transform: translate(-50%, -50%);
		cursor: pointer;
		z-index: 2;
		transition: transform 0.1s ease, border-color 0.1s ease;
	}

	.nb-ring:hover,
	.nb-ring.hot {
		border-color: var(--ink);
		border-width: 2px;
		transform: translate(-50%, -50%) scale(1.35);
		z-index: 6;
	}

	.street-dot {
		position: absolute;
		top: 50%;
		padding: 0;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.85);
		transform: translate(-50%, -50%);
		cursor: pointer;
		opacity: 0.82;
		transition: transform 0.1s ease, opacity 0.1s ease;
		z-index: 2;
	}

	.street-dot:hover,
	.street-dot.hot {
		opacity: 1;
		border: 2px solid var(--ink);
		transform: translate(-50%, -50%) scale(1.45);
		z-index: 8;
	}

	.axis-scale {
		display: flex;
		justify-content: space-between;
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--muted-light);
		margin-top: 1px;
	}

	.dist-footer {
		padding-top: 10px;
		border-top: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.dist-bar {
		display: flex;
		height: 5px;
		border-radius: 3px;
		overflow: hidden;
		gap: 1.5px;
		background: var(--quiet);
	}

	.dist-bar span {
		display: block;
		height: 100%;
	}

	.dist-bar .d0 {
		background: #d0d0ca;
	}

	.dist-bar .d1 {
		background: #ebb09c;
	}

	.dist-bar .d2 {
		background: #e4724e;
	}

	.dist-bar .d3 {
		background: #8f1422;
	}

	.dist-labels {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
	}

	.dist-labels b {
		color: var(--ink);
		font-weight: 600;
	}

	.dist-labels .hot b {
		color: var(--red);
	}
</style>
