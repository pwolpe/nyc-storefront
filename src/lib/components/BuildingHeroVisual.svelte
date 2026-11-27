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
	let mapContainer = $state<HTMLDivElement | null>(null);
	let mapInstance: import('maplibre-gl').Map | null = null;
	let loadedMapMode = $state<'parcel' | 'aerial' | null>(null);

	// Reset cleanly when switching buildings
	$effect(() => {
		const avail = dossier.streetViewAvailable;
		imgFailed = false;
		mode = avail ? 'street' : 'parcel';
	});

	const shortCaptureDate = $derived.by(() => {
		const raw = visionAudit?.captureDate || dossier.streetViewDate;
		if (!raw) return null;
		const [yr, mo] = raw.split('-');
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const mIdx = parseInt(mo || '', 10) - 1;
		return mIdx >= 0 && mIdx < 12 ? `${months[mIdx]} ${yr}` : yr;
	});

	const latestDof = $derived(dossier.dofHistory[0] ?? null);

	const auditMetaBadge = $derived.by(() => {
		if (!visionAudit) return null;
		const dofYr = latestDof?.year ?? 2025;
		if (visionAudit.discrepancy?.flagged) {
			return shortCaptureDate
				? `${shortCaptureDate} photo vs. ${dofYr} filing`
				: `Photo vs. ${dofYr} filing`;
		}
		if (latestDof) {
			const dofVacantAll = latestDof.vacant > 0 && latestDof.occupied === 0;
			const dofOpenAll = latestDof.vacant === 0 && latestDof.occupied > 0;
			if (
				(dofVacantAll && visionAudit.visualStatus === 'vacant') ||
				(dofOpenAll && visionAudit.visualStatus === 'open')
			) {
				return `Matches ${dofYr} filing`;
			}
		}
		return shortCaptureDate ? `${shortCaptureDate} photo` : null;
	});

	const cameraStatusLabel = $derived.by(() => {
		if (!visionAudit) return '';
		const map: Record<StreetViewAuditResult['visualStatus'], string> = {
			open: 'Open',
			vacant: 'Vacant',
			construction: 'Construction',
			unclear: 'Check'
		};
		return map[visionAudit.visualStatus] || 'Check';
	});

	const showAuditStrip = $derived(
		Boolean(dossier.streetViewAvailable && !imgFailed && (visionLoading || visionAudit?.summary))
	);

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

<div class="hero-visual surface" class:has-audit={showAuditStrip}>
	<!-- Visual Viewport (100% unobstructed storefront photo / map) -->
	<div class="hv-frame">
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
		{:else if dossier.lat !== null && dossier.lng !== null}
			<div class="map-canvas" bind:this={mapContainer}></div>
			<div class="hv-caption">
				{loadedMapMode === 'aerial' ? 'SATELLITE AERIAL · PARCEL FOOTPRINT' : 'MAPPLUTO SURVEYED PARCEL'}
			</div>
		{:else}
			<div class="hv-empty">Location coordinates unavailable for this BBL</div>
		{/if}
	</div>

	<!-- Integrated Street View Audit Footer (docked below photo, never covering the storefront) -->
	{#if showAuditStrip}
		{#if visionLoading && !visionAudit}
			<div class="hv-audit loading" aria-live="polite">
				<div class="va-head">
					<span class="va-kicker muted">
						<span class="va-dot pulse" aria-hidden="true"></span>
						Street View check · Inspecting ground floor…
					</span>
				</div>
				<div class="va-shimmer" aria-hidden="true">
					<span class="va-sh w1"></span>
					<span class="va-sh w2"></span>
				</div>
			</div>
		{:else if visionAudit && visionAudit.summary}
			<div
				class="hv-audit"
				class:is-gap={Boolean(visionAudit.discrepancy?.flagged)}
				role="region"
				aria-label="Street View Camera Check"
			>
				<div class="va-head">
					<div class="va-title-group">
						{#if visionAudit.discrepancy?.flagged}
							<span class="va-kicker gap">Reality Gap</span>
							<span class="va-headline">{visionAudit.discrepancy.headline}</span>
						{:else}
							<span class="va-dot status-{visionAudit.visualStatus}" aria-hidden="true"></span>
							<span class="va-kicker">
								Street View · {cameraStatusLabel}
							</span>
							{#if visionAudit.signageText}
								<span class="va-signage" title={visionAudit.signageText}>“{visionAudit.signageText}”</span>
							{/if}
						{/if}
					</div>
					{#if auditMetaBadge}
						<span class="va-meta" class:gap={Boolean(visionAudit.discrepancy?.flagged)}>
							{auditMetaBadge}
						</span>
					{/if}
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
		{/if}
	{/if}
</div>

<style>
	.hero-visual {
		position: relative;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		background: var(--panel);
	}

	.hv-frame {
		position: relative;
		width: 100%;
		height: 316px;
		background: #eaeae5;
		flex: none;
	}

	.hero-visual.has-audit .hv-frame {
		height: 280px;
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

	/* Docked Swiss Editorial Street View Audit Strip */
	.hv-audit {
		padding: 10px 13px 11px;
		border-top: 1px solid var(--rule);
		background: var(--panel);
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.hv-audit.is-gap {
		background: #fdf6f5;
		box-shadow: inset 3px 0 0 var(--red);
		padding-left: 14px;
	}

	.va-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
	}

	.va-title-group {
		display: inline-flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 6px;
		min-width: 0;
	}

	.va-kicker {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}

	.va-kicker.muted {
		color: var(--muted);
	}

	.va-kicker.gap {
		color: var(--red);
		font-weight: 700;
	}

	.va-headline {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.3;
	}

	.va-signage {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink);
		max-width: 190px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.va-meta {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 500;
		color: var(--muted);
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--page);
		border: 1px solid var(--rule);
		flex: none;
	}

	.va-meta.gap {
		background: var(--red-bg);
		border-color: #f4c6be;
		color: var(--red);
	}

	.va-dot {
		width: 6px;
		height: 6px;
		border-radius: 99px;
		background: var(--muted-light);
		flex: none;
		align-self: center;
	}

	.va-dot.status-open {
		background: var(--green);
	}

	.va-dot.status-vacant {
		background: var(--red);
	}

	.va-dot.status-construction {
		background: var(--amber);
	}

	.va-dot.pulse {
		background: var(--accent);
		animation: vaPulse 0.9s infinite ease-in-out;
	}

	@keyframes vaPulse {
		0%, 100% { opacity: 0.35; }
		50% { opacity: 1; }
	}

	.va-summary {
		margin: 0;
		font-size: 12.2px;
		line-height: 1.44;
		color: var(--ink-soft);
	}

	.hv-audit.is-gap .va-summary {
		color: var(--ink);
	}

	.va-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 1px;
	}

	.va-tag {
		font-family: var(--font-mono);
		font-size: 9.5px;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--page);
		border: 1px solid var(--rule);
		color: var(--muted);
	}

	.hv-audit.is-gap .va-tag {
		background: rgba(255, 255, 255, 0.72);
		border-color: #edd5d1;
		color: var(--ink-soft);
	}

	.va-shimmer {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 3px 0 2px;
	}

	.va-sh {
		display: block;
		height: 10px;
		border-radius: 4px;
		background: linear-gradient(90deg, #efefe9 25%, #e4e4dc 50%, #efefe9 75%);
		background-size: 200% 100%;
		animation: vaShimmer 1.35s infinite ease-in-out;
	}

	.va-sh.w1 { width: 92%; }
	.va-sh.w2 { width: 64%; }

	@keyframes vaShimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
