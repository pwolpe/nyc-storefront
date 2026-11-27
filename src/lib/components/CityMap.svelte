<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import maplibregl from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { ClusterProps, ClustersFile, ComptrollerSummary } from '$lib/types';
	import { pct, numFmt, rateTone, deltaPts, deltaTone, signedNum } from '$lib/format';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import {
		BASEMAP_STYLE,
		VACANCY_COLOR_EXPR,
		VACANCY_OPACITY_EXPR,
		TREND_COLOR_EXPR,
		TREND_OPACITY_EXPR,
		spotlightOpacityExpr,
		prepareStreetGridBasemap,
		type MapColorMode
	} from '$lib/mapStyle';

	interface Props {
		clustersData: ClustersFile;
		comptroller?: ComptrollerSummary | null;
	}

	let { clustersData, comptroller = null }: Props = $props();

	let mapContainer: HTMLDivElement;
	let map: maplibregl.Map | null = null;
	let hovered = $state<ClusterProps | null>(null);
	let colorMode = $state<MapColorMode>('vacancy');
	let activeBorough = $state<string>('NYC');
	let edgeMarkers: maplibregl.Marker[] = [];

	const BOROUGH_VIEWS: Array<{ key: string; label: string; center: [number, number]; zoom: number }> = [
		{ key: 'NYC', label: 'All', center: [-73.988, 40.74], zoom: 12.1 },
		{ key: 'Manhattan', label: 'MN', center: [-73.982, 40.752], zoom: 12.8 },
		{ key: 'Brooklyn', label: 'BK', center: [-73.962, 40.678], zoom: 12.4 },
		{ key: 'Queens', label: 'QN', center: [-73.865, 40.746], zoom: 12.2 },
		{ key: 'Bronx', label: 'BX', center: [-73.89, 40.848], zoom: 12.5 },
		{ key: 'Staten Island', label: 'SI', center: [-74.122, 40.618], zoom: 12.2 }
	];

	function flyToBorough(key: string) {
		const target = BOROUGH_VIEWS.find((b) => b.key === key);
		if (!target || !map) return;
		activeBorough = key;
		map.flyTo({ center: target.center, zoom: target.zoom, duration: 700, essential: true });
	}

	const starterClusters = $derived.by(() => {
		const big = clustersData.clusters.features
			.map((f) => f.properties)
			.filter((c) => c.total_storefronts >= 65);
		const hardest = [...big].sort((a, b) => b.vacancy_rate - a.vacancy_rate)[0];
		const rebound = [...big]
			.filter((c) => typeof c.yoy_change === 'number' && c.yoy_change < -0.02)
			.sort((a, b) => (a.yoy_change ?? 0) - (b.yoy_change ?? 0))[0];
		const worsening = [...big]
			.filter((c) => typeof c.yoy_change === 'number' && c.yoy_change > 0.02)
			.sort((a, b) => (b.yoy_change ?? 0) - (a.yoy_change ?? 0))[0];

		const items: Array<{ label: string; tone: 'hot' | 'better' | 'worse'; c: ClusterProps }> = [];
		if (hardest) items.push({ label: 'Most empty', tone: 'hot', c: hardest });
		if (rebound && rebound.id !== hardest?.id)
			items.push({ label: 'Biggest rebound', tone: 'better', c: rebound });
		if (worsening && worsening.id !== hardest?.id && worsening.id !== rebound?.id)
			items.push({ label: 'Fastest rising', tone: 'worse', c: worsening });
		return items;
	});

	const quarterSpark = $derived(
		(comptroller?.quarters || []).map((q) => ({
			label: q.quarter.replace(/^20/, "'"),
			value: q.vacancyRate
		}))
	);

	const hoveredSpark = $derived(
		(hovered?.history || []).map((h) => ({
			label: String(h.year).slice(-2),
			value: h.rate
		}))
	);

	function findCluster(id: string): ClusterProps | null {
		return clustersData.clusters.features.find((f) => f.properties.id === id)?.properties ?? null;
	}

	function clearEdgeMarkers() {
		for (const m of edgeMarkers) m.remove();
		edgeMarkers = [];
	}

	/**
	 * Places whisper-quiet Swiss mono micro-labels cleanly OUTSIDE each edge of the hovered cluster.
	 * Uses directional anchors (N->bottom, S->top, W->right, E->left) so labels grow outward away
	 * from the polygon — keeping even compact 50px Manhattan clusters 100% unobstructed and readable.
	 */
	function renderEdgeLabels(cluster: ClusterProps | null) {
		clearEdgeMarkers();
		if (!map || !cluster || !cluster.edge_labels?.length) return;

		const [minLng, minLat, maxLng, maxLat] = cluster.bbox;
		const pSW = map.project([minLng, minLat]);
		const pNE = map.project([maxLng, maxLat]);
		const pxW = Math.abs(pNE.x - pSW.x);
		const pxH = Math.abs(pSW.y - pNE.y);

		// Only hide when zoomed so far out that the polygon is tiny (< 28px)
		if (Math.max(pxW, pxH) < 28) return;

		const centerPt = map.project(cluster.center);
		const placedBoxes: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
		const usedSides = new Set<string>();
		const seenNames = new Set<string>();

		const anchorForSide: Record<'N' | 'S' | 'W' | 'E', maplibregl.PositionAnchor> = {
			N: 'bottom',
			S: 'top',
			W: 'right',
			E: 'left'
		};

		for (const edge of cluster.edge_labels) {
			if (!edge.street || usedSides.has(edge.side) || seenNames.has(edge.street)) continue;

			const edgePt = map.project(edge.coord);
			let dx = edgePt.x - centerPt.x;
			let dy = edgePt.y - centerPt.y;
			const dist = Math.hypot(dx, dy);

			// Nudge anchor 10px outside the polygon boundary along outward direction
			if (dist > 4) {
				dx = (dx / dist) * 10;
				dy = (dy / dist) * 10;
			} else {
				dx = edge.side === 'E' ? 12 : edge.side === 'W' ? -12 : 0;
				dy = edge.side === 'S' ? 12 : edge.side === 'N' ? -12 : 0;
			}

			const outX = edgePt.x + dx;
			const outY = edgePt.y + dy;

			// Estimate label box in screen pixels based on directional anchor
			const estW = Math.max(46, edge.street.length * 6.4 + 14);
			const estH = 20;
			const anchor = anchorForSide[edge.side];
			const box =
				anchor === 'bottom'
					? { x0: outX - estW / 2, y0: outY - estH, x1: outX + estW / 2, y1: outY }
					: anchor === 'top'
						? { x0: outX - estW / 2, y0: outY, x1: outX + estW / 2, y1: outY + estH }
						: anchor === 'right'
							? { x0: outX - estW, y0: outY - estH / 2, x1: outX, y1: outY + estH / 2 }
							: { x0: outX, y0: outY - estH / 2, x1: outX + estW, y1: outY + estH / 2 };

			const pad = 4;
			const collides = placedBoxes.some(
				(b) =>
					!(box.x1 + pad < b.x0 || box.x0 - pad > b.x1 || box.y1 + pad < b.y0 || box.y0 - pad > b.y1)
			);
			if (collides) continue;

			placedBoxes.push(box);
			usedSides.add(edge.side);
			seenNames.add(edge.street);

			const outLngLat = map.unproject([outX, outY]);

			const el = document.createElement('div');
			el.className = 'edge-callout';
			el.textContent = edge.street;

			const marker = new maplibregl.Marker({ element: el, anchor })
				.setLngLat(outLngLat)
				.addTo(map);
			edgeMarkers.push(marker);
		}
	}

	function applyMapColorMode(mode: MapColorMode, activeId: string | null = hovered?.id ?? null) {
		if (!map || !map.getLayer('clusters-fill')) return;
		map.setPaintProperty(
			'clusters-fill',
			'fill-color',
			mode === 'trend' ? TREND_COLOR_EXPR : VACANCY_COLOR_EXPR
		);
		map.setPaintProperty(
			'clusters-fill',
			'fill-opacity',
			activeId
				? spotlightOpacityExpr(activeId, mode)
				: mode === 'trend'
					? TREND_OPACITY_EXPR
					: VACANCY_OPACITY_EXPR
		);
	}

	function setColorMode(mode: MapColorMode) {
		colorMode = mode;
		applyMapColorMode(mode, hovered?.id ?? null);
	}

	function setSpotlight(activeId: string | null) {
		if (!map || !map.getLayer('clusters-fill')) return;
		if (activeId) {
			map.setPaintProperty('clusters-fill', 'fill-opacity', spotlightOpacityExpr(activeId, colorMode));
			map.setPaintProperty('clusters-outline', 'line-color', [
				'case',
				['==', ['get', 'id'], activeId],
				'#111111',
				'rgba(17, 17, 17, 0.14)'
			]);
			map.setPaintProperty('clusters-outline', 'line-width', [
				'case',
				['==', ['get', 'id'], activeId],
				2.0,
				0.75
			]);
			map.setFilter('clusters-hover-casing', ['==', ['get', 'id'], activeId]);
		} else {
			map.setPaintProperty(
				'clusters-fill',
				'fill-opacity',
				colorMode === 'trend' ? TREND_OPACITY_EXPR : VACANCY_OPACITY_EXPR
			);
			map.setPaintProperty('clusters-outline', 'line-color', 'rgba(17, 17, 17, 0.24)');
			map.setPaintProperty('clusters-outline', 'line-width', 0.85);
			map.setFilter('clusters-hover-casing', ['==', ['get', 'id'], '__none__']);
		}
	}

	onMount(() => {
		map = new maplibregl.Map({
			container: mapContainer,
			style: BASEMAP_STYLE,
			center: [-73.988, 40.74],
			zoom: 12.7,
			minZoom: 9.8,
			maxZoom: 16.5,
			attributionControl: { compact: true }
		});

		map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

		map.on('load', () => {
			if (!map) return;
			const { underRoadsId, underLabelsId } = prepareStreetGridBasemap(map);

			map.addSource('clusters', {
				type: 'geojson',
				data: clustersData.clusters,
				promoteId: 'id'
			});

			map.addLayer(
				{
					id: 'clusters-fill',
					type: 'fill',
					source: 'clusters',
					paint: {
						'fill-color': VACANCY_COLOR_EXPR,
						'fill-opacity': VACANCY_OPACITY_EXPR
					}
				},
				underRoadsId
			);

			// Crisp white outer hairline behind the graphite border so edges read cleanly over any street
			map.addLayer(
				{
					id: 'clusters-hover-casing',
					type: 'line',
					source: 'clusters',
					filter: ['==', ['get', 'id'], '__none__'],
					paint: {
						'line-color': 'rgba(255, 255, 255, 0.92)',
						'line-width': 4.5
					}
				},
				underLabelsId
			);

			map.addLayer(
				{
					id: 'clusters-outline',
					type: 'line',
					source: 'clusters',
					paint: {
						'line-color': 'rgba(17, 17, 17, 0.24)',
						'line-width': 0.85
					}
				},
				underLabelsId
			);

			let hoveredId: string | null = null;
			const warmedClusters = new Set<string>();
			let clusterWarmTimer: ReturnType<typeof setTimeout> | null = null;
			map.on('mousemove', 'clusters-fill', (e) => {
				if (!map || !e.features?.length) return;
				map.getCanvas().style.cursor = 'pointer';
				const id = String(e.features[0].properties?.id || '');
				if (id && id !== hoveredId) {
					hoveredId = id;
					const c = findCluster(id);
					hovered = c;
					setSpotlight(id);
					renderEdgeLabels(c);
					if (clusterWarmTimer) clearTimeout(clusterWarmTimer);
					if (!warmedClusters.has(id)) {
						clusterWarmTimer = setTimeout(() => {
							warmedClusters.add(id);
							fetch(`/data/clusters/${id}.json`, { priority: 'low' as RequestPriority }).catch(() => {});
						}, 110);
					}
				}
			});

			map.on('mouseleave', 'clusters-fill', () => {
				if (!map) return;
				map.getCanvas().style.cursor = '';
				if (hoveredId) {
					hoveredId = null;
					hovered = null;
					setSpotlight(null);
					clearEdgeMarkers();
				}
			});

			map.on('zoomend', () => {
				if (hovered) renderEdgeLabels(hovered);
			});

			map.on('click', 'clusters-fill', (e) => {
				const id = String(e.features?.[0]?.properties?.id || '');
				if (id) goto(`/cluster/${id}`);
			});
		});
	});

	onDestroy(() => {
		clearEdgeMarkers();
		map?.remove();
	});
</script>

<div class="map-wrap">
	<div bind:this={mapContainer} class="map-canvas"></div>

	{#if hovered}
		<div class="readout surface-float">
			<div class="ro-top">
				<div class="ro-title">
					<span class="ro-borough">{hovered.borough}</span>
					<strong>{hovered.name}</strong>
				</div>
				<div class="ro-rate-col">
					<div class="ro-rate {rateTone(hovered.vacancy_rate)}">
						{pct(hovered.vacancy_rate, 1)}
					</div>
					{#if hovered.yoy_change !== null && hovered.yoy_change !== undefined}
						<span class="ro-delta {deltaTone(hovered.yoy_change, 0.01)}">
							{deltaPts(hovered.yoy_change, 1)} YoY
						</span>
					{/if}
				</div>
			</div>

			<div class="ro-meta-row">
				<div class="ro-meta">
					<span>{numFmt(hovered.vacant_storefronts)} vacant of {numFmt(hovered.total_storefronts)} storefronts</span>
					<span class="ro-sep">·</span>
					<span>Click to open</span>
				</div>
				{#if hoveredSpark.length >= 2}
					<Sparkline
						points={hoveredSpark}
						width={74}
						height={20}
						tone={deltaTone(hovered.yoy_change, 0.01)}
					/>
				{/if}
			</div>

			{#if hovered.borders?.summary}
				<div class="ro-borders">
					{#if hovered.borders.n}
						<span class="rb"><em>N</em> {hovered.borders.n}</span>
					{/if}
					{#if hovered.borders.s}
						<span class="rb"><em>S</em> {hovered.borders.s}</span>
					{/if}
					{#if hovered.borders.w}
						<span class="rb"><em>W</em> {hovered.borders.w}</span>
					{/if}
					{#if hovered.borders.e}
						<span class="rb"><em>E</em> {hovered.borders.e}</span>
					{/if}
				</div>
			{/if}

			{#if hovered.block_dist}
				{@const [b0, b1, b2, b3] = hovered.block_dist}
				{@const bSum = Math.max(1, b0 + b1 + b2 + b3)}
				<div class="ro-dist">
					<div class="dist-bar" aria-hidden="true">
						{#if b0 > 0}<span class="d0" style="width:{(b0 / bSum) * 100}%"></span>{/if}
						{#if b1 > 0}<span class="d1" style="width:{(b1 / bSum) * 100}%"></span>{/if}
						{#if b2 > 0}<span class="d2" style="width:{(b2 / bSum) * 100}%"></span>{/if}
						{#if b3 > 0}<span class="d3" style="width:{(b3 / bSum) * 100}%"></span>{/if}
					</div>
					<div class="dist-caption">
						<span>{Math.round((b0 / bSum) * 100)}% blocks clear</span>
						{#if b3 > 0}
							<span class="dist-hot">{b3} blocks ≥30% empty</span>
						{:else}
							<span>{bSum} blocks total</span>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{:else}
		<div class="readout idle surface-float">
			{#if comptroller}
				{@const hl = comptroller.headline}
				<div class="pulse-top">
					<div>
						<span class="ro-borough">NYC CITYWIDE · {hl.quarter} (COMPTROLLER)</span>
						<div class="pulse-headline">
							<strong class="pulse-rate">{pct(hl.vacancyRate, 2)}</strong>
							<span class="pulse-delta {deltaTone(hl.rateChange, 0.0002)}">
								{deltaPts(hl.rateChange, 2)} vs Q2
							</span>
						</div>
					</div>
					{#if quarterSpark.length >= 2}
						<Sparkline
							points={quarterSpark}
							width={108}
							height={28}
							tone={deltaTone(hl.rateChange, 0.0002)}
							showEndpoints
						/>
					{/if}
				</div>

				<div class="pulse-flow">
					<span><b>{numFmt(hl.openings)}</b> opened</span>
					<span class="ro-sep">·</span>
					<span><b>{numFmt(hl.closings)}</b> closed</span>
					<span class="ro-sep">·</span>
					<span class="flow-net {hl.netChange !== null && hl.netChange < 0 ? 'worse' : 'better'}">
						<b>{signedNum(hl.netChange)}</b> net
					</span>
					{#if hl.smallBizNetChange !== null}
						<span class="flow-sb">({signedNum(hl.smallBizNetChange)} small biz)</span>
					{/if}
				</div>

				{#if starterClusters.length > 0}
					<div class="starter-row" aria-label="Notable clusters to explore">
						{#each starterClusters as item}
							<a
								href="/cluster/{item.c.id}"
								class="starter-chip tone-{item.tone}"
								title="{item.c.name} ({pct(item.c.vacancy_rate, 1)})"
							>
								<span class="sc-tag">{item.label}</span>
								<strong>{item.c.name.split(':')[0]}</strong>
							</a>
						{/each}
					</div>
				{/if}

				<div class="pulse-foot">
					<span class="pulse-hint">Hover any cluster · Click to inspect blocks</span>
					<a href="/trends" class="pulse-link">Trends →</a>
				</div>
			{:else}
				<div class="ro-title">
					<span class="ro-borough">NYC DOF 2025 · {clustersData.meta.clusterCount} CLUSTERS</span>
					<strong>Commercial Storefront Vacancy</strong>
				</div>
				<div class="ro-meta">
					Hover any cluster to inspect its street boundaries. Click to explore its streets and blocks.
				</div>
			{/if}
		</div>
	{/if}

	<div class="map-controls-bar">
		<div class="mode-toggle surface-float" role="group" aria-label="Map coloring">
			<button
				type="button"
				class:active={colorMode === 'vacancy'}
				onclick={() => setColorMode('vacancy')}
			>
				Vacancy
			</button>
			<button
				type="button"
				class:active={colorMode === 'trend'}
				onclick={() => setColorMode('trend')}
			>
				1-Yr Trend
			</button>
		</div>

		<div class="mode-toggle boro-toggle surface-float" role="group" aria-label="Jump to borough">
			{#each BOROUGH_VIEWS as b}
				<button
					type="button"
					class:active={activeBorough === b.key}
					onclick={() => flyToBorough(b.key)}
					title="Fly to {b.key}"
				>
					{b.label}
				</button>
			{/each}
		</div>

		<div class="legend surface-float" aria-label="Map color scale">
			{#if colorMode === 'vacancy'}
				<span class="lg-label">VACANCY</span>
				<span class="lg-step"><i class="clear"></i>&lt;10%</span>
				<span class="lg-step"><i style="background:rgba(235,107,73,0.45)"></i>10–15%</span>
				<span class="lg-step"><i style="background:rgba(224,72,38,0.62)"></i>15–20%</span>
				<span class="lg-step"><i style="background:rgba(196,40,28,0.75)"></i>20–28%</span>
				<span class="lg-step"><i style="background:rgba(140,20,32,0.88)"></i>28%+</span>
			{:else}
				<span class="lg-label">2024 → 2025</span>
				<span class="lg-step"><i style="background:rgba(14,110,72,0.78)"></i>≤-4 pts</span>
				<span class="lg-step"><i style="background:rgba(31,138,91,0.45)"></i>-4 to -1.5</span>
				<span class="lg-step"><i class="clear"></i>Flat</span>
				<span class="lg-step"><i style="background:rgba(224,72,38,0.48)"></i>+1.5 to +4</span>
				<span class="lg-step"><i style="background:rgba(155,28,36,0.78)"></i>+4+ pts</span>
			{/if}
		</div>
	</div>
</div>

<style>
	.map-wrap {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.map-canvas {
		position: absolute;
		inset: 0;
	}

	/* Whisper-quiet outward-offset perimeter labels — never obscure the cluster interior */
	:global(.edge-callout) {
		pointer-events: none;
		padding: 2px 7px;
		background: rgba(255, 255, 255, 0.94);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		color: #111111;
		border: 1px solid rgba(17, 17, 17, 0.18);
		border-radius: 4px;
		box-shadow: 0 2px 6px rgba(17, 17, 17, 0.10);
		font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
		line-height: 1.35;
	}

	.readout {
		position: absolute;
		top: 16px;
		left: 16px;
		z-index: 4;
		padding: 12px 14px;
		pointer-events: none;
		width: min(390px, calc(100vw - 32px));
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ro-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.ro-title {
		min-width: 0;
	}

	.ro-borough {
		display: block;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted);
		margin-bottom: 2px;
	}

	.ro-title strong {
		display: block;
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--ink);
		line-height: 1.25;
	}

	.ro-rate {
		flex: none;
		font-family: var(--font-mono);
		font-size: 16px;
		font-weight: 600;
		padding: 2px 7px;
		border-radius: 5px;
		background: var(--quiet);
		color: var(--ink);
	}

	.ro-rate.hot {
		background: var(--red-bg);
		color: var(--red);
	}

	.ro-rate.thriving {
		background: var(--green-bg);
		color: var(--green);
	}

	.ro-meta {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.4;
	}

	.ro-sep {
		margin: 0 5px;
		color: var(--line);
	}

	.ro-borders {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px 12px;
		padding-top: 8px;
		margin-top: 2px;
		border-top: 1px solid var(--rule);
	}

	.rb {
		display: flex;
		align-items: baseline;
		gap: 6px;
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rb em {
		font-style: normal;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--muted);
		width: 12px;
		flex: none;
	}

	.ro-dist {
		padding-top: 7px;
		border-top: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.dist-bar {
		display: flex;
		height: 4px;
		border-radius: 2px;
		overflow: hidden;
		gap: 1px;
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

	.dist-caption {
		display: flex;
		justify-content: space-between;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
	}

	.dist-hot {
		color: var(--red);
		font-weight: 500;
	}

	.readout.idle {
		pointer-events: auto;
	}

	.ro-rate-col {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 3px;
		flex: none;
	}

	.ro-delta {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		line-height: 1;
	}

	.ro-delta.worse,
	.pulse-delta.worse,
	.flow-net.worse {
		color: var(--red);
	}

	.ro-delta.better,
	.pulse-delta.better,
	.flow-net.better {
		color: var(--green);
	}

	.ro-delta.flat,
	.pulse-delta.flat {
		color: var(--muted);
	}

	.ro-meta-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.pulse-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.pulse-headline {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-top: 2px;
	}

	.pulse-rate {
		font-family: var(--font-mono);
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.03em;
		color: var(--ink);
		line-height: 1.05;
	}

	.pulse-delta {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
	}

	.pulse-flow {
		font-size: 11.5px;
		color: var(--ink-soft);
		padding-top: 6px;
		border-top: 1px solid var(--rule);
		line-height: 1.4;
	}

	.pulse-flow b {
		font-family: var(--font-mono);
		font-weight: 600;
		color: var(--ink);
	}

	.flow-net b {
		color: inherit;
	}

	.flow-sb {
		color: var(--muted);
		font-size: 11px;
		margin-left: 3px;
	}

	.pulse-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-top: 6px;
		border-top: 1px solid var(--rule);
		font-size: 11px;
	}

	.starter-row {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--rule);
	}

	.starter-chip {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 5px 7px;
		border-radius: 5px;
		border: 1px solid var(--rule);
		background: var(--page);
		text-decoration: none;
		color: var(--ink);
		min-width: 0;
		transition: border-color 0.12s ease, background 0.12s ease;
	}

	.starter-chip:hover {
		border-color: var(--ink);
		background: var(--panel);
	}

	.starter-chip .sc-tag {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
	}

	.starter-chip.tone-hot .sc-tag,
	.starter-chip.tone-worse .sc-tag {
		color: var(--red);
	}

	.starter-chip.tone-better .sc-tag {
		color: var(--green);
	}

	.starter-chip strong {
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.boro-toggle button {
		padding: 4px 7px;
	}

	.pulse-hint {
		color: var(--muted);
	}

	.pulse-link {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--ink);
		text-decoration: none;
		white-space: nowrap;
	}

	.pulse-link:hover {
		color: var(--accent);
	}

	.map-controls-bar {
		position: absolute;
		bottom: 16px;
		left: 16px;
		z-index: 3;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.mode-toggle {
		display: inline-flex;
		padding: 3px;
		gap: 2px;
	}

	.mode-toggle button {
		border: 0;
		background: transparent;
		padding: 4px 10px;
		border-radius: 5px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--muted);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.mode-toggle button:hover {
		color: var(--ink);
	}

	.mode-toggle button.active {
		background: var(--ink);
		color: #ffffff;
	}

	.legend {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 7px 12px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}

	.lg-label {
		letter-spacing: 0.08em;
		font-weight: 600;
		color: var(--ink);
		padding-right: 4px;
		border-right: 1px solid var(--rule);
	}

	.lg-step {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.lg-step i {
		width: 9px;
		height: 9px;
		border-radius: 2px;
		display: inline-block;
	}

	.lg-step i.clear {
		background: #ffffff;
		border: 1px solid #c8c8c2;
	}
</style>
