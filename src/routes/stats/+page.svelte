<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import type { StatsSnapshot } from '$lib/server/analytics';
	import { browser } from '$app/environment';
	import { numFmt } from '$lib/format';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type RangeKey = 'today' | 'last7d' | 'last30d' | 'allTime';
	type ChartMode = 'hourly' | 'daily';

	let liveSnapshot = $state<StatsSnapshot | null>(null);
	let range = $state<RangeKey>('today');
	let chartMode = $state<ChartMode>('hourly');
	let autoRefresh = $state(true);
	let refreshing = $state(false);
	let hoveredIdx = $state<number | null>(null);
	let ignoreThisBrowser = $state(false);

	const snapshot = $derived(liveSnapshot ?? data.snapshot);

	// Resolve cluster IDs (e.g. c-102) into readable cluster names + borough codes
	const boroShort: Record<string, string> = {
		Manhattan: 'MN',
		Brooklyn: 'BK',
		Queens: 'QN',
		Bronx: 'BX',
		'Staten Island': 'SI'
	};
	const clusterLookup = $derived.by(() => {
		const map = new Map<string, { name: string; boro: string }>();
		const features = data.clustersData?.clusters?.features ?? [];
		for (const f of features) {
			const p = f.properties;
			if (p?.id) {
				map.set(p.id, { name: p.name, boro: boroShort[p.borough] || p.borough });
			}
		}
		return map;
	});

	$effect(() => {
		if (!browser) return;
		try {
			ignoreThisBrowser = window.localStorage.getItem('nyc_sf_notrack') === '1';
		} catch {
			ignoreThisBrowser = false;
		}
	});

	function toggleIgnoreBrowser() {
		if (!browser) return;
		const next = !ignoreThisBrowser;
		ignoreThisBrowser = next;
		try {
			if (next) {
				window.localStorage.setItem('nyc_sf_notrack', '1');
			} else {
				window.localStorage.removeItem('nyc_sf_notrack');
			}
		} catch {
			// Ignore storage restrictions
		}
	}

	async function refreshNow() {
		if (!data.authorized || refreshing) return;
		refreshing = true;
		try {
			const res = await fetch('/api/stats', { cache: 'no-store' });
			if (res.ok) {
				liveSnapshot = (await res.json()) as StatsSnapshot;
			}
		} catch {
			// Keep existing snapshot on transient network error
		} finally {
			refreshing = false;
		}
	}

	$effect(() => {
		if (!browser || !data.authorized || !autoRefresh) return;
		const id = setInterval(() => {
			if (!document.hidden) refreshNow();
		}, 15000);
		return () => clearInterval(id);
	});

	const activeSummary = $derived.by(() => {
		if (!snapshot) return null;
		return snapshot[range];
	});

	const chartBars = $derived.by(() => {
		if (!snapshot) return [];
		if (chartMode === 'hourly') {
			return snapshot.hourly48.map((h) => ({
				key: h.hour,
				label: h.label,
				shortLabel: h.label.split(' ')[1] || h.label,
				visitors: h.visitors,
				pageviews: h.pageviews
			}));
		}
		return snapshot.daily30.map((d) => ({
			key: d.date,
			label: d.label,
			shortLabel: d.label,
			visitors: d.visitors,
			pageviews: d.pageviews
		}));
	});

	const chartMax = $derived.by(() => {
		let max = 1;
		for (const b of chartBars) {
			if (b.pageviews > max) max = b.pageviews;
		}
		return max;
	});

	const activeBar = $derived.by(() => {
		if (hoveredIdx !== null && chartBars[hoveredIdx]) return chartBars[hoveredIdx];
		return null;
	});

	const todayDelta = $derived.by(() => {
		if (!snapshot) return null;
		const cur = snapshot.today.visitors;
		const prev = snapshot.yesterdayVisitors;
		if (prev === 0) return null;
		const diff = cur - prev;
		const pctDiff = Math.round((diff / prev) * 100);
		return { diff, pctDiff };
	});

	const sectionEntries = $derived.by(() => {
		if (!activeSummary) return [];
		const entries = Object.entries(activeSummary.sections).sort((a, b) => b[1] - a[1]);
		const total = entries.reduce((acc, [, v]) => acc + v, 0) || 1;
		return entries.map(([name, count]) => ({
			name,
			count,
			pct: Math.round((count / total) * 100)
		}));
	});

	const deviceEntries = $derived.by(() => {
		if (!activeSummary) return [];
		const d = activeSummary.devices;
		const total = d.desktop + d.mobile + d.tablet || 1;
		return [
			{ name: 'Desktop', count: d.desktop, pct: Math.round((d.desktop / total) * 100) },
			{ name: 'Mobile', count: d.mobile, pct: Math.round((d.mobile / total) * 100) },
			{ name: 'Tablet', count: d.tablet, pct: Math.round((d.tablet / total) * 100) }
		].filter((x) => x.count > 0 || x.name !== 'Tablet');
	});

	function formatPageLabel(path: string, rawTitle: string): string {
		if (path === '/') return 'NYC City Map';
		if (path === '/trends') return 'Citywide Trends';
		if (path === '/about') return 'About';
		const clusterOnly = path.match(/^\/cluster\/([^/]+)$/);
		if (clusterOnly) {
			const c = clusterLookup.get(clusterOnly[1]);
			if (c) return `${c.name} (${c.boro})`;
		}
		if (rawTitle && rawTitle !== path) return rawTitle;
		return path;
	}

	function formatUpdated(iso: string): string {
		try {
			return new Date(iso).toLocaleTimeString('en-US', {
				hour: 'numeric',
				minute: '2-digit',
				second: '2-digit'
			});
		} catch {
			return '';
		}
	}

	function formatSince(iso: string): string {
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		} catch {
			return '';
		}
	}
</script>

<svelte:head>
	<title>Traffic Stats | NYC Storefront Vacancy</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if !data.authorized}
	<div class="auth-shell">
		<div class="auth-card surface">
			<div class="auth-head">
				<span class="kicker">Private Analytics</span>
				<h1>NYC Storefront Traffic</h1>
				<p>
					{#if data.configured}
						Enter your stats passcode to view live visitor counts, referrers, and trending blocks.
					{:else}
						Set <code>STATS_SECRET</code> in your Railway environment variables to enable the private
						traffic dashboard in production.
					{/if}
				</p>
			</div>

			{#if data.configured}
				<form method="POST" action="?/login" class="auth-form">
					<label class="auth-label" for="stats-key">Passcode</label>
					<input
						id="stats-key"
						name="key"
						type="password"
						required
						autocomplete="current-password"
						placeholder="Enter stats passcode"
						class="auth-input"
					/>
					{#if form?.error}
						<p class="auth-err">{form.error}</p>
					{/if}
					<button type="submit" class="btn primary auth-submit">Unlock Dashboard</button>
				</form>
			{/if}

			<div class="auth-foot">
				<a href="/">← Back to NYC Storefront Map</a>
			</div>
		</div>
	</div>
{:else if snapshot && activeSummary}
	<div class="stats-shell">
		<header class="stats-header">
			<div class="stats-header-inner">
				<div class="sh-left">
					<a href="/" class="back-link">← Map</a>
					<span class="sh-sep" aria-hidden="true">/</span>
					<h1 class="sh-title">Traffic</h1>
					<span class="live-pill" class:has-live={snapshot.liveCount > 0}>
						<span class="live-dot"></span>
						<strong>{numFmt(snapshot.liveCount)}</strong> live
					</span>
					{#if data.localOpen}
						<span class="local-pill">Local dev</span>
					{/if}
				</div>

				<div class="sh-actions">
					<button
						type="button"
						class="chip-btn"
						class:active={ignoreThisBrowser}
						onclick={toggleIgnoreBrowser}
						title="Exclude visits from this browser so your own browsing doesn't count"
					>
						{ignoreThisBrowser ? '✓ Browser excluded' : 'Exclude my browser'}
					</button>
					<button
						type="button"
						class="chip-btn"
						class:active={autoRefresh}
						onclick={() => (autoRefresh = !autoRefresh)}
					>
						{autoRefresh ? 'Auto · 15s' : 'Auto · Off'}
					</button>
					<button type="button" class="chip-btn" onclick={refreshNow} disabled={refreshing}>
						{refreshing ? 'Refreshing…' : 'Refresh'}
					</button>
					{#if data.configured}
						<form method="POST" action="?/logout">
							<button type="submit" class="chip-btn subtle">Lock</button>
						</form>
					{/if}
				</div>
			</div>
		</header>

		<main class="stats-main">
			<!-- Range selector + metadata -->
			<div class="toolbar">
				<div class="segmented" role="tablist" aria-label="Time range">
					{#each [
						{ id: 'today', label: 'Today' },
						{ id: 'last7d', label: '7 Days' },
						{ id: 'last30d', label: '30 Days' },
						{ id: 'allTime', label: 'All Time' }
					] as tab}
						<button
							type="button"
							role="tab"
							aria-selected={range === tab.id}
							class="seg-btn"
							class:active={range === tab.id}
							onclick={() => (range = tab.id as RangeKey)}
						>
							{tab.label}
						</button>
					{/each}
				</div>
				<div class="toolbar-meta">
					<span>Tracking since {formatSince(snapshot.trackingSince)}</span>
					<span class="dot">·</span>
					<span>Updated {formatUpdated(snapshot.generatedAt)}</span>
				</div>
			</div>

			<!-- Hero KPI strip -->
			<section class="kpi-grid">
				<div class="kpi-card surface">
					<span class="kicker">{activeSummary.label} · Visitors</span>
					<div class="kpi-value">{numFmt(activeSummary.visitors)}</div>
					<div class="kpi-sub">
						{#if range === 'today' && todayDelta}
							<span class:pos={todayDelta.diff >= 0} class:neg={todayDelta.diff < 0}>
								{todayDelta.diff >= 0 ? '↑' : '↓'}
								{Math.abs(todayDelta.pctDiff)}% vs yesterday ({numFmt(snapshot.yesterdayVisitors)})
							</span>
						{:else if range === 'today'}
							<span>Yesterday: {numFmt(snapshot.yesterdayVisitors)}</span>
						{:else}
							<span>Unique anonymous visitors</span>
						{/if}
					</div>
				</div>

				<div class="kpi-card surface">
					<span class="kicker">{activeSummary.label} · Pageviews</span>
					<div class="kpi-value">{numFmt(activeSummary.pageviews)}</div>
					<div class="kpi-sub">
						{activeSummary.pagesPerVisitor > 0
							? `${activeSummary.pagesPerVisitor} pages / visitor`
							: 'No visits yet in window'}
					</div>
				</div>

				<div class="kpi-card surface">
					<span class="kicker">Live Right Now</span>
					<div class="kpi-value live-num">{numFmt(snapshot.liveCount)}</div>
					<div class="kpi-sub">
						{#if snapshot.peakHour48h}
							Peak 48h: {numFmt(snapshot.peakHour48h.visitors)} ({snapshot.peakHour48h.hour.slice(
								5
							)}h)
						{:else}
							Active in last 5 minutes
						{/if}
					</div>
				</div>

				<div class="kpi-card surface">
					<span class="kicker">All-Time Total</span>
					<div class="kpi-value">{numFmt(snapshot.allTime.visitors)}</div>
					<div class="kpi-sub">
						{numFmt(snapshot.allTime.pageviews)} views
						{#if snapshot.peakDay}
							· Peak {numFmt(snapshot.peakDay.visitors)} ({snapshot.peakDay.date.slice(5)})
						{/if}
					</div>
				</div>
			</section>

			<!-- Traffic Timeline Chart -->
			<section class="chart-card surface">
				<div class="chart-head">
					<div>
						<span class="kicker">Traffic Timeline · NYC Time (ET)</span>
						<div class="chart-inspect">
							{#if activeBar}
								<strong>{activeBar.label}</strong>
								<span>
									{numFmt(activeBar.visitors)} visitor{activeBar.visitors === 1 ? '' : 's'} ·
									{numFmt(activeBar.pageviews)} view{activeBar.pageviews === 1 ? '' : 's'}
								</span>
							{:else}
								<strong>
									{chartMode === 'hourly' ? 'Last 48 Hours' : 'Last 30 Days'}
								</strong>
								<span class="legend-inline">
									<i class="swatch visitors"></i> Visitors
									<i class="swatch views"></i> Pageviews
								</span>
							{/if}
						</div>
					</div>
					<div class="segmented small">
						<button
							type="button"
							class="seg-btn"
							class:active={chartMode === 'hourly'}
							onclick={() => {
								chartMode = 'hourly';
								hoveredIdx = null;
							}}
						>
							48h Hourly
						</button>
						<button
							type="button"
							class="seg-btn"
							class:active={chartMode === 'daily'}
							onclick={() => {
								chartMode = 'daily';
								hoveredIdx = null;
							}}
						>
							30d Daily
						</button>
					</div>
				</div>

				<div
					class="bar-chart"
					role="img"
					aria-label="Traffic bar chart"
					onmouseleave={() => (hoveredIdx = null)}
				>
					{#each chartBars as bar, i}
						{@const pvPct = Math.max(bar.pageviews > 0 ? 4 : 0, (bar.pageviews / chartMax) * 100)}
						{@const visPct = Math.max(bar.visitors > 0 ? 4 : 0, (bar.visitors / chartMax) * 100)}
						<button
							type="button"
							class="bar-col"
							class:hovered={hoveredIdx === i}
							onmouseenter={() => (hoveredIdx = i)}
							onfocus={() => (hoveredIdx = i)}
							aria-label="{bar.label}: {bar.visitors} visitors, {bar.pageviews} pageviews"
						>
							<span class="bar-track">
								<span class="bar-pv" style="height: {pvPct}%"></span>
								<span class="bar-vis" style="height: {visPct}%"></span>
							</span>
						</button>
					{/each}
				</div>
				<div class="chart-axis">
					<span>{chartBars[0]?.label ?? ''}</span>
					<span>{chartBars[Math.floor(chartBars.length / 2)]?.label ?? ''}</span>
					<span>{chartBars[chartBars.length - 1]?.label ?? ''}</span>
				</div>
			</section>

			<!-- Two-column breakdowns: Referrers + Top Pages -->
			<section class="two-col">
				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Where Visitors Come From</span>
						<span class="card-badge">{activeSummary.label}</span>
					</div>
					{#if activeSummary.topReferrers.length === 0}
						<p class="empty-note">No external or direct visits recorded yet in this window.</p>
					{:else}
						{@const maxRef = activeSummary.topReferrers[0]?.views || 1}
						<ul class="rank-list">
							{#each activeSummary.topReferrers as item}
								<li class="rank-row">
									<div class="rank-bar" style="width: {(item.views / maxRef) * 100}%"></div>
									<span class="rank-name">{item.source}</span>
									<span class="rank-val">{numFmt(item.views)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Most Viewed Pages</span>
						<span class="card-badge">{activeSummary.label}</span>
					</div>
					{#if activeSummary.topPages.length === 0}
						<p class="empty-note">No pageviews recorded yet in this window.</p>
					{:else}
						{@const maxPg = activeSummary.topPages[0]?.views || 1}
						<ul class="rank-list">
							{#each activeSummary.topPages as item}
								<li class="rank-row">
									<div class="rank-bar" style="width: {(item.views / maxPg) * 100}%"></div>
									<a href={item.path} class="rank-name link" title={item.path}>
										{formatPageLabel(item.path, item.title)}
									</a>
									<span class="rank-val">{numFmt(item.views)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<!-- Two-column NYC-specific: Top Clusters + Top Buildings -->
			<section class="two-col">
				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Most Explored Clusters</span>
						<span class="card-badge">Clusters + Blocks + Buildings</span>
					</div>
					{#if activeSummary.topClusters.length === 0}
						<p class="empty-note">No cluster drill-downs yet in this window.</p>
					{:else}
						{@const maxCl = activeSummary.topClusters[0]?.views || 1}
						<ul class="rank-list">
							{#each activeSummary.topClusters as item}
								{@const info = clusterLookup.get(item.id)}
								<li class="rank-row">
									<div class="rank-bar accent" style="width: {(item.views / maxCl) * 100}%"></div>
									<a href={`/cluster/${item.id}`} class="rank-name link">
										{info ? `${info.name}` : item.id}
										{#if info}
											<span class="boro-tag">{info.boro}</span>
										{/if}
									</a>
									<span class="rank-val">{numFmt(item.views)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Most Viewed Buildings</span>
						<span class="card-badge">{activeSummary.label}</span>
					</div>
					{#if activeSummary.topBuildings.length === 0}
						<p class="empty-note">No building dossiers opened yet in this window.</p>
					{:else}
						{@const maxBld = activeSummary.topBuildings[0]?.views || 1}
						<ul class="rank-list">
							{#each activeSummary.topBuildings as item}
								<li class="rank-row">
									<div class="rank-bar" style="width: {(item.views / maxBld) * 100}%"></div>
									<a href={item.path} class="rank-name link" title={item.path}>
										{item.label}
									</a>
									<span class="rank-val">{numFmt(item.views)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<!-- Bottom row: Live Active Pages + Sections + Devices -->
			<section class="three-col">
				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Active Right Now (5m)</span>
						<span class="card-badge">{numFmt(snapshot.liveCount)} online</span>
					</div>
					{#if snapshot.livePages.length === 0}
						<p class="empty-note">Nobody active in the last 5 minutes.</p>
					{:else}
						<ul class="rank-list">
							{#each snapshot.livePages as lp}
								<li class="rank-row">
									<a href={lp.path} class="rank-name link">
										{formatPageLabel(lp.path, lp.title)}
									</a>
									<span class="rank-val live-val">{numFmt(lp.count)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Site Sections</span>
						<span class="card-badge">{activeSummary.label}</span>
					</div>
					{#if sectionEntries.length === 0}
						<p class="empty-note">No section data yet.</p>
					{:else}
						<ul class="rank-list">
							{#each sectionEntries as s}
								<li class="rank-row">
									<div class="rank-bar" style="width: {s.pct}%"></div>
									<span class="rank-name">{s.name}</span>
									<span class="rank-val">{numFmt(s.count)} · {s.pct}%</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="list-card surface">
					<div class="card-head">
						<span class="kicker">Devices</span>
						<span class="card-badge">{activeSummary.label}</span>
					</div>
					{#if activeSummary.pageviews === 0}
						<p class="empty-note">No device data yet.</p>
					{:else}
						<ul class="rank-list">
							{#each deviceEntries as d}
								<li class="rank-row">
									<div class="rank-bar" style="width: {d.pct}%"></div>
									<span class="rank-name">{d.name}</span>
									<span class="rank-val">{numFmt(d.count)} · {d.pct}%</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</section>

			<footer class="stats-footer">
				Privacy-first first-party counter · Zero cookies · Zero raw IPs stored · Automatic
				HyperLogLog scaling above 5,000 daily uniques · Persisted on Railway volume.
			</footer>
		</main>
	</div>
{/if}

<style>
	/* Auth Gate */
	.auth-shell {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--page);
	}
	.auth-card {
		width: 100%;
		max-width: 400px;
		padding: 28px;
	}
	.auth-head h1 {
		font-size: 22px;
		margin-top: 6px;
	}
	.auth-head p {
		color: var(--muted);
		font-size: 13px;
		margin: 8px 0 0;
		line-height: 1.5;
	}
	.auth-head code {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--quiet);
		padding: 1px 5px;
		border-radius: 4px;
	}
	.auth-form {
		margin-top: 20px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.auth-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-soft);
	}
	.auth-input {
		width: 100%;
		padding: 9px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		font-size: 14px;
		font-family: var(--font-body);
		background: var(--panel);
		color: var(--ink);
	}
	.auth-input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		border-color: var(--accent);
	}
	.auth-err {
		margin: 0;
		font-size: 12.5px;
		color: var(--red);
	}
	.auth-submit {
		margin-top: 4px;
		width: 100%;
		padding: 9px 14px;
	}
	.auth-foot {
		margin-top: 20px;
		padding-top: 14px;
		border-top: 1px solid var(--rule);
		font-size: 12.5px;
	}
	.auth-foot a {
		color: var(--muted);
		text-decoration: none;
	}
	.auth-foot a:hover {
		color: var(--ink);
	}

	/* Dashboard Layout */
	.stats-shell {
		min-height: 100vh;
		background: var(--page);
		padding-bottom: 48px;
	}
	.stats-header {
		position: sticky;
		top: 0;
		z-index: 20;
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--rule);
	}
	.stats-header-inner {
		max-width: 1160px;
		margin: 0 auto;
		padding: 12px 24px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.sh-left {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.back-link {
		font-size: 13px;
		font-weight: 500;
		color: var(--muted);
		text-decoration: none;
	}
	.back-link:hover {
		color: var(--ink);
	}
	.sh-sep {
		color: var(--line);
	}
	.sh-title {
		font-size: 16px;
		font-weight: 600;
	}
	.live-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 9px;
		border-radius: 999px;
		font-family: var(--font-mono);
		font-size: 11.5px;
		background: var(--quiet);
		color: var(--muted);
		border: 1px solid var(--rule);
	}
	.live-pill.has-live {
		background: var(--green-bg);
		color: var(--green);
		border-color: rgba(22, 121, 75, 0.25);
	}
	.live-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--muted-light);
	}
	.live-pill.has-live .live-dot {
		background: var(--green);
		box-shadow: 0 0 0 3px rgba(22, 121, 75, 0.2);
	}
	.local-pill {
		font-family: var(--font-mono);
		font-size: 10.5px;
		padding: 2px 7px;
		border-radius: 4px;
		background: var(--amber-bg);
		color: var(--amber);
	}
	.sh-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.sh-actions form {
		margin: 0;
	}
	.chip-btn {
		padding: 5px 10px;
		font-family: var(--font-body);
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-soft);
		background: var(--panel);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.chip-btn:hover:not(:disabled) {
		border-color: var(--line);
		background: var(--quiet);
	}
	.chip-btn.active {
		background: var(--ink);
		color: #fff;
		border-color: var(--ink);
	}
	.chip-btn.subtle {
		color: var(--muted);
	}
	.chip-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.stats-main {
		max-width: 1160px;
		margin: 0 auto;
		padding: 22px 24px 0;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	/* Toolbar */
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	.segmented {
		display: inline-flex;
		padding: 3px;
		background: var(--quiet);
		border: 1px solid var(--rule);
		border-radius: var(--radius-md);
		gap: 2px;
	}
	.seg-btn {
		padding: 6px 12px;
		border: none;
		border-radius: 6px;
		background: transparent;
		font-family: var(--font-body);
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
		cursor: pointer;
		transition: all 0.12s ease;
	}
	.segmented.small .seg-btn {
		padding: 4px 10px;
		font-size: 12px;
	}
	.seg-btn:hover {
		color: var(--ink);
	}
	.seg-btn.active {
		background: var(--panel);
		color: var(--ink);
		box-shadow: var(--shadow-sm);
	}
	.toolbar-meta {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* KPIs */
	.kpi-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 14px;
	}
	.kpi-card {
		padding: 18px 20px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.kpi-value {
		font-size: 30px;
		font-weight: 700;
		letter-spacing: -0.03em;
		line-height: 1.1;
		color: var(--ink);
	}
	.kpi-value.live-num {
		color: var(--green);
	}
	.kpi-sub {
		font-size: 12px;
		color: var(--muted);
	}
	.kpi-sub .pos {
		color: var(--green);
		font-weight: 500;
	}
	.kpi-sub .neg {
		color: var(--red);
		font-weight: 500;
	}

	/* Chart */
	.chart-card {
		padding: 20px 22px 16px;
	}
	.chart-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 16px;
	}
	.chart-inspect {
		margin-top: 4px;
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		font-size: 13px;
		color: var(--muted);
	}
	.chart-inspect strong {
		font-size: 15px;
		color: var(--ink);
	}
	.legend-inline {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	.swatch {
		display: inline-block;
		width: 9px;
		height: 9px;
		border-radius: 2px;
	}
	.swatch.visitors {
		background: var(--accent);
	}
	.swatch.views {
		background: #d8d8d2;
		margin-left: 4px;
	}

	.bar-chart {
		height: 160px;
		display: flex;
		align-items: stretch;
		gap: 3px;
		padding-top: 8px;
		border-bottom: 1px solid var(--rule);
	}
	.bar-col {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		padding: 0;
		cursor: pointer;
		display: flex;
		align-items: flex-end;
		border-radius: 3px 3px 0 0;
	}
	.bar-col.hovered {
		background: rgba(17, 17, 17, 0.04);
	}
	.bar-track {
		position: relative;
		width: 100%;
		height: 100%;
		display: block;
	}
	.bar-pv,
	.bar-vis {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		border-radius: 2px 2px 0 0;
		transition: height 0.2s ease;
	}
	.bar-pv {
		background: #dcdcd6;
	}
	.bar-vis {
		background: var(--accent);
	}
	.bar-col.hovered .bar-pv {
		background: #c5c5be;
	}
	.chart-axis {
		display: flex;
		justify-content: space-between;
		margin-top: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--muted);
	}

	/* Breakdown Lists */
	.two-col {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}
	.three-col {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}
	.list-card {
		padding: 18px 20px;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 12px;
	}
	.card-badge {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}
	.empty-note {
		margin: 8px 0 2px;
		font-size: 12.5px;
		color: var(--muted);
	}
	.rank-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.rank-row {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 8px;
		border-radius: 5px;
		overflow: hidden;
		font-size: 13px;
	}
	.rank-bar {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: var(--quiet);
		border-radius: 5px;
		pointer-events: none;
		z-index: 0;
	}
	.rank-bar.accent {
		background: var(--accent-soft);
	}
	.rank-name,
	.rank-val {
		position: relative;
		z-index: 1;
	}
	.rank-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink);
		font-weight: 500;
	}
	.rank-name.link {
		text-decoration: none;
	}
	.rank-name.link:hover {
		text-decoration: underline;
		text-decoration-color: var(--accent);
	}
	.boro-tag {
		display: inline-block;
		margin-left: 6px;
		padding: 1px 5px;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		color: var(--muted);
		background: rgba(255, 255, 255, 0.75);
		border: 1px solid var(--rule);
		border-radius: 4px;
	}
	.rank-val {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink-soft);
	}
	.rank-val.live-val {
		color: var(--green);
		font-weight: 600;
	}

	.stats-footer {
		margin-top: 6px;
		font-size: 11.5px;
		color: var(--muted);
		text-align: center;
	}

	@media (max-width: 900px) {
		.kpi-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.two-col,
		.three-col {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 600px) {
		.stats-header-inner,
		.stats-main {
			padding-left: 14px;
			padding-right: 14px;
		}
		.kpi-value {
			font-size: 24px;
		}
	}
</style>
