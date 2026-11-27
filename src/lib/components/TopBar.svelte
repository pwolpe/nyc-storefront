<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ClustersFile, ClusterProps, ClusterShard, SegmentSummary } from '$lib/types';
	import { pct, rateTone, deltaPts, deltaTone } from '$lib/format';
	import { getClusterShard, warmBuilding, warmClusterShard } from '$lib/clientCache';

	interface Props {
		cityRate: number;
		clustersData: ClustersFile;
		cluster?: { id: string; name: string; rate: number } | null;
		block?: { id: string; label: string; rate: number } | null;
		building?: { bbl: string; label: string } | null;
		section?: string | null;
	}

	let {
		cityRate: _cityRate,
		clustersData,
		cluster = null,
		block = null,
		building = null,
		section = null
	}: Props = $props();

	interface GeoSuggestion {
		label: string;
		borough: string;
		street: string;
		lng: number;
		lat: number;
		bbl: string;
	}

	interface AiResultItem {
		type: 'cluster' | 'block' | 'building';
		title: string;
		subtitle: string;
		badge?: string;
		tone?: 'hot' | 'steady' | 'thriving';
		href: string;
		reason: string;
	}

	let query = $state('');
	let open = $state(false);
	let searching = $state(false);
	let locating = $state(false);
	let error = $state('');
	let geoHits = $state<GeoSuggestion[]>([]);
	let aiLoading = $state(false);
	let aiAnswer = $state('');
	let aiResults = $state<AiResultItem[]>([]);
	let aiError = $state('');
	let aiQueryRan = $state('');
	let activeIdx = $state(-1);
	let jumpingNavId = $state<string | null>(null);
	let jumpingLabel = $state('');

	let inputEl: HTMLInputElement | undefined;
	let searchBoxEl: HTMLDivElement | undefined;
	let dropdownEl = $state<HTMLDivElement | undefined>(undefined);
	let geoTimer: ReturnType<typeof setTimeout> | null = null;
	let geoAbort: AbortController | null = null;

	const EXAMPLE_PROMPTS = [
		'Where in Brooklyn is vacancy getting worse?',
		'Which neighborhoods bounced back most since 2021?',
		'Where did Grand Sichuan used to be?'
	];

	function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
		let inside = false;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const xi = ring[i][0],
				yi = ring[i][1];
			const xj = ring[j][0],
				yj = ring[j][1];
			const intersect =
				yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
			if (intersect) inside = !inside;
		}
		return inside;
	}

	function pointInGeom(
		lng: number,
		lat: number,
		geom: GeoJSON.Polygon | GeoJSON.MultiPolygon
	): boolean {
		const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
		for (const poly of polys) {
			if (!pointInRing(lng, lat, poly[0])) continue;
			let inHole = false;
			for (let i = 1; i < poly.length; i++) {
				if (pointInRing(lng, lat, poly[i])) {
					inHole = true;
					break;
				}
			}
			if (!inHole) return true;
		}
		return false;
	}

	function normStreet(raw: string): string {
		return raw
			.toLowerCase()
			.replace(/\bavenue of the americas\b/g, '6th ave')
			.replace(/\bstreet\b/g, 'st')
			.replace(/\bavenue\b/g, 'ave')
			.replace(/\bwest\b/g, 'w')
			.replace(/\beast\b/g, 'e')
			.replace(/[^a-z0-9]/g, '');
	}

	function distToLine(lng: number, lat: number, line: [number, number][]): number {
		let best = Infinity;
		for (let i = 0; i < line.length - 1; i++) {
			const [ax, ay] = line[i];
			const [bx, by] = line[i + 1];
			const vx = bx - ax;
			const vy = by - ay;
			const l2 = vx * vx + vy * vy;
			const t = l2 > 0 ? Math.max(0, Math.min(1, ((lng - ax) * vx + (lat - ay) * vy) / l2)) : 0;
			const d = Math.hypot(lng - (ax + t * vx), lat - (ay + t * vy));
			if (d < best) best = d;
		}
		return best;
	}

	function looksLikeQuestion(q: string): boolean {
		const s = q.trim().toLowerCase();
		if (s.endsWith('?')) return true;
		if (s.split(/\s+/).length >= 4) {
			if (
				/\b(where|which|what|who|show|find|most|emptiest|worst|best|lively|busy|rebound|bounce|improv|worsen|used to|formerly|empty|vacant|trend|getting)\b/.test(
					s
				)
			) {
				return true;
			}
		}
		return false;
	}

	// Instant 0ms local match across all 349 clusters, neighborhoods, boroughs & top streets
	const localClusters = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [] as Array<{ c: ClusterProps; matchedStreet: string | null }>;
		const tokens = q.split(/\s+/).filter(Boolean);
		const scored: Array<{ c: ClusterProps; score: number; matchedStreet: string | null }> = [];

		for (const f of clustersData.clusters.features) {
			const c = f.properties;
			const nameL = c.name.toLowerCase();
			const boroL = c.borough.toLowerCase();
			const hoods = (c.neighborhoods || []).join(' ').toLowerCase();
			const streets = (c.top_streets || []).map((s) => s.toLowerCase());
			const borders = c.borders?.summary?.toLowerCase() || '';
			const hay = `${nameL} ${boroL} ${hoods} ${streets.join(' ')} ${borders}`;

			if (!tokens.every((t) => hay.includes(t))) continue;

			let score = 0;
			let matchedStreet: string | null = null;
			if (nameL.startsWith(q)) score += 120;
			else if (nameL.includes(q)) score += 80;
			if (hoods.includes(q)) score += 45;
			for (let i = 0; i < streets.length; i++) {
				if (streets[i].includes(q)) {
					score += 55 - i * 4;
					if (!matchedStreet) matchedStreet = c.top_streets[i];
				}
			}
			if (boroL === q) score += 20;
			score += Math.min(20, c.total_storefronts / 40);
			scored.push({ c, score, matchedStreet });
		}

		return scored
			.sort((a, b) => b.score - a.score)
			.slice(0, 4)
			.map(({ c, matchedStreet }) => ({ c, matchedStreet }));
	});

	// Debounced live NYC GeoSearch typeahead for street addresses
	$effect(() => {
		const q = query.trim();
		if (geoTimer) clearTimeout(geoTimer);
		if (geoAbort) geoAbort.abort();

		if (q.length < 3 || looksLikeQuestion(q)) {
			geoHits = [];
			return;
		}

		geoTimer = setTimeout(async () => {
			geoAbort = new AbortController();
			try {
				const res = await fetch(
					`https://geosearch.planninglabs.nyc/v2/autocomplete?text=${encodeURIComponent(q)}&size=3`,
					{ signal: geoAbort.signal }
				);
				if (!res.ok) return;
				const json = await res.json();
				const hits: GeoSuggestion[] = [];
				for (const feat of json.features ?? []) {
					const coords = feat?.geometry?.coordinates;
					if (!coords || coords.length < 2) continue;
					hits.push({
						label: String(feat.properties?.name || feat.properties?.label || ''),
						borough: String(feat.properties?.borough || ''),
						street: String(feat.properties?.street || ''),
						lng: Number(coords[0]),
						lat: Number(coords[1]),
						bbl: String(feat.properties?.addendum?.pad?.bbl || '').replace(/\D/g, '')
					});
				}
				if (!geoAbort.signal.aborted) {
					geoHits = hits;
					// Silently pre-warm the #1 address hit (cluster shard + building dossier) while the user reads the dropdown
					if (hits[0]) prefetchGeoHit(hits[0]);
				}
			} catch {
				// ignore aborted or network error
			}
		}, 170);

		return () => {
			if (geoTimer) clearTimeout(geoTimer);
			if (geoAbort) geoAbort.abort();
		};
	});

	function findClusterForCoord(lng: number, lat: number) {
		let hitCluster = clustersData.clusters.features.find((f) => {
			const b = f.properties.bbox;
			if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return false;
			return pointInGeom(lng, lat, f.geometry);
		});

		if (!hitCluster) {
			let bestD = Infinity;
			for (const f of clustersData.clusters.features) {
				const d = Math.hypot(f.properties.center[0] - lng, f.properties.center[1] - lat);
				if (d < bestD) {
					bestD = d;
					hitCluster = f;
				}
			}
			// Guard against coordinates way outside NYC (> ~2.5km from any cluster)
			if (bestD > 0.03) return null;
		}
		return hitCluster ?? null;
	}

	function prefetchGeoHit(hit: GeoSuggestion) {
		const hitCluster = findClusterForCoord(hit.lng, hit.lat);
		if (hitCluster) warmClusterShard(hitCluster.properties.id);
		if (/^[1-5]\d{9}$/.test(hit.bbl)) warmBuilding(hit.bbl);
	}

	async function jumpToCoord(
		lng: number,
		lat: number,
		streetHint = '',
		preferredBbl = ''
	): Promise<boolean> {
		const hitCluster = findClusterForCoord(lng, lat);
		if (!hitCluster) return false;

		const cid = hitCluster.properties.id;
		const streetNorm = normStreet(streetHint);
		// Kick off building dossier warm-up in parallel with shard resolution if we already know the BBL
		if (/^[1-5]\d{9}$/.test(preferredBbl)) warmBuilding(preferredBbl);

		const shard: ClusterShard | null = await getClusterShard(cid);
		if (shard) {
			let bestSeg: SegmentSummary | null = null;
			let bestScore = Infinity;

			for (const seg of shard.segments) {
				const d = distToLine(lng, lat, seg.line);
				const segNorm = normStreet(seg.streetName);
				const sameStreet =
					streetNorm.length > 2 &&
					(segNorm === streetNorm || segNorm.includes(streetNorm) || streetNorm.includes(segNorm));
				const score = sameStreet ? d * 0.15 : d;
				if (score < bestScore) {
					bestScore = score;
					bestSeg = seg;
				}
			}

			if (bestSeg && bestScore < 0.0025) {
				if (/^[1-5]\d{9}$/.test(preferredBbl)) {
					await goto(`/cluster/${cid}/block/${bestSeg.id}/building/${preferredBbl}`);
				} else {
					await goto(`/cluster/${cid}/block/${bestSeg.id}`);
				}
				closeSearch();
				return true;
			}
		}

		await goto(`/cluster/${cid}`);
		closeSearch();
		return true;
	}

	async function runAiSearch(rawQ?: string) {
		const q = (rawQ ?? query).trim();
		if (q.length < 3) return;
		if (rawQ) query = rawQ;
		open = true;
		aiLoading = true;
		aiError = '';
		aiAnswer = '';
		aiResults = [];
		aiQueryRan = q;
		error = '';

		try {
			const res = await fetch('/api/ai/search', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query: q })
			});
			const data = await res.json();
			if (!data.configured) {
				aiError = 'Add OPENROUTER_API_KEY in .env to enable AI search.';
			} else if (data.error) {
				aiError = data.error;
			} else {
				aiAnswer = data.answer || '';
				aiResults = data.results || [];
				if (!aiAnswer && aiResults.length === 0) {
					aiError = 'No matching NYC blocks or clusters found.';
				}
			}
		} catch {
			aiError = 'AI search failed — try an address or neighborhood name.';
		} finally {
			aiLoading = false;
		}
	}

	async function jumpToMyBlock() {
		if (typeof navigator === 'undefined' || !navigator.geolocation) {
			error = 'Geolocation unavailable';
			return;
		}
		locating = true;
		error = '';
		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				try {
					const ok = await jumpToCoord(pos.coords.longitude, pos.coords.latitude);
					if (!ok) error = 'Looks like you are outside NYC';
				} catch {
					error = 'Could not map your location';
				} finally {
					locating = false;
				}
			},
			() => {
				error = 'Location permission denied';
				locating = false;
			},
			{ enableHighAccuracy: true, timeout: 8000 }
		);
	}

	async function handleSubmit() {
		const q = query.trim();
		if (!q) return;
		error = '';

		// Natural-language question → ask AI directly
		if (looksLikeQuestion(q)) {
			await runAiSearch(q);
			return;
		}

		// If we already have a strong address match and query begins with a house number, jump straight to it
		if (/^\d/.test(q) && geoHits.length > 0) {
			searching = true;
			try {
				const top = geoHits[0];
				await jumpToCoord(top.lng, top.lat, top.street, top.bbl);
			} finally {
				searching = false;
			}
			return;
		}

		// Exact/strong local cluster match when not an address
		if (!/^\d/.test(q) && localClusters.length > 0 && geoHits.length === 0) {
			const c = localClusters[0].c;
			closeSearch();
			await goto(`/cluster/${c.id}`);
			return;
		}

		// Otherwise try GeoSearch first, and fall back to AI if GeoSearch doesn't recognize it (e.g. business/landmark name!)
		searching = true;
		try {
			const res = await fetch(
				`https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(q)}&size=1`
			);
			const json = await res.json();
			const feat = json.features?.[0];
			if (feat?.geometry?.coordinates) {
				const [lng, lat] = feat.geometry.coordinates as [number, number];
				const bbl = String(feat.properties?.addendum?.pad?.bbl || '').replace(/\D/g, '');
				const ok = await jumpToCoord(lng, lat, String(feat.properties?.street || ''), bbl);
				if (ok) return;
			}
			// GeoSearch didn't find it → seamlessly hand off to AI search!
			searching = false;
			await runAiSearch(q);
		} catch {
			error = 'Lookup failed';
		} finally {
			searching = false;
		}
	}

	function closeSearch() {
		open = false;
		query = '';
		activeIdx = -1;
		jumpingNavId = null;
		jumpingLabel = '';
		geoHits = [];
		aiAnswer = '';
		aiResults = [];
		aiError = '';
		aiQueryRan = '';
		error = '';
		inputEl?.blur();
	}

	async function selectGeoHit(hit: GeoSuggestion, navId?: string) {
		if (searching) return;
		searching = true;
		jumpingNavId = navId ?? null;
		jumpingLabel = hit.label;
		error = '';
		try {
			const ok = await jumpToCoord(hit.lng, hit.lat, hit.street, hit.bbl);
			if (!ok) error = 'Address is outside mapped NYC commercial blocks';
		} catch {
			error = 'Could not open that address';
		} finally {
			searching = false;
			jumpingNavId = null;
			jumpingLabel = '';
		}
	}

	// Flat ordered list of every visible dropdown action so ArrowDown/ArrowUp + Enter work everywhere
	const navItems = $derived.by(() => {
		const items: Array<{ id: string; run: () => void | Promise<void> }> = [];
		const q = query.trim();
		if (q.length === 0) {
			items.push({ id: 'gps', run: () => jumpToMyBlock() });
			for (let i = 0; i < EXAMPLE_PROMPTS.length; i++) {
				const ex = EXAMPLE_PROMPTS[i];
				items.push({ id: `ex:${i}`, run: () => runAiSearch(ex) });
			}
			return items;
		}
		if (!aiLoading && !aiError) {
			for (let i = 0; i < aiResults.length; i++) {
				const href = aiResults[i].href;
				items.push({
					id: `ai:${i}`,
					run: async () => {
						closeSearch();
						await goto(href);
					}
				});
			}
		}
		for (let i = 0; i < geoHits.length; i++) {
			const hit = geoHits[i];
			const navId = `geo:${i}`;
			items.push({ id: navId, run: () => selectGeoHit(hit, navId) });
		}
		for (let i = 0; i < localClusters.length; i++) {
			const cid = localClusters[i].c.id;
			items.push({
				id: `cluster:${i}`,
				run: async () => {
					closeSearch();
					await goto(`/cluster/${cid}`);
				}
			});
		}
		if (q.length >= 3 && !aiLoading && aiQueryRan !== q) {
			items.push({ id: 'ask-ai', run: () => runAiSearch() });
		}
		return items;
	});

	const activeNavId = $derived(
		activeIdx >= 0 && activeIdx < navItems.length ? navItems[activeIdx].id : null
	);

	// Keep activeIdx within bounds when async results arrive or change
	$effect(() => {
		const len = navItems.length;
		if (activeIdx >= len) {
			activeIdx = len > 0 ? len - 1 : -1;
		}
	});

	// Pre-warm GeoSearch address hit when highlighted via keyboard arrows
	$effect(() => {
		if (activeNavId && activeNavId.startsWith('geo:')) {
			const idx = Number(activeNavId.slice(4));
			if (geoHits[idx]) prefetchGeoHit(geoHits[idx]);
		}
	});

	function scrollActiveIntoView(id: string | null) {
		if (!id || !dropdownEl) return;
		const el = dropdownEl.querySelector<HTMLElement>(`[data-nav-id="${id}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	}

	function setActiveById(id: string) {
		const idx = navItems.findIndex((it) => it.id === id);
		if (idx !== -1) activeIdx = idx;
	}

	function onKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = true;
			activeIdx = -1;
			inputEl?.focus();
			inputEl?.select();
			return;
		}
		if (
			e.key === '/' &&
			!open &&
			document.activeElement?.tagName !== 'INPUT' &&
			document.activeElement?.tagName !== 'TEXTAREA'
		) {
			e.preventDefault();
			open = true;
			activeIdx = -1;
			inputEl?.focus();
		}
	}

	function onInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
			activeIdx = -1;
			inputEl?.blur();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			if (!open) open = true;
			if (navItems.length === 0) return;
			const next = activeIdx < navItems.length - 1 ? activeIdx + 1 : 0;
			activeIdx = next;
			scrollActiveIntoView(navItems[next]?.id ?? null);
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			if (!open) open = true;
			if (navItems.length === 0) return;
			const prev = activeIdx > 0 ? activeIdx - 1 : navItems.length - 1;
			activeIdx = prev;
			scrollActiveIntoView(navItems[prev]?.id ?? null);
			return;
		}
		if (e.key === 'Enter' && open && activeIdx >= 0 && navItems[activeIdx]) {
			e.preventDefault();
			e.stopPropagation();
			void navItems[activeIdx].run();
		}
	}

	onMount(() => {
		const onDocClick = (e: MouseEvent) => {
			if (searchBoxEl && !searchBoxEl.contains(e.target as Node)) {
				open = false;
			}
		};
		window.addEventListener('keydown', onKeydown);
		document.addEventListener('mousedown', onDocClick);
		return () => {
			window.removeEventListener('keydown', onKeydown);
			document.removeEventListener('mousedown', onDocClick);
		};
	});

	const showDropdown = $derived(
		open &&
			(query.trim().length === 0 ||
				localClusters.length > 0 ||
				geoHits.length > 0 ||
				aiLoading ||
				aiAnswer.length > 0 ||
				aiResults.length > 0 ||
				aiError.length > 0 ||
				query.trim().length >= 3)
	);

	const isRootView = $derived(!cluster && !block && !building);
</script>

<header class="topbar">
	<div class="bar-left">
		<nav class="crumbs" aria-label="Breadcrumb">
			<a href="/" class="crumb root" class:current={!cluster && !section} title="NYC Storefront Vacancy">
				<svg
					class="glaser-mark"
					viewBox="0 0 40 40"
					width="34"
					height="34"
					fill="none"
					aria-hidden="true"
				>
					<!-- Classic 2×2 Milton Glaser I ♥ NY lockup -->
					<text x="11.2" y="17.2" text-anchor="middle" class="glaser-letter">I</text>
					<path
						d="M27.6 18.2 C27.6 18.2 19.6 13.3 19.6 8.3 C19.6 5.8 21.6 4.0 23.9 4.0 C25.5 4.0 26.9 4.9 27.6 6.2 C28.3 4.9 29.7 4.0 31.3 4.0 C33.6 4.0 35.6 5.8 35.6 8.3 C35.6 13.3 27.6 18.2 27.6 18.2 Z"
						fill="#e62217"
					/>
					<text x="11.6" y="35.6" text-anchor="middle" class="glaser-letter">N</text>
					<text x="27.8" y="35.6" text-anchor="middle" class="glaser-letter">Y</text>
				</svg>
				<span class="brand-divider" aria-hidden="true"></span>
				<span class="brand-lockup">
					<span class="brand-line">Storefront</span>
					<span class="brand-line brand-vacancy">Vacancy</span>
				</span>
			</a>

			{#if isRootView}
				<div class="primary-nav" role="navigation" aria-label="Primary views">
					<a href="/" class="pnav-link" class:active={!section}>Map</a>
					<a href="/trends" class="pnav-link" class:active={section === 'Trends'}>Trends</a>
				</div>
			{:else}
				{#if cluster}
					<span class="sep" aria-hidden="true">/</span>
					<a href="/cluster/{cluster.id}" class="crumb" class:current={!block} title={cluster.name}>
						<span class="crumb-name">{cluster.name}</span>
						<span class="rate-mono {rateTone(cluster.rate)}">{pct(cluster.rate, 1)}</span>
					</a>
				{/if}

				{#if cluster && block}
					<span class="sep" aria-hidden="true">/</span>
					{#if building}
						<a
							href="/cluster/{cluster.id}/block/{block.id}"
							class="crumb"
							title={block.label}
						>
							<span class="crumb-name">{block.label}</span>
							<span class="rate-mono {rateTone(block.rate)}">{pct(block.rate, 1)}</span>
						</a>
						<span class="sep" aria-hidden="true">/</span>
						<span class="crumb current" title={building.label}>
							<span class="crumb-name">{building.label}</span>
						</span>
					{:else}
						<span class="crumb current" title={block.label}>
							<span class="crumb-name">{block.label}</span>
							<span class="rate-mono {rateTone(block.rate)}">{pct(block.rate, 1)}</span>
						</span>
					{/if}
				{/if}
			{/if}
		</nav>
	</div>

	<div class="bar-right">
		<div class="search-shell" bind:this={searchBoxEl}>
			<form
				class="find-form"
				class:focused={open}
				onsubmit={(e) => {
					e.preventDefault();
					handleSubmit();
				}}
			>
				<svg class="search-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
					<circle cx="7" cy="7" r="4.8" stroke="currentColor" stroke-width="1.5" />
					<path d="M10.7 10.7L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				</svg>
				<input
					bind:this={inputEl}
					type="search"
					bind:value={query}
					onfocus={() => {
						open = true;
					}}
					oninput={() => {
						open = true;
						activeIdx = -1;
						error = '';
						if (query.trim() !== aiQueryRan) {
							aiAnswer = '';
							aiResults = [];
							aiError = '';
						}
					}}
					onkeydown={onInputKeydown}
					placeholder="Address, area, or ask anything…"
					role="combobox"
					aria-label="Search NYC addresses, neighborhoods, or ask a question"
					aria-expanded={showDropdown}
					aria-controls="topbar-search-listbox"
					aria-autocomplete="list"
					autocomplete="off"
				/>
				{#if !open && !query}
					<kbd class="kbd-hint" title="Press ⌘K or / to search">⌘K</kbd>
				{/if}
				<button
					type="button"
					class="geo-btn"
					onclick={jumpToMyBlock}
					disabled={locating}
					title="Jump to my current NYC block"
					aria-label="Jump to my current NYC block"
				>
					{#if locating}
						<span class="spin-dot"></span>
					{:else}
						<svg viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true">
							<circle cx="8" cy="8" r="2.2" fill="currentColor" />
							<circle cx="8" cy="8" r="5.2" stroke="currentColor" stroke-width="1.35" />
							<path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
						</svg>
					{/if}
				</button>
				<button type="submit" class="go-btn" disabled={searching || aiLoading} title={searching ? `Opening ${jumpingLabel || 'result'}…` : 'Go'}>
					{#if searching || aiLoading}
						<span class="spin-dot"></span>
					{:else}
						→
					{/if}
				</button>
			</form>

			{#if error}
				<div class="err-toast surface-float">{error}</div>
			{/if}

			{#if showDropdown}
				<div
					id="topbar-search-listbox"
					class="search-drop surface-float"
					role="listbox"
					aria-label="Search results"
					bind:this={dropdownEl}
				>
					{#if query.trim().length === 0}
						<div class="drop-sec">
							<button
								type="button"
								role="option"
								aria-selected={activeNavId === 'gps'}
								data-nav-id="gps"
								class="drop-row near-me"
								class:active={activeNavId === 'gps'}
								onmouseenter={() => setActiveById('gps')}
								onclick={jumpToMyBlock}
								disabled={locating}
							>
								<span class="dr-badge accent">GPS</span>
								<div class="dr-copy">
									<strong>{locating ? 'Locating your block…' : 'Jump to my current NYC block'}</strong>
									<span>Snap straight to the storefronts outside right now</span>
								</div>
								<span class="dr-go">{activeNavId === 'gps' ? '↵' : '→'}</span>
							</button>
						</div>

						<div class="drop-sec">
							<div class="drop-kicker">Ask NYC Storefronts · AI</div>
							{#each EXAMPLE_PROMPTS as ex, i}
								{@const navId = `ex:${i}`}
								<button
									type="button"
									role="option"
									aria-selected={activeNavId === navId}
									data-nav-id={navId}
									class="drop-row prompt-row"
									class:active={activeNavId === navId}
									onmouseenter={() => setActiveById(navId)}
									onclick={() => runAiSearch(ex)}
								>
									<span class="dr-spark" aria-hidden="true">✦</span>
									<div class="dr-copy">
										<strong class="prompt-text">{ex}</strong>
									</div>
									{#if activeNavId === navId}
										<span class="dr-go">↵</span>
									{/if}
								</button>
							{/each}
						</div>
					{:else}
						<!-- Live AI Answer & Ranked Picks -->
						{#if aiLoading}
							<div class="drop-sec ai-box">
								<div class="ai-status">
									<span class="dr-spark pulse" aria-hidden="true">✦</span>
									<span>Searching 349 clusters & NYC records…</span>
								</div>
							</div>
						{:else if aiAnswer || aiResults.length > 0 || aiError}
							<div class="drop-sec ai-box">
								<div class="drop-kicker ai-kicker">
									<span>✦ AI Answer</span>
								</div>
								{#if aiError}
									<p class="ai-err">{aiError}</p>
								{:else}
									{#if aiAnswer}
										<p class="ai-answer">{aiAnswer}</p>
									{/if}
									{#each aiResults as r, i}
										{@const navId = `ai:${i}`}
										<a
											href={r.href}
											role="option"
											aria-selected={activeNavId === navId}
											data-nav-id={navId}
											class="drop-row"
											class:active={activeNavId === navId}
											onmouseenter={() => setActiveById(navId)}
											onclick={() => closeSearch()}
										>
											<div class="dr-copy">
												<strong>{r.title}</strong>
												<span>{r.subtitle}{r.reason ? ` · ${r.reason}` : ''}</span>
											</div>
											{#if r.badge}
												<span class="rate-mono {r.tone || ''}">{r.badge}</span>
											{/if}
										</a>
									{/each}
								{/if}
							</div>
						{/if}

						<!-- Live NYC GeoSearch Street Addresses -->
						{#if geoHits.length > 0}
							<div class="drop-sec">
								<div class="drop-kicker">NYC Addresses</div>
								{#each geoHits as hit, i}
									{@const navId = `geo:${i}`}
									{@const isJumping = jumpingNavId === navId}
									<button
										type="button"
										role="option"
										aria-selected={activeNavId === navId}
										data-nav-id={navId}
										class="drop-row"
										class:active={activeNavId === navId || isJumping}
										class:jumping={isJumping}
										disabled={searching}
										onmouseenter={() => {
											setActiveById(navId);
											prefetchGeoHit(hit);
										}}
										onclick={() => selectGeoHit(hit, navId)}
									>
										<div class="dr-copy">
											<strong>{hit.label}</strong>
											<span>
												{#if isJumping}
													Opening {hit.bbl ? 'building dossier' : 'block'}…
												{:else}
													{hit.borough}{hit.bbl ? ' · Jump straight to building' : ' · Jump to block'}
												{/if}
											</span>
										</div>
										<span class="dr-badge" class:accent={isJumping}>
											{#if isJumping}
												<span class="spin-dot inline"></span>
											{:else}
												{activeNavId === navId ? '↵' : hit.bbl ? 'Bldg' : 'Block'}
											{/if}
										</span>
									</button>
								{/each}
							</div>
						{/if}

						<!-- Instant 0ms Local Cluster Matches -->
						{#if localClusters.length > 0}
							<div class="drop-sec">
								<div class="drop-kicker">Clusters & Corridors</div>
								{#each localClusters as { c, matchedStreet }, i}
									{@const navId = `cluster:${i}`}
									<a
										href="/cluster/{c.id}"
										role="option"
										aria-selected={activeNavId === navId}
										data-nav-id={navId}
										class="drop-row"
										class:active={activeNavId === navId}
										onmouseenter={() => setActiveById(navId)}
										onclick={() => closeSearch()}
									>
										<div class="dr-copy">
											<strong>{c.name}</strong>
											<span>
												{c.borough} · {c.vacant_storefronts}/{c.total_storefronts} empty
												{#if matchedStreet}· via {matchedStreet}{/if}
											</span>
										</div>
										<div class="dr-metrics">
											<span class="rate-mono {rateTone(c.vacancy_rate)}">{pct(c.vacancy_rate, 1)}</span>
											{#if c.yoy_change !== null && c.yoy_change !== undefined}
												<span class="dr-delta {deltaTone(c.yoy_change, 0.01)}">
													{deltaPts(c.yoy_change, 1)}
												</span>
											{/if}
										</div>
									</a>
								{/each}
							</div>
						{/if}

						<!-- Always-available AI Natural Language Trigger -->
						{#if query.trim().length >= 3 && !aiLoading && aiQueryRan !== query.trim()}
							<div class="drop-sec ask-foot">
								<button
									type="button"
									role="option"
									aria-selected={activeNavId === 'ask-ai'}
									data-nav-id="ask-ai"
									class="drop-row ask-row"
									class:active={activeNavId === 'ask-ai'}
									onmouseenter={() => setActiveById('ask-ai')}
									onclick={() => runAiSearch()}
								>
									<span class="dr-spark" aria-hidden="true">✦</span>
									<div class="dr-copy">
										<strong>Ask AI: “{query.trim()}”</strong>
										<span>Search trends, places, or compare neighborhoods</span>
									</div>
									<span class="dr-go">↵</span>
								</button>
							</div>
						{/if}
					{/if}
				</div>
			{/if}
		</div>

		{#if !isRootView}
			<a href="/trends" class="about-link" class:active={section === 'Trends'}>Trends</a>
		{/if}
		<a href="/about" class="about-link" class:active={section === 'About'}>About</a>
	</div>
</header>

<style>
	.topbar {
		flex: none;
		width: 100%;
		max-width: 100%;
		box-sizing: border-box;
		height: 58px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 0 18px;
		background: var(--panel);
		border-bottom: 1px solid var(--rule);
		z-index: 40;
		position: relative;
	}

	.bar-left {
		display: flex;
		align-items: center;
		min-width: 0;
		flex: 1 1 0%;
		overflow: hidden;
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
	}

	.crumb {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		text-decoration: none;
		color: var(--muted);
		font-size: 12.5px;
		font-weight: 500;
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.crumb.root {
		padding: 3px 6px 3px 2px;
		gap: 9px;
		flex: none;
		overflow: visible;
		color: var(--ink);
	}

	a.crumb:hover {
		background: var(--quiet);
		color: var(--ink);
	}

	.crumb.current {
		color: var(--ink);
		font-weight: 600;
	}

	.glaser-mark {
		flex: none;
		display: block;
	}

	.glaser-letter {
		font-family: 'American Typewriter', 'Courier Prime', 'Rockwell', Georgia, serif;
		font-size: 18.5px;
		font-weight: 700;
		fill: #111111;
	}

	.brand-divider {
		width: 1px;
		height: 28px;
		background: var(--rule);
		flex: none;
	}

	.brand-lockup {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 1px;
		line-height: 1.08;
		white-space: nowrap;
	}

	.brand-line {
		font-size: 13px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--ink);
	}

	.brand-vacancy {
		position: relative;
		display: inline-block;
	}

	.brand-vacancy::after {
		content: '';
		position: absolute;
		left: -1px;
		right: -1px;
		top: 55%;
		height: 1.5px;
		background: #e62217;
		pointer-events: none;
	}

	.primary-nav {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-left: 10px;
		padding: 2px;
		background: var(--page);
		border: 1px solid var(--rule);
		border-radius: 7px;
	}

	.pnav-link {
		text-decoration: none;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
		padding: 4px 10px;
		border-radius: 5px;
		transition: color 0.12s ease, background 0.12s ease;
	}

	.pnav-link:hover {
		color: var(--ink);
	}

	.pnav-link.active {
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}

	.crumb-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
		max-width: 190px;
	}

	.sep {
		color: var(--line);
		font-family: var(--font-mono);
		font-size: 13px;
		flex: none;
	}

	.rate-mono {
		flex: none;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--quiet);
		color: var(--muted);
	}

	.rate-mono.hot {
		background: var(--red-bg);
		color: var(--red);
	}

	.rate-mono.steady {
		background: var(--amber-bg);
		color: var(--amber);
	}

	.rate-mono.thriving {
		background: var(--green-bg);
		color: var(--green);
	}

	.bar-right {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
	}

	.about-link {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
		text-decoration: none;
		padding: 4px 7px;
		border-radius: var(--radius-sm);
		transition: color 0.12s ease, background 0.12s ease;
	}

	.about-link:hover,
	.about-link.active {
		color: var(--ink);
		background: var(--quiet);
	}

	.search-shell {
		position: relative;
	}

	.find-form {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: var(--page);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		padding: 2px 3px 2px 9px;
		transition: border-color 0.12s ease, background 0.12s ease, width 0.16s ease, box-shadow 0.14s ease;
	}

	.find-form.focused {
		border-color: var(--ink);
		background: var(--panel);
		box-shadow: 0 2px 10px rgba(0, 0, 0, 0.06);
	}

	.search-ico {
		color: var(--muted-light);
		flex: none;
	}

	.find-form input {
		border: 0;
		background: transparent;
		font: inherit;
		font-size: 12px;
		width: 215px;
		outline: none;
		color: var(--ink);
		transition: width 0.16s ease;
	}

	.find-form.focused input {
		width: 255px;
	}

	.find-form input::placeholder {
		color: var(--muted-light);
	}

	.kbd-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted-light);
		background: var(--panel);
		border: 1px solid var(--rule);
		border-radius: 4px;
		padding: 1px 4px;
		flex: none;
		pointer-events: none;
	}

	.geo-btn,
	.go-btn {
		border: 0;
		background: transparent;
		color: var(--muted);
		border-radius: 4px;
		width: 26px;
		height: 26px;
		font-size: 13px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background 0.12s ease, color 0.12s ease;
		flex: none;
	}

	.geo-btn:hover {
		background: var(--quiet);
		color: #e62217;
	}

	.go-btn:hover {
		background: var(--ink);
		color: #ffffff;
	}

	.spin-dot {
		width: 8px;
		height: 8px;
		border-radius: 99px;
		background: #e62217;
		display: inline-block;
		animation: pulseDot 0.9s infinite ease-in-out;
	}

	.spin-dot.inline {
		width: 7px;
		height: 7px;
		vertical-align: middle;
	}

	.drop-row.jumping {
		background: var(--accent-soft);
	}

	@keyframes pulseDot {
		0%, 100% { opacity: 0.3; transform: scale(0.85); }
		50% { opacity: 1; transform: scale(1.15); }
	}

	.err-toast {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		padding: 6px 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--red);
		z-index: 60;
		white-space: nowrap;
	}

	.search-drop {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		width: 420px;
		max-width: calc(100vw - 24px);
		max-height: 76vh;
		overflow-y: auto;
		z-index: 60;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.drop-sec {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.drop-sec + .drop-sec {
		padding-top: 6px;
		border-top: 1px solid var(--rule);
	}

	.drop-kicker {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-light);
		padding: 3px 8px 2px;
	}

	.ai-kicker {
		color: #b42318;
	}

	.drop-row {
		width: 100%;
		border: 0;
		background: transparent;
		text-align: left;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 7px 8px;
		border-radius: 6px;
		text-decoration: none;
		color: var(--ink);
		cursor: pointer;
		font: inherit;
		transition: background 0.1s ease;
	}

	.drop-row:hover,
	.drop-row.active {
		background: var(--quiet);
	}

	.drop-row.active {
		box-shadow: inset 2.5px 0 0 var(--ink);
	}

	.dr-copy {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.dr-copy strong {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dr-copy strong.prompt-text {
		font-weight: 500;
		white-space: normal;
	}

	.dr-copy span {
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dr-metrics {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex: none;
	}

	.dr-delta {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
	}

	.dr-delta.worse { color: var(--red); }
	.dr-delta.better { color: var(--green); }
	.dr-delta.flat { color: var(--muted-light); }

	.dr-badge {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 5px;
		border-radius: 4px;
		background: var(--page);
		border: 1px solid var(--rule);
		color: var(--muted);
		flex: none;
	}

	.dr-badge.accent {
		background: #fef2f2;
		border-color: #fecaca;
		color: #e62217;
	}

	.dr-spark {
		color: #e62217;
		font-size: 12px;
		flex: none;
		line-height: 1;
	}

	.dr-spark.pulse {
		animation: pulseDot 0.9s infinite ease-in-out;
	}

	.dr-go {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--muted-light);
		flex: none;
	}

	.ai-box {
		background: #fafaf8;
		border-radius: 6px;
		padding: 4px 2px;
	}

	.ai-status {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		font-size: 12px;
		color: var(--muted);
	}

	.ai-answer {
		margin: 2px 8px 6px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--ink-soft);
	}

	.ai-err {
		margin: 2px 8px 6px;
		font-size: 11.5px;
		color: var(--red);
	}

	.ask-row {
		background: #fafaf8;
	}

	@media (max-width: 920px) {
		.topbar {
			height: auto;
			padding: 8px 14px;
			flex-wrap: wrap;
			gap: 8px;
		}
		.crumb-name {
			max-width: 160px;
		}
		.bar-right {
			width: 100%;
		}
		.search-shell {
			flex: 1;
		}
		.find-form {
			width: 100%;
		}
		.find-form input,
		.find-form.focused input {
			flex: 1;
			width: auto;
		}
		.search-drop {
			left: 0;
			right: 0;
			width: auto;
		}
	}
</style>
