<script lang="ts">
	import { onDestroy } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { BuildingDossier, StreetViewAuditResult } from '$lib/types';
	import { streetViewUrl } from '$lib/format';
	import { BASEMAP_STYLE } from '$lib/mapStyle';

	interface Props {
		dossier: BuildingDossier;
		visionAudit?: StreetViewAuditResult | null;
		visionLoading?: boolean;
	}

	let { dossier, visionAudit = null, visionLoading = false }: Props = $props();

	type ViewMode = 'street' | 'parcel' | 'aerial';

	let mode = $state<ViewMode>('street');
	let imgFailed = $state(false);
	let auditExpanded = $state(false);
	let mapContainer = $state<HTMLDivElement | null>(null);
	let mapInstance: import('maplibre-gl').Map | null = null;
	let loadedMapMode = $state<'parcel' | 'aerial' | null>(null);

	// Reset cleanly when switching buildings
	$effect(() => {
		const avail = dossier.streetViewAvailable;
		imgFailed = false;
		mode = avail ? 'street' : 'parcel';
		auditExpanded = false;
	});

	// Auto-expand the sleek bottom card if Vision Audit catches a real filing discrepancy!
	$effect(() => {
		if (visionAudit?.discrepancy?.flagged) {
			auditExpanded = true;
		}
	});

	const visionPillLabel = $derived.by(() => {
		if (!visionAudit) return '';
		if (visionAudit.discrepancy?.flagged) return `⚠ Reality Gap`;
		const statusMap: Record<StreetViewAuditResult['visualStatus'], string> = {
			open: 'Camera: Open',
			vacant: 'Camera: Vacant',
			construction: 'Camera: Construction',
			unclear: 'Camera Audit'
		};
		const base = statusMap[visionAudit.visualStatus] || 'Camera Audit';
		return visionAudit.signageText ? `${base} · “${visionAudit.signageText}”` : base;
	});

	const svImageSrc = $derived.by(() => {
		const params = new URLSearchParams();
		if (dossier.address && !dossier.address.startsWith('BBL ')) {
			params.set('address', `${dossier.address}, ${dossier.borough}, NY`);
		}
		if (dossier.lat !== null && dossier.lng !== null) {
			params.set('lat', String(dossier.lat));
			params.set('lng', String(dossier.lng));
		}
		return `/api/streetview?${params.toString()}`;
	});

	const svDateLabel = $derived.by(() => {
		if (!dossier.streetViewDate) return 'STREET VIEW';
		const [yr, mo] = dossier.streetViewDate.split('-');
		const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
		const mIdx = parseInt(mo || '', 10) - 1;
		return mIdx >= 0 && mIdx < 12 ? `STREET VIEW · ${months[mIdx]} ${yr}` : `STREET VIEW · ${yr}`;
	});

	const parcelColor = $derived.by(() => {
		const latest = dossier.dofHistory[0];
		if (latest && latest.vacant > 0 && latest.occupied === 0) return '#d9381e';
		if (latest && latest.vacant > 0) return '#ff4200';
		if (latest && latest.occupied > 0) return '#15803d';
		return '#3f3f3c';
	});

	async function renderMap(targetMode: 'parcel' | 'aerial') {
		if (!mapContainer || dossier.lat === null || dossier.lng === null) return;
		const maplibregl = (await import('maplibre-gl')).default;

		if (mapInstance) {
			mapInstance.remove();
			mapInstance = null;
		}

		const style: string | import('maplibre-gl').StyleSpecification =
			targetMode === 'parcel'
				? BASEMAP_STYLE
				: {
						version: 8,
						sources: {
							basemap: {
								type: 'raster',
								tiles: [
									'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
								],
								tileSize: 256,
								maxzoom: 19
							}
						},
						layers: [
							{
								id: 'basemap-layer',
								type: 'raster',
								source: 'basemap'
							}
						]
					};

		const map = new maplibregl.Map({
			container: mapContainer,
			style,
			center: [dossier.lng, dossier.lat],
			zoom: 17.2,
			attributionControl: false
		});

		map.on('load', () => {
			if (dossier.parcelGeometry) {
				// Auto-frame the entire surveyed parcel polygon cleanly with breathing room
				const rings =
					dossier.parcelGeometry.type === 'Polygon'
						? dossier.parcelGeometry.coordinates
						: dossier.parcelGeometry.coordinates.flat();
				let minLng = Infinity;
				let maxLng = -Infinity;
				let minLat = Infinity;
				let maxLat = -Infinity;
				for (const ring of rings) {
					for (const [x, y] of ring) {
						if (x < minLng) minLng = x;
						if (x > maxLng) maxLng = x;
						if (y < minLat) minLat = y;
						if (y > maxLat) maxLat = y;
					}
				}
				if (Number.isFinite(minLng) && Number.isFinite(maxLng)) {
					map.fitBounds(
						[
							[minLng, minLat],
							[maxLng, maxLat]
						],
						{ padding: 56, maxZoom: 17.6, duration: 0 }
					);
				}

				map.addSource('parcel', {
					type: 'geojson',
					data: {
						type: 'Feature',
						properties: {},
						geometry: dossier.parcelGeometry
					}
				});
				map.addLayer({
					id: 'parcel-fill',
					type: 'fill',
					source: 'parcel',
					paint: {
						'fill-color': targetMode === 'aerial' ? '#ff4200' : parcelColor,
						'fill-opacity': targetMode === 'aerial' ? 0.24 : 0.32
					}
				});
				map.addLayer({
					id: 'parcel-outline',
					type: 'line',
					source: 'parcel',
					paint: {
						'line-color': targetMode === 'aerial' ? '#ff4200' : parcelColor,
						'line-width': 2.5
					}
				});
			} else if (dossier.lat !== null && dossier.lng !== null) {
				new maplibregl.Marker({ color: parcelColor }).setLngLat([dossier.lng, dossier.lat]).addTo(map);
			}
		});

		mapInstance = map;
		loadedMapMode = targetMode;
	}

	$effect(() => {
		const m = mode;
		const bbl = dossier.bbl;
		void bbl;
		if ((m === 'parcel' || m === 'aerial') && mapContainer) {
			renderMap(m);
		} else if (m === 'street' && mapInstance) {
			mapInstance.remove();
			mapInstance = null;
			loadedMapMode = null;
		}
	});

	onDestroy(() => {
		if (mapInstance) {
			mapInstance.remove();
			mapInstance = null;
		}
	});
</script>

<div class="hero-visual surface">
	<!-- Sleek Mode Switcher -->
	<div class="hv-controls">
		<div class="hv-tabs" role="tablist" aria-label="Building visual mode">
			{#if dossier.streetViewAvailable && !imgFailed}
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'street'}
					class="hv-tab"
					class:active={mode === 'street'}
					onclick={() => (mode = 'street')}
				>
					Street View
				</button>
			{/if}
			{#if dossier.lat !== null && dossier.lng !== null}
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'parcel'}
					class="hv-tab"
					class:active={mode === 'parcel'}
					onclick={() => (mode = 'parcel')}
				>
					Parcel Map
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'aerial'}
					class="hv-tab"
					class:active={mode === 'aerial'}
					onclick={() => (mode = 'aerial')}
				>
					NYC Aerial
				</button>
			{/if}
		</div>

		{#if dossier.lat !== null && dossier.lng !== null}
			<a
				href={streetViewUrl(dossier.lat, dossier.lng)}
				target="_blank"
				rel="noopener noreferrer"
				class="hv-ext"
				title="Open interactive 360° Google Street View"
			>
				360° ↗
			</a>
		{/if}
	</div>

	<!-- Visual Viewport -->
	<div class="hv-frame">
		{#if mode === 'street' && dossier.streetViewAvailable && !imgFailed}
			<img
				src={svImageSrc}
				alt="Street View facade of {dossier.address}"
				class="sv-img"
				onerror={() => {
					imgFailed = true;
					mode = 'parcel';
				}}
			/>
			<div class="hv-caption">{svDateLabel}</div>

			{#if visionLoading && !visionAudit}
				<div class="va-pill loading" aria-live="polite">
					<span class="va-dot"></span>
					<span>Inspecting facade…</span>
				</div>
			{:else if visionAudit && visionAudit.summary}
				{#if auditExpanded}
					<div
						class="va-card"
						class:gap={Boolean(visionAudit.discrepancy?.flagged)}
						role="region"
						aria-label="Street View Vision Audit"
					>
						<div class="va-card-head">
							<span class="va-kicker">
								{#if visionAudit.discrepancy?.flagged}
									⚠ REALITY GAP · {visionAudit.discrepancy.headline}
								{:else}
									👁 VISION AUDIT · {visionPillLabel}
								{/if}
							</span>
							<button
								type="button"
								class="va-close"
								onclick={() => (auditExpanded = false)}
								title="Minimize vision note"
								aria-label="Minimize vision note"
							>
								×
							</button>
						</div>
						<p class="va-summary">{visionAudit.summary}</p>
						{#if visionAudit.signals.length > 0}
							<div class="va-tags">
								{#each visionAudit.signals as sig}
									<span class="va-tag">{sig}</span>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<button
						type="button"
						class="va-pill clickable"
						class:gap={Boolean(visionAudit.discrepancy?.flagged)}
						class:status-open={visionAudit.visualStatus === 'open'}
						class:status-vacant={visionAudit.visualStatus === 'vacant'}
						onclick={() => (auditExpanded = true)}
						title={visionAudit.summary}
					>
						<span>{visionPillLabel}</span>
						<span class="va-more">ⓘ</span>
					</button>
				{/if}
			{/if}
		{:else if dossier.lat !== null && dossier.lng !== null}
			<div class="map-canvas" bind:this={mapContainer}></div>
			<div class="hv-caption">
				{loadedMapMode === 'aerial' ? 'SATELLITE AERIAL · PARCEL FOOTPRINT' : 'MAPPLUTO SURVEYED PARCEL'}
			</div>
		{:else}
			<div class="hv-empty">Location coordinates unavailable for this BBL</div>
		{/if}
	</div>
</div>

<style>
	.hero-visual {
		position: relative;
		overflow: hidden;
		height: 316px;
		background: #eaeae5;
	}

	.hv-controls {
		position: absolute;
		top: 10px;
		left: 10px;
		right: 10px;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		pointer-events: none;
	}

	.hv-tabs {
		pointer-events: auto;
		display: inline-flex;
		padding: 2px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(8px);
		border: 1px solid rgba(17, 17, 17, 0.1);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
	}

	.hv-tab {
		border: 0;
		background: transparent;
		padding: 4px 10px;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: var(--ink-soft);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.hv-tab:hover {
		color: var(--ink);
	}

	.hv-tab.active {
		background: var(--ink);
		color: #ffffff;
	}

	.hv-ext {
		pointer-events: auto;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		text-decoration: none;
		padding: 5px 9px;
		border-radius: 6px;
		background: rgba(17, 17, 17, 0.76);
		backdrop-filter: blur(8px);
		color: #ffffff;
		border: 1px solid rgba(255, 255, 255, 0.16);
		transition: background 0.12s ease;
	}

	.hv-ext:hover {
		background: var(--ink);
	}

	.hv-frame {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.sv-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.map-canvas {
		width: 100%;
		height: 100%;
	}

	.hv-caption {
		position: absolute;
		bottom: 10px;
		left: 10px;
		z-index: 8;
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.07em;
		padding: 3px 8px;
		border-radius: 4px;
		background: rgba(17, 17, 17, 0.74);
		backdrop-filter: blur(6px);
		color: #f4f4f2;
		pointer-events: none;
	}

	.hv-empty {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		color: var(--muted);
	}

	.va-pill {
		position: absolute;
		bottom: 10px;
		right: 10px;
		z-index: 9;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 64%;
		padding: 4px 9px;
		border-radius: 5px;
		border: 1px solid rgba(255, 255, 255, 0.18);
		background: rgba(17, 17, 17, 0.8);
		backdrop-filter: blur(8px);
		color: #f6f6f4;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.va-pill.clickable {
		cursor: pointer;
		transition: background 0.12s ease, transform 0.12s ease;
	}

	.va-pill.clickable:hover {
		background: rgba(17, 17, 17, 0.94);
	}

	.va-pill.status-open {
		border-color: rgba(74, 222, 128, 0.45);
	}

	.va-pill.status-vacant {
		border-color: rgba(248, 113, 113, 0.55);
	}

	.va-pill.gap {
		background: rgba(180, 35, 24, 0.94);
		border-color: rgba(254, 202, 202, 0.65);
		color: #ffffff;
	}

	.va-more {
		opacity: 0.72;
		font-size: 10px;
	}

	.va-dot {
		width: 6px;
		height: 6px;
		border-radius: 99px;
		background: #ff6b4a;
		animation: vaPulse 0.9s infinite ease-in-out;
	}

	@keyframes vaPulse {
		0%, 100% { opacity: 0.35; }
		50% { opacity: 1; }
	}

	.va-card {
		position: absolute;
		left: 10px;
		right: 10px;
		bottom: 10px;
		z-index: 12;
		padding: 9px 11px;
		border-radius: 7px;
		background: rgba(17, 17, 17, 0.88);
		backdrop-filter: blur(10px);
		border: 1px solid rgba(255, 255, 255, 0.18);
		color: #f6f6f4;
		display: flex;
		flex-direction: column;
		gap: 5px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
	}

	.va-card.gap {
		background: rgba(127, 29, 29, 0.92);
		border-color: rgba(254, 202, 202, 0.5);
	}

	.va-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.va-kicker {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #fde68a;
	}

	.va-card:not(.gap) .va-kicker {
		color: #d4d4d0;
	}

	.va-close {
		border: 0;
		background: transparent;
		color: rgba(255, 255, 255, 0.75);
		font-size: 15px;
		line-height: 1;
		cursor: pointer;
		padding: 0 3px;
	}

	.va-close:hover {
		color: #ffffff;
	}

	.va-summary {
		margin: 0;
		font-size: 12px;
		line-height: 1.42;
		color: #ffffff;
	}

	.va-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.va-tag {
		font-family: var(--font-mono);
		font-size: 9.5px;
		padding: 1px 6px;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.14);
		color: #f4f4f2;
	}
</style>
