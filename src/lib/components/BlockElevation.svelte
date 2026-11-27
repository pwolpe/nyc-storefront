<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { warmBuilding } from '$lib/clientCache';
	import type {
		BlockLot,
		BlockNavLinks,
		BlockNavTarget,
		BlockTenantInfo,
		SegmentDetail,
		SegmentSummary,
		TenantRecord
	} from '$lib/types';

	interface Props {
		segment: SegmentDetail;
		shardSegments?: SegmentSummary[];
		sideA: BlockLot[];
		sideB: BlockLot[];
		tenantsByBbl?: Record<string, BlockTenantInfo>;
		availableYears?: number[];
		plutoLoaded: boolean;
		loading: boolean;
		clusterId: string;
	}

	let {
		segment,
		shardSegments = [],
		sideA,
		sideB,
		tenantsByBbl = {},
		availableYears = [],
		plutoLoaded,
		loading,
		clusterId
	}: Props = $props();

	// ⏳ Block Time Machine (2019–2025 playable scrubber)
	let selectedYear = $state<number>(2025);
	let isPlaying = $state<boolean>(false);
	let playTimer: ReturnType<typeof setInterval> | null = null;

	const timelineYears = $derived.by(() => {
		if (availableYears.length >= 2) {
			return availableYears.includes(2025) ? availableYears : [...availableYears, 2025];
		}
		return [] as number[];
	});

	function stopPlayback() {
		isPlaying = false;
		if (playTimer) {
			clearInterval(playTimer);
			playTimer = null;
		}
	}

	function togglePlayback() {
		if (timelineYears.length < 2) return;
		if (isPlaying) {
			stopPlayback();
			return;
		}
		isPlaying = true;
		// Start from the earliest year if currently at latest
		if (selectedYear >= timelineYears[timelineYears.length - 1]) {
			selectedYear = timelineYears[0];
		}
		playTimer = setInterval(() => {
			const idx = timelineYears.indexOf(selectedYear);
			if (idx === -1 || idx >= timelineYears.length - 1) {
				selectedYear = timelineYears[timelineYears.length - 1];
				stopPlayback();
			} else {
				selectedYear = timelineYears[idx + 1];
			}
		}, 760);
	}

	// Reset Time Machine to 2025 whenever walking to another block
	$effect(() => {
		const _segId = segment.id;
		void _segId;
		stopPlayback();
		selectedYear = 2025;
	});

	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const tag = (document.activeElement?.tagName || '').toUpperCase();
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

			if (e.key === 'ArrowLeft' && spatialNav.left) {
				e.preventDefault();
				goto(`/cluster/${spatialNav.left.clusterId}/block/${spatialNav.left.segId}`);
			} else if (e.key === 'ArrowRight' && spatialNav.right) {
				e.preventDefault();
				goto(`/cluster/${spatialNav.right.clusterId}/block/${spatialNav.right.segId}`);
			} else if (e.key === 'ArrowUp' && spatialNav.up) {
				e.preventDefault();
				goto(`/cluster/${spatialNav.up.clusterId}/block/${spatialNav.up.segId}`);
			} else if (e.key === 'ArrowDown' && spatialNav.down) {
				e.preventDefault();
				goto(`/cluster/${spatialNav.down.clusterId}/block/${spatialNav.down.segId}`);
			} else if (e.key === ' ' && timelineYears.length >= 2) {
				e.preventDefault();
				togglePlayback();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	onDestroy(() => stopPlayback());

	function lotStreakAtYear(lot: BlockLot, year: number): number {
		const bbls = new Set<string>();
		if (lot.bbl) bbls.add(lot.bbl);
		for (const sf of lot.storefronts) {
			const sb = (sf.bbl || '').split('.')[0].trim();
			if (sb) bbls.add(sb);
		}
		let best = 0;
		for (const b of bbls) {
			const byYear = tenantsByBbl[b]?.byYear;
			if (!byYear) continue;
			let streak = 0;
			for (let y = year; y >= 2019; y--) {
				const rec = byYear[String(y)];
				if (rec && rec.v > 0) streak++;
				else break;
			}
			if (streak > best) best = streak;
		}
		return best;
	}

	function projectLotToYear(lot: BlockLot, year: number): BlockLot {
		if (year >= 2025) return lot;
		const bbls = new Set<string>();
		if (lot.bbl) bbls.add(lot.bbl);
		for (const sf of lot.storefronts) {
			const sb = (sf.bbl || '').split('.')[0].trim();
			if (sb) bbls.add(sb);
		}
		let v = 0;
		let o = 0;
		let hadData = false;
		for (const b of bbls) {
			const rec = tenantsByBbl[b]?.byYear?.[String(year)];
			if (rec) {
				v += rec.v;
				o += rec.o;
				hadData = true;
			}
		}
		if (hadData && v + o > 0) {
			const kind: BlockLot['kind'] = v > 0 && o === 0 ? 'vacant' : v > 0 ? 'mixed' : 'occupied';
			return {
				...lot,
				kind,
				vacantCount: v,
				occupiedCount: o
			};
		}
		// If it had commercial storefronts in 2025 but no filing in `year`, show it neutrally
		if (lot.storefronts.length > 0) {
			return {
				...lot,
				kind: 'commercial',
				vacantCount: 0,
				occupiedCount: 0
			};
		}
		return lot;
	}

	const displaySideA = $derived(
		selectedYear >= 2025 ? sideA : sideA.map((l) => projectLotToYear(l, selectedYear))
	);
	const displaySideB = $derived(
		selectedYear >= 2025 ? sideB : sideB.map((l) => projectLotToYear(l, selectedYear))
	);

	const activeYearTotals = $derived.by(() => {
		const lots = [...displaySideA, ...displaySideB];
		let vac = 0;
		let tot = 0;
		for (const l of lots) {
			vac += l.vacantCount;
			tot += l.vacantCount + l.occupiedCount;
		}
		return { vac, tot, pct: tot > 0 ? Math.round((vac / tot) * 100) : 0 };
	});

	function getLotContext(lot: BlockLot): {
		tenants: TenantRecord[];
		vacantYears: number;
		vacantSinceYear: number | null;
		priorActivity: string | null;
	} {
		const bbls = new Set<string>();
		if (lot.bbl) bbls.add(lot.bbl);
		for (const sf of lot.storefronts) {
			const sb = (sf.bbl || '').split('.')[0].trim();
			if (sb) bbls.add(sb);
		}
		const seen = new Set<string>();
		const tenants: TenantRecord[] = [];
		let vacantYears = 0;
		let vacantSinceYear: number | null = null;
		let priorActivity: string | null = null;

		for (const b of bbls) {
			const info = tenantsByBbl[b];
			if (!info) continue;
			if (info.vacantYears > vacantYears) {
				vacantYears = info.vacantYears;
				vacantSinceYear = info.vacantSinceYear;
			}
			if (!priorActivity && info.priorActivity) priorActivity = info.priorActivity;
			for (const t of info.tenants) {
				const key = t.name.toLowerCase();
				if (!seen.has(key)) {
					seen.add(key);
					tenants.push(t);
				}
			}
		}
		return { tenants: tenants.slice(0, 3), vacantYears, vacantSinceYear, priorActivity };
	}

	function vacancyStreakLabel(ctx: ReturnType<typeof getLotContext>): string | null {
		if (ctx.vacantYears >= 2 && ctx.vacantSinceYear) {
			return ctx.priorActivity
				? `Vacant ${ctx.vacantYears} yrs · last ${ctx.priorActivity}`
				: `Vacant ${ctx.vacantYears} yrs (since ${ctx.vacantSinceYear})`;
		}
		if (ctx.vacantYears === 1) {
			return ctx.priorActivity ? `Newly vacant · last ${ctx.priorActivity}` : 'Newly vacant in 2025';
		}
		return null;
	}

	function tenantChipLabel(t: TenantRecord, lot: BlockLot): string {
		if (t.status === 'former') return `Former: ${t.name}`;
		if (lot.kind === 'vacant') return `Last: ${t.name}`;
		return t.name;
	}

	// Citywide 4-way + cross-street spatial navigation (precomputed across ALL 371 clusters at build time
	// so you can walk seamlessly across cluster borders, stopping only at water, parks, or dead ends!)
	const spatialNav = $derived.by<BlockNavLinks>(() => {
		if (segment.nav) return segment.nav;
		const wrap = (s: SegmentSummary | null | undefined): BlockNavTarget | null =>
			s
				? { clusterId, segId: s.id, streetName: s.streetName, between: s.between }
				: null;
		return {
			up: null,
			down: null,
			left: wrap(segment.prevSegId ? shardSegments.find((s) => s.id === segment.prevSegId) : null),
			right: wrap(segment.nextSegId ? shardSegments.find((s) => s.id === segment.nextSegId) : null),
			turnLeft: null,
			turnRight: null
		};
	});

	let selectedLotId = $state<string | null>(null);
	let hoveredLotId = $state<string | null>(null);

	const allLots = $derived([...displaySideA, ...displaySideB]);

	// Hover always previews instantaneously; clicking pins a building for easy clicking of Street View / actions
	const activeLot = $derived.by(() => {
		const targetId = hoveredLotId ?? selectedLotId;
		if (targetId) {
			const hit = allLots.find((l) => l.id === targetId);
			if (hit) return hit;
		}
		return (
			allLots.find((l) => l.vacantCount > 0) ??
			allLots.find((l) => l.storefronts.length > 0) ??
			allLots[0] ??
			null
		);
	});

	function bldgHeight(floors: number): number {
		const f = Math.max(1, Math.min(50, floors || 3));
		return Math.round(40 + Math.sqrt(f) * 9.8);
	}

	function shortLabel(lot: BlockLot): string {
		if (lot.houseNum) return lot.houseNum;
		return lot.address.split(' ')[0] || '—';
	}

	function kindBadge(lot: BlockLot): string {
		if (lot.kind === 'vacant') return `${lot.vacantCount} Vacant`;
		if (lot.kind === 'occupied') return `${lot.occupiedCount} Open`;
		if (lot.kind === 'mixed') return `${lot.occupiedCount} Open · ${lot.vacantCount} Vacant`;
		if (lot.kind === 'residential') return 'Residential';
		if (lot.kind === 'civic') return 'Civic';
		if (lot.kind === 'park') return 'Park';
		if (lot.kind === 'commercial') return 'Office / Comm';
		return 'Lot';
	}

	function shortStreet(lot: BlockLot): string {
		const rest = lot.address.replace(/^\d+[A-Z]?(?:-\d+[A-Z]?)?\s+/i, '').trim();
		return rest
			.replace(/\bAvenue Of The Americas\b/i, '6th Ave')
			.replace(/\bAvenue\b/i, 'Ave')
			.replace(/\bStreet\b/i, 'St')
			.replace(/\bWest\b/i, 'W')
			.replace(/\bEast\b/i, 'E');
	}

	let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

	function handleLotHover(lot: BlockLot) {
		hoveredLotId = lot.id;
		if (prefetchTimer) clearTimeout(prefetchTimer);
		const cleanBbl = (lot.bbl || '').split('.')[0].trim();
		if (!/^[1-5]\d{9}$/.test(cleanBbl)) return;
		prefetchTimer = setTimeout(() => {
			warmBuilding(cleanBbl);
		}, 110);
	}

	function handleLotLeave() {
		hoveredLotId = null;
		if (prefetchTimer) {
			clearTimeout(prefetchTimer);
			prefetchTimer = null;
		}
	}

	function openBuilding(lot: BlockLot) {
		selectedLotId = lot.id;
		const cleanBbl = (lot.bbl || '').split('.')[0].trim();
		if (/^[1-5]\d{9}$/.test(cleanBbl)) {
			goto(`/cluster/${clusterId}/block/${segment.id}/building/${cleanBbl}`);
		}
	}

	const endALabel = $derived(segment.endA || (segment.isHoriz ? 'West End' : 'South End'));
	const endBLabel = $derived(segment.endB || (segment.isHoriz ? 'East End' : 'North End'));
	const sideALabel = $derived(segment.sideLabels[0] || (segment.isHoriz ? 'North' : 'West'));
	const sideBLabel = $derived(segment.sideLabels[1] || (segment.isHoriz ? 'South' : 'East'));
</script>

<section class="elevation-card surface">
	<!-- Compact Top Meta + Legend Row -->
	<div class="elev-meta-bar">
		<div class="elev-legend">
			<span class="leg"><i class="sw vacant"></i>Vacant</span>
			<span class="leg"><i class="sw chronic"></i>3+ yr empty</span>
			<span class="leg"><i class="sw occupied"></i>Open</span>
			<span class="leg"><i class="sw mixed"></i>Mixed</span>
			<span class="leg"><i class="sw residential"></i>Residential</span>
			<span class="leg"><i class="sw civic"></i>Civic</span>
		</div>
		<div class="pluto-status">
			{#if loading}
				Loading NYC PLUTO lots…
			{:else if plutoLoaded}
				{sideA.length + sideB.length} buildings ({sideA.length} {sideALabel} · {sideB.length} {sideBLabel})
			{:else}
				DOF storefronts only
			{/if}
		</div>
	</div>

	<!-- Pinned Live Building Readout Bar (fixed directly above the elevation — zero scrolling, zero jump!) -->
	<div class="readout-bar" aria-live="polite">
		{#if activeLot}
			{@const ctx = getLotContext(activeLot)}
			{@const streak = activeLot.vacantCount > 0 ? vacancyStreakLabel(ctx) : null}
			<div class="rb-left">
				<span class="rb-side">{activeLot.sideLabel}</span>
				<strong class="rb-addr">{activeLot.address}</strong>
				<span class="rb-badge kind-{activeLot.kind}">{kindBadge(activeLot)}</span>
				{#if activeLot.isCorner}
					<span class="rb-tag">Corner</span>
				{/if}
			</div>

			<div class="rb-mid">
				{#if streak}
					<span class="sf-chip vacant">{streak}</span>
				{/if}
				{#if ctx.tenants.length > 0}
					<span class="rb-sfs">
						{#each ctx.tenants.slice(0, 2) as t}
							<span
								class="tenant-chip"
								class:former={t.status === 'former' || activeLot.kind === 'vacant'}
								title="{t.name} ({t.category} · NYC {t.source}{t.lastDate ? ` · ${t.lastDate}` : ''})"
							>
								{tenantChipLabel(t, activeLot)}
							</span>
						{/each}
						{#if ctx.tenants.length > 2}
							<span class="sf-more">+{ctx.tenants.length - 2}</span>
						{/if}
					</span>
				{:else if activeLot.storefronts.length > 0}
					<span class="rb-sfs">
						{#each activeLot.storefronts.slice(0, 3) as sf}
							<span class="sf-chip" class:vacant={sf.vacant}>
								{sf.vacant ? 'Vacant' : sf.activity || 'Open'}
							</span>
						{/each}
						{#if activeLot.storefronts.length > 3}
							<span class="sf-more">+{activeLot.storefronts.length - 3}</span>
						{/if}
					</span>
				{/if}
				<span class="rb-facts">
					{activeLot.frontFt} ft · {activeLot.floors}F
					{#if activeLot.unitsRes > 0}· {activeLot.unitsRes} res{/if}
					{#if activeLot.yearBuilt}· {activeLot.yearBuilt}{/if}
					· {activeLot.landUseLabel}
				</span>
			</div>
		{:else}
			<span class="rb-idle">Hover any building below to inspect its tenants, width, and storefronts</span>
		{/if}
	</div>

	<!-- Spatial 4-Way Whisper-Quiet Navigation Surrounding the Elevation -->
	<div class="spatial-wrap">
		{#if spatialNav.up}
			<div class="edge-row top-edge">
				<a
					href="/cluster/{spatialNav.up.clusterId}/block/{spatialNav.up.segId}"
					class="edge-link"
					title="Step up to {spatialNav.up.streetName} ({spatialNav.up.between})"
				>
					<span class="el-arr">↑</span>
					<span>{spatialNav.up.streetName}</span>
				</a>
			</div>
		{/if}

		<div class="stage-row">
			{#if spatialNav.left || spatialNav.right}
				<div class="side-rail">
					{#if spatialNav.left}
						<a
							href="/cluster/{spatialNav.left.clusterId}/block/{spatialNav.left.segId}"
							class="side-arrow left"
							aria-label="Previous block: {spatialNav.left.streetName} ({spatialNav.left.between})"
							title="← {spatialNav.left.streetName} ({spatialNav.left.between})"
						>
							<span>←</span>
							<em class="side-tip">{spatialNav.left.between}</em>
						</a>
					{/if}
				</div>
			{/if}

			<!-- Full-Width Zero-Scrollbar Two-Sided Street Elevation -->
			<div class="stage-box">
				<div class="street-stage">
					<!-- TOP SIDEWALK (Side A: North or West) -->
					<div class="side-banner top">
						<span>{sideALabel} Side · {segment.streetName}{#if selectedYear < 2025} · {selectedYear}{/if}</span>
						<span>
							{displaySideA.length} bldgs · {displaySideA.reduce((s, l) => s + l.vacantCount, 0)}/{displaySideA.reduce((s, l) => s + l.vacantCount + l.occupiedCount, 0)} vacant
						</span>
					</div>

					<div class="lots-track top-track">
						{#each displaySideA as lot (lot.id)}
							{@const widthPct = Math.max(0.8, (lot.x1 - lot.x0) * 100)}
							{@const leftPct = lot.x0 * 100}
							{@const isSel = activeLot?.id === lot.id}
							{@const isNarrow = widthPct < 3.6}
							{@const isOtherCluster = Boolean(lot.clusterId && lot.clusterId !== clusterId)}
							{@const lotCtx = getLotContext(lot)}
							{@const topTenant = lotCtx.tenants[0] ?? null}
							{@const yrStreak = selectedYear < 2025 ? lotStreakAtYear(lot, selectedYear) : lotCtx.vacantYears}
							{@const isChronic = lot.vacantCount > 0 && yrStreak >= 3}
							<button
								type="button"
								class="lot-bldg top-bldg kind-{lot.kind}"
								class:selected={isSel}
								class:corner={lot.isCorner}
								class:narrow={isNarrow}
								class:chronic={isChronic}
								style="left:{leftPct}%; width:{widthPct}%; height:{bldgHeight(lot.floors)}px"
								title="{lot.address}{topTenant ? ` · ${tenantChipLabel(topTenant, lot)}` : ''}{isChronic ? ` · Vacant ${yrStreak} yrs` : ''} · {lot.frontFt}ft · {lot.floors}F · {kindBadge(lot)}"
								onmouseenter={() => handleLotHover(lot)}
								onmouseleave={handleLotLeave}
								onfocus={() => handleLotHover(lot)}
								onblur={handleLotLeave}
								onclick={() => openBuilding(lot)}
							>
								<div class="bldg-body">
									{#if isOtherCluster}
										<span class="other-dot" title="Across cluster border"></span>
									{/if}
									{#if isChronic && widthPct >= 3.8}
										<span class="age-pill" title="Vacant {yrStreak} years">{yrStreak}y</span>
									{/if}
									<span class="bldg-num">{shortLabel(lot)}</span>
									{#if topTenant && widthPct >= 5.2}
										<span class="bldg-tenant" class:former={topTenant.status === 'former' || lot.kind === 'vacant'}>
											{topTenant.name}
										</span>
									{:else if !isNarrow}
										<span class="bldg-meta">{lot.isCorner ? shortStreet(lot) : `${lot.floors}F`}</span>
									{/if}
								</div>

								<div class="ground-floor">
									{#if lot.kind === 'mixed'}
										{@const sfTot = Math.max(1, lot.occupiedCount + lot.vacantCount)}
										{@const occPct = (lot.occupiedCount / sfTot) * 100}
										<span class="gf-occ" style="width:{occPct}%"></span>
										<span class="gf-vac" style="width:{100 - occPct}%"></span>
									{:else if lot.kind === 'vacant'}
										<span class="gf-vac full"></span>
									{:else if lot.kind === 'occupied'}
										<span class="gf-occ full"></span>
									{:else}
										<span class="gf-res full"></span>
									{/if}
								</div>
							</button>
						{/each}
						{#if displaySideA.length === 0 && !loading}
							<div class="empty-side-note">No buildings mapped on {sideALabel} side</div>
						{/if}
					</div>

					<!-- MIDDLE ROADWAY -->
					<div class="roadway">
						{#if spatialNav.turnLeft}
							<a
								href="/cluster/{spatialNav.turnLeft.clusterId}/block/{spatialNav.turnLeft.segId}"
								class="cross-end left clickable"
								title="Turn onto {spatialNav.turnLeft.streetName} ({spatialNav.turnLeft.between})"
							>
								<span>{endALabel}</span>
							</a>
						{:else}
							<div class="cross-end left">
								<span>{endALabel}</span>
							</div>
						{/if}

						<div class="road-center">
							<span class="road-name">{segment.streetName.toUpperCase()}</span>
							<span class="road-len">{Math.round(segment.lengthM * 3.28084)} ft</span>
						</div>

						{#if spatialNav.turnRight}
							<a
								href="/cluster/{spatialNav.turnRight.clusterId}/block/{spatialNav.turnRight.segId}"
								class="cross-end right clickable"
								title="Turn onto {spatialNav.turnRight.streetName} ({spatialNav.turnRight.between})"
							>
								<span>{endBLabel}</span>
							</a>
						{:else}
							<div class="cross-end right">
								<span>{endBLabel}</span>
							</div>
						{/if}
					</div>

					<!-- BOTTOM SIDEWALK (Side B: South or East) -->
					<div class="lots-track bottom-track">
						{#each displaySideB as lot (lot.id)}
							{@const widthPct = Math.max(0.8, (lot.x1 - lot.x0) * 100)}
							{@const leftPct = lot.x0 * 100}
							{@const isSel = activeLot?.id === lot.id}
							{@const isNarrow = widthPct < 3.6}
							{@const isOtherCluster = Boolean(lot.clusterId && lot.clusterId !== clusterId)}
							{@const lotCtx = getLotContext(lot)}
							{@const topTenant = lotCtx.tenants[0] ?? null}
							{@const yrStreak = selectedYear < 2025 ? lotStreakAtYear(lot, selectedYear) : lotCtx.vacantYears}
							{@const isChronic = lot.vacantCount > 0 && yrStreak >= 3}
							<button
								type="button"
								class="lot-bldg bottom-bldg kind-{lot.kind}"
								class:selected={isSel}
								class:corner={lot.isCorner}
								class:narrow={isNarrow}
								class:chronic={isChronic}
								style="left:{leftPct}%; width:{widthPct}%; height:{bldgHeight(lot.floors)}px"
								title="{lot.address}{topTenant ? ` · ${tenantChipLabel(topTenant, lot)}` : ''}{isChronic ? ` · Vacant ${yrStreak} yrs` : ''} · {lot.frontFt}ft · {lot.floors}F · {kindBadge(lot)}"
								onmouseenter={() => handleLotHover(lot)}
								onmouseleave={handleLotLeave}
								onfocus={() => handleLotHover(lot)}
								onblur={handleLotLeave}
								onclick={() => openBuilding(lot)}
							>
								<div class="ground-floor">
									{#if lot.kind === 'mixed'}
										{@const sfTot = Math.max(1, lot.occupiedCount + lot.vacantCount)}
										{@const occPct = (lot.occupiedCount / sfTot) * 100}
										<span class="gf-occ" style="width:{occPct}%"></span>
										<span class="gf-vac" style="width:{100 - occPct}%"></span>
									{:else if lot.kind === 'vacant'}
										<span class="gf-vac full"></span>
									{:else if lot.kind === 'occupied'}
										<span class="gf-occ full"></span>
									{:else}
										<span class="gf-res full"></span>
									{/if}
								</div>

								<div class="bldg-body">
									{#if isOtherCluster}
										<span class="other-dot" title="Across cluster border"></span>
									{/if}
									{#if isChronic && widthPct >= 3.8}
										<span class="age-pill" title="Vacant {yrStreak} years">{yrStreak}y</span>
									{/if}
									<span class="bldg-num">{shortLabel(lot)}</span>
									{#if topTenant && widthPct >= 5.2}
										<span class="bldg-tenant" class:former={topTenant.status === 'former' || lot.kind === 'vacant'}>
											{topTenant.name}
										</span>
									{:else if !isNarrow}
										<span class="bldg-meta">{lot.isCorner ? shortStreet(lot) : `${lot.floors}F`}</span>
									{/if}
								</div>
							</button>
						{/each}
						{#if displaySideB.length === 0 && !loading}
							<div class="empty-side-note">No buildings mapped on {sideBLabel} side</div>
						{/if}
					</div>

					<!-- BOTTOM SIDEWALK (Side B: South or East) -->
					<div class="side-banner bottom">
						<span>{sideBLabel} Side · {segment.streetName}{#if selectedYear < 2025} · {selectedYear}{/if}</span>
						<span>
							{displaySideB.length} bldgs · {displaySideB.reduce((s, l) => s + l.vacantCount, 0)}/{displaySideB.reduce((s, l) => s + l.vacantCount + l.occupiedCount, 0)} vacant
						</span>
					</div>
				</div>
			</div>

			{#if spatialNav.left || spatialNav.right}
				<div class="side-rail">
					{#if spatialNav.right}
						<a
							href="/cluster/{spatialNav.right.clusterId}/block/{spatialNav.right.segId}"
							class="side-arrow right"
							aria-label="Next block: {spatialNav.right.streetName} ({spatialNav.right.between})"
							title="{spatialNav.right.streetName} ({spatialNav.right.between}) →"
						>
							<span>→</span>
							<em class="side-tip">{spatialNav.right.between}</em>
						</a>
					{/if}
				</div>
			{/if}
		</div>

		{#if spatialNav.down}
			<div class="edge-row bottom-edge">
				<a
					href="/cluster/{spatialNav.down.clusterId}/block/{spatialNav.down.segId}"
					class="edge-link"
					title="Step down to {spatialNav.down.streetName} ({spatialNav.down.between})"
				>
					<span class="el-arr">↓</span>
					<span>{spatialNav.down.streetName}</span>
				</a>
			</div>
		{/if}
	</div>

	<!-- ⏳ Block Time Machine: Playable 2019–2025 Street History Scrubber -->
	{#if timelineYears.length >= 2}
		<div class="time-machine" role="region" aria-label="Block vacancy time machine 2019 to 2025">
			<div class="tm-left">
				<button
					type="button"
					class="tm-play"
					class:playing={isPlaying}
					onclick={togglePlayback}
					title={isPlaying ? 'Pause block timeline' : 'Play 2019–2025 storefront history'}
				>
					{isPlaying ? '❚❚ Pause' : '▶ Time Machine'}
				</button>
				<div class="tm-years" role="tablist" aria-label="Select year">
					{#each timelineYears as yr}
						<button
							type="button"
							role="tab"
							aria-selected={selectedYear === yr}
							class="tm-yr"
							class:active={selectedYear === yr}
							onclick={() => {
								stopPlayback();
								selectedYear = yr;
							}}
						>
							{yr}
						</button>
					{/each}
				</div>
			</div>
			<div class="tm-stat" class:historical={selectedYear < 2025}>
				<strong>{selectedYear}</strong>
				<span>
					{activeYearTotals.vac}/{activeYearTotals.tot} empty ({activeYearTotals.pct}%)
				</span>
				{#if selectedYear < 2025}
					<button
						type="button"
						class="tm-reset"
						onclick={() => {
							stopPlayback();
							selectedYear = 2025;
						}}
					>
						Back to 2025
					</button>
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.elevation-card {
		width: 100%;
		min-width: 0;
		padding: 12px 16px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.time-machine {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 7px 10px;
		border-radius: var(--radius-sm);
		background: var(--page);
		border: 1px solid var(--rule);
	}

	.tm-left {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.tm-play {
		border: 1px solid var(--rule);
		background: var(--panel);
		color: var(--ink);
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		padding: 4px 9px;
		border-radius: 5px;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
	}

	.tm-play:hover,
	.tm-play.playing {
		background: var(--ink);
		border-color: var(--ink);
		color: #ffffff;
	}

	.tm-years {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.tm-yr {
		border: 0;
		background: transparent;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
		padding: 3px 7px;
		border-radius: 4px;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.tm-yr:hover {
		background: var(--quiet);
		color: var(--ink);
	}

	.tm-yr.active {
		background: var(--ink);
		color: #ffffff;
		font-weight: 600;
	}

	.tm-stat {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--muted);
	}

	.tm-stat strong {
		color: var(--ink);
	}

	.tm-stat.historical strong {
		color: #e62217;
	}

	.tm-reset {
		border: 1px solid var(--rule);
		background: var(--panel);
		color: var(--ink);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		padding: 2px 7px;
		border-radius: 4px;
		cursor: pointer;
	}

	.tm-reset:hover {
		border-color: var(--ink);
	}

	.elev-meta-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.elev-legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}

	.leg {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.sw {
		width: 10px;
		height: 7px;
		border-radius: 2px;
		display: inline-block;
	}

	.sw.vacant {
		background: var(--red);
	}

	.sw.chronic {
		background: #6b0f1a;
	}

	.sw.occupied {
		background: var(--green);
	}

	.sw.mixed {
		background: linear-gradient(90deg, var(--green) 50%, var(--red) 50%);
	}

	.sw.residential {
		background: #e5e5e0;
		border: 1px solid #c8c8c0;
	}

	.sw.civic {
		background: #dce5ec;
		border: 1px solid #b5c6d4;
	}

	.pluto-status {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}

	/* Locked-height Live Readout Bar directly above the elevation — zero vertical reflow when scrubbing */
	.readout-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		height: 46px;
		padding: 0 12px;
		background: var(--page);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
		overflow: hidden;
		flex-wrap: nowrap;
	}

	.rb-left {
		display: flex;
		align-items: center;
		gap: 7px;
		flex: none;
	}

	.rb-side {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		background: var(--ink);
		color: #ffffff;
		padding: 2px 6px;
		border-radius: 3px;
	}

	.rb-addr {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
	}

	.rb-badge {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		padding: 1.5px 7px;
		border-radius: 4px;
		background: var(--quiet);
		color: var(--ink-soft);
		white-space: nowrap;
	}

	.rb-badge.kind-vacant {
		background: var(--red-bg);
		color: var(--red);
	}

	.rb-badge.kind-occupied {
		background: var(--green-bg);
		color: var(--green);
	}

	.rb-badge.kind-mixed {
		background: var(--amber-bg);
		color: var(--amber);
	}

	.rb-tag {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--muted);
		border: 1px solid var(--rule);
		padding: 1px 5px;
		border-radius: 3px;
	}

	.rb-mid {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		overflow: hidden;
	}

	.rb-facts {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rb-sfs {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}

	.sf-chip {
		font-family: var(--font-mono);
		font-size: 10px;
		padding: 1.5px 6px;
		border-radius: 4px;
		background: var(--green-bg);
		color: var(--green);
		white-space: nowrap;
	}

	.sf-chip.vacant {
		background: var(--red-bg);
		color: var(--red);
	}

	.tenant-chip {
		font-family: var(--font-body);
		font-size: 11.5px;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: 4px;
		background: #ffffff;
		border: 1px solid var(--line);
		color: var(--ink);
		white-space: nowrap;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tenant-chip.former {
		border-style: dashed;
		color: var(--ink-soft);
		background: var(--page);
	}

	.sf-more {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
	}

	.rb-idle {
		font-size: 12px;
		color: var(--muted);
	}

	/* Whisper-quiet 4-way spatial wrapper around the street elevation */
	.spatial-wrap {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.edge-row {
		display: flex;
		justify-content: center;
	}

	.edge-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 10px;
		border-radius: 4px;
		text-decoration: none;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
		transition: color 0.12s ease, background 0.12s ease;
	}

	.edge-link:hover {
		color: var(--ink);
		background: var(--quiet);
	}

	.edge-link:hover .el-arr {
		color: var(--accent);
	}

	.el-arr {
		font-weight: 600;
		color: var(--muted-light);
		transition: color 0.12s ease;
	}

	.stage-row {
		display: flex;
		align-items: stretch;
		gap: 6px;
		min-width: 0;
	}

	.side-rail {
		flex: none;
		width: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
	}

	.side-arrow {
		position: relative;
		width: 28px;
		height: 44px;
		border-radius: 5px;
		display: flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		color: var(--muted-light);
		transition: color 0.12s ease, background 0.12s ease;
	}

	.side-arrow:hover {
		color: var(--accent);
		background: var(--quiet);
	}

	.side-tip {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		font-style: normal;
		font-size: 10.5px;
		font-weight: 500;
		white-space: nowrap;
		background: var(--ink);
		color: #ffffff;
		padding: 3px 8px;
		border-radius: 4px;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.12s ease;
		z-index: 30;
	}

	.side-arrow.left .side-tip {
		left: 34px;
	}

	.side-arrow.right .side-tip {
		right: 34px;
	}

	.side-arrow:hover .side-tip,
	.side-arrow:focus-visible .side-tip {
		opacity: 1;
	}

	/* Full-width zero-scrollbar elevation container */
	.stage-box {
		flex: 1;
		min-width: 0;
		background: #fafaf9;
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
		overflow: hidden;
	}

	.street-stage {
		width: 100%;
		padding: 10px 14px;
		display: flex;
		flex-direction: column;
	}

	.side-banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.side-banner.top {
		margin-bottom: 6px;
	}

	.side-banner.bottom {
		margin-top: 6px;
	}

	.lots-track {
		position: relative;
		width: 100%;
		height: 118px;
	}

	.empty-side-note {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		color: var(--muted);
	}

	.lot-bldg {
		position: absolute;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 0;
		border: 1px solid #d4d4ce;
		background: #ffffff;
		cursor: pointer;
		overflow: hidden;
		transition: border-color 0.08s ease, box-shadow 0.08s ease;
		color: var(--ink);
		font-family: var(--font-body);
	}

	.top-bldg {
		bottom: 0;
		border-radius: 3px 3px 1px 1px;
	}

	.bottom-bldg {
		top: 0;
		border-radius: 1px 1px 3px 3px;
	}

	.lot-bldg:hover,
	.lot-bldg.selected {
		z-index: 15;
		border-color: var(--ink);
		box-shadow: 0 0 0 2px var(--accent);
	}

	.lot-bldg.kind-residential {
		background: #f3f3ef;
		border-color: #dadad4;
	}

	.lot-bldg.kind-civic {
		background: #e9eff4;
		border-color: #c2d1de;
	}

	.lot-bldg.kind-park {
		background: #e9f3ec;
		border-color: #bfd9c7;
	}

	.lot-bldg.kind-commercial {
		background: #efefec;
		border-color: #cfcfc8;
	}

	.lot-bldg.kind-vacant {
		background: #fff9f8;
		border-color: #ebb5aa;
	}

	.lot-bldg.kind-occupied {
		background: #f7fcf9;
		border-color: #b4dfc7;
	}

	.lot-bldg.kind-mixed {
		background: #ffffff;
		border-color: #c6c6be;
	}

	.lot-bldg.corner {
		border-style: dashed;
	}

	.bldg-body {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2px 1px;
		min-height: 0;
		position: relative;
	}

	.other-dot {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--accent);
	}

	.bldg-num {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		line-height: 1.1;
		white-space: nowrap;
		overflow: hidden;
		max-width: 100%;
	}

	.lot-bldg.narrow .bldg-num {
		font-size: 8.5px;
		letter-spacing: -0.05em;
	}

	.bldg-meta {
		font-family: var(--font-mono);
		font-size: 8.5px;
		color: var(--muted-light);
		line-height: 1.1;
		margin-top: 2px;
	}

	.bldg-tenant {
		font-family: var(--font-body);
		font-size: 9px;
		font-weight: 500;
		color: var(--ink-soft);
		line-height: 1.15;
		margin-top: 2px;
		max-width: 92%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bldg-tenant.former {
		font-style: italic;
		color: var(--muted);
	}

	.ground-floor {
		flex: none;
		height: 10px;
		width: 100%;
		display: flex;
	}

	.gf-occ {
		display: block;
		height: 100%;
		background: var(--green);
	}

	.gf-vac {
		display: block;
		height: 100%;
		background: repeating-linear-gradient(
			-45deg,
			var(--red) 0px,
			var(--red) 2.5px,
			#b92b15 2.5px,
			#b92b15 4.5px
		);
	}

	.lot-bldg.chronic .gf-vac {
		background: repeating-linear-gradient(
			-45deg,
			#7a111d 0px,
			#7a111d 2.5px,
			#520b14 2.5px,
			#520b14 4.5px
		);
	}

	.lot-bldg.chronic {
		border-color: rgba(122, 17, 29, 0.55);
	}

	.age-pill {
		position: absolute;
		top: 3px;
		right: 3px;
		font-family: var(--font-mono);
		font-size: 7.5px;
		font-weight: 600;
		line-height: 1;
		padding: 1.5px 3px;
		border-radius: 2.5px;
		background: #6b0f1a;
		color: #ffffff;
		pointer-events: none;
	}

	.gf-res {
		display: block;
		height: 100%;
		background: #e5e5e0;
	}

	.gf-occ.full,
	.gf-vac.full,
	.gf-res.full {
		width: 100%;
	}

	/* Clean Architectural Roadway */
	.roadway {
		position: relative;
		height: 34px;
		margin: 4px 0;
		background: #1c1c1a;
		border-radius: 5px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 12px;
		color: #f4f4f2;
	}

	.roadway::before {
		content: '';
		position: absolute;
		left: 110px;
		right: 110px;
		top: 50%;
		border-top: 1px dashed rgba(255, 255, 255, 0.22);
		pointer-events: none;
	}

	.cross-end {
		position: relative;
		z-index: 2;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: #1c1c1a;
		padding: 0 6px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		color: #d4d4ce;
		text-decoration: none;
	}

	.cross-end.clickable {
		color: #ffffff;
		border-radius: 3px;
		transition: color 0.12s ease;
	}

	.cross-end.clickable:hover {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.road-center {
		position: relative;
		z-index: 2;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		background: #1c1c1a;
		padding: 0 10px;
	}

	.road-name {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.1em;
		color: #ffffff;
	}

	.road-len {
		font-family: var(--font-mono);
		font-size: 10px;
		color: #8e8e88;
	}

	@media (max-width: 900px) {
		.readout-bar {
			height: auto;
			min-height: 46px;
			padding: 7px 12px;
			flex-wrap: wrap;
		}
		.rb-mid {
			order: 3;
			flex-basis: 100%;
		}
	}
</style>
