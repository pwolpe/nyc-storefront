<script lang="ts">
	import type { PageData } from './$types';
	import { numFmt, pct } from '$lib/format';
	import TopBar from '$lib/components/TopBar.svelte';

	let { data }: { data: PageData } = $props();
	const meta = $derived(data.clustersData.meta);
	const cityRate = $derived(meta.citywideRate);
</script>

<svelte:head>
	<title>About | NYC Storefront Vacancy</title>
</svelte:head>

<div class="page-shell">
	<TopBar {cityRate} clustersData={data.clustersData} section="About" />

	<main class="about-wrap">
		<article class="about-card surface">
			<div class="about-hero">
				<span class="kicker">About</span>
				<h1>Keeping New York’s ground floor alive</h1>
				<p class="lead">
					New York works best when ground-floor vacancy is super low: when corners are lit up,
					small businesses can take a chance on a block, and streets feel alive. I built this site
					in the hope that seeing the city clearly, block by block, helps us learn what’s working,
					spot what’s stuck, and make New York even better.
				</p>
				<div class="hero-stats">
					<div class="hs-cell">
						<strong>{numFmt(meta.clusterCount)}</strong>
						<span>Street-aligned clusters</span>
					</div>
					<div class="hs-cell">
						<strong>{numFmt(meta.segmentCount)}</strong>
						<span>Commercial blocks</span>
					</div>
					<div class="hs-cell">
						<strong>{numFmt(meta.totalStorefronts)}</strong>
						<span>DOF storefronts · {pct(cityRate, 1)} empty</span>
					</div>
				</div>
			</div>

			<div class="clusters-note">
				<span class="kicker">Why Clusters Instead of Neighborhoods?</span>
				<p>
					Official city maps group storefronts by ZIP code or census neighborhood, which often blurs
					together bustling avenues and struggling stretches, or splits a single shopping corridor
					right down the middle.
				</p>
				<p>
					The {numFmt(meta.clusterCount)} clusters here take a cue from Supreme Court Justice Anthony
					Kennedy, who argued in redistricting opinions like
					<a
						href="https://tile.loc.gov/storage-services/service/ll/usrep/usrep541/usrep541267/usrep541267.pdf"
						target="_blank"
						rel="noopener noreferrer"><em>Vieth v. Jubelirer</em> (PDF) ↗</a
					>
					that modern data and simple geometric rules (keeping regions compact and contiguous) can
					reveal real communities on the ground rather than arbitrary lines. Neighboring blocks with
					similar vacancy rates are grouped from the street up into tight, street-aligned pockets so
					real patterns stand out cleanly.
				</p>
			</div>

			<div class="prose">
				<span class="kicker">How This Started</span>
				<p>
					This project started after reading Mark Levine’s
					<a
						href="https://x.com/marklevinenyc/status/2125612130007134597?s=46"
						target="_blank"
						rel="noopener noreferrer">post on NYC storefront vacancies ↗</a
					>
					and exploring the Comptroller’s official
					<a
						href="https://comptroller.nyc.gov/services/for-the-public/storefront-vacancy/dashboard/"
						target="_blank"
						rel="noopener noreferrer">Storefront Vacancy Dashboard ↗</a
					>. Because New York City makes so much of this data public, I wanted to see how much
					deeper we could dig street by street and building by building, which turned into a fun
					Thanksgiving Day project with Gemini Neon.
				</p>

				<p>
					I’ve appreciated Mark’s updates going back to his COVID-era posts, which were genuinely
					helpful at a time when good local information was hard to come by, and I’m glad he’s
					keeping storefront health in the public conversation.
				</p>

				<p>
					I’m Paul Wolpe (<a
						href="https://github.com/pwolpe/"
						target="_blank"
						rel="noopener noreferrer">GitHub ↗</a
					>), a New Yorker who cares a lot about seeing this city thrive and bring in new jobs. I’m
					also the co-founder and treasurer of the
					<strong>Wonderful West 15th Street Block Association</strong>, where you see up close
					every day how much a single empty storefront, or one great new neighbor, shapes the feel
					of a block.
				</p>

				<p>
					This project is open source under the MIT license. The full source code, data pipeline,
					and tests are public on
					<a
						href="https://github.com/pwolpe/nyc-storefront"
						target="_blank"
						rel="noopener noreferrer">github.com/pwolpe/nyc-storefront ↗</a
					>, so journalists, researchers, block associations, or other cities are welcome to use,
					inspect, and build on it.
				</p>
			</div>

			<div class="hood-section">
				<span class="kicker">What’s Under the Hood</span>
				<div class="hood-grid">
					<div class="hood-card">
						<strong>Block-level architecture</strong>
						<p>
							Every street elevation is raycast live from NYC MapPLUTO parcel polygons, showing true
							building widths, heights, corner wraps, and a playable 2019–2025 Time Machine.
						</p>
					</div>
					<div class="hood-card">
						<strong>Cleaned city filings</strong>
						<p>
							NYC’s DOF storefront dataset double-counts ~1,800 vacant filings/yr across Feb/June
							periods and shifted business-type codes in 2023. Both quirks are stripped out here.
						</p>
					</div>
					<div class="hood-card">
						<strong>Landlord X-Ray</strong>
						<p>
							Cross-references shell LLCs through NYC HPD registrations to surface the real managing
							entity and every other empty storefront in their portfolio.
						</p>
					</div>
					<div class="hood-card">
						<strong>Vision &amp; live web checks</strong>
						<p>
							Building dossiers cross-check city tax filings against Google Street View imagery and
							recent local retail news to catch buildouts, new leases, and reporting gaps.
						</p>
					</div>
				</div>
			</div>

			<div class="sources">
				<span class="kicker">Public Data Sources</span>
				<dl class="src-grid">
					<dt>Storefront Registry</dt>
					<dd>
						NYC Dept. of Finance (2019–2025 filings; deduplicated across Feb/June periods, with
						2023–2025 mis-mapped activity codes suppressed)
					</dd>

					<dt>Quarterly Trends</dt>
					<dd>NYC Comptroller Storefront Vacancy Census (2023 Q3 – 2026 Q3)</dd>

					<dt>Parcels &amp; Streets</dt>
					<dd>NYC Planning MapPLUTO &amp; CSCL Street Centerlines</dd>

					<dt>Ownership &amp; Tenants</dt>
					<dd>NYC HPD Registrations, DOHMH, DCWP, Open Restaurants, DOB Permits, OATH, and 311</dd>
				</dl>
			</div>

			<div class="foot-row">
				<a href="/" class="back-btn">← Back to NYC Map</a>
				<a
					href="https://github.com/pwolpe/nyc-storefront"
					target="_blank"
					rel="noopener noreferrer"
					class="gh-link"
				>
					github.com/pwolpe/nyc-storefront (MIT) ↗
				</a>
			</div>
		</article>
	</main>
</div>

<style>
	.page-shell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--page);
	}

	.about-wrap {
		flex: 1;
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
		padding: 36px 20px 64px;
	}

	.about-card {
		padding: 28px 32px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.about-hero {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.about-card h1 {
		font-size: 26px;
		letter-spacing: -0.028em;
		line-height: 1.15;
	}

	.lead {
		margin: 2px 0 0;
		font-size: 15px;
		line-height: 1.62;
		color: var(--ink);
		font-weight: 400;
	}

	.hero-stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		margin-top: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--rule);
	}

	.hs-cell {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.hs-cell strong {
		font-family: var(--font-mono);
		font-size: 16px;
		font-weight: 700;
		color: var(--ink);
		letter-spacing: -0.02em;
	}

	.hs-cell span {
		font-size: 11px;
		color: var(--muted);
	}

	.prose {
		padding-top: 16px;
		border-top: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.prose p {
		margin: 0;
		font-size: 14px;
		line-height: 1.65;
		color: var(--ink-soft);
	}

	.prose strong {
		color: var(--ink);
		font-weight: 600;
	}

	.prose a,
	.clusters-note a {
		color: var(--ink);
		text-decoration: underline;
		text-decoration-color: var(--line);
		text-underline-offset: 3px;
		transition: color 0.12s ease, text-decoration-color 0.12s ease;
	}

	.prose a:hover,
	.clusters-note a:hover {
		color: var(--accent);
		text-decoration-color: var(--accent);
	}

	.clusters-note,
	.hood-section,
	.sources {
		padding-top: 16px;
		border-top: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.clusters-note p {
		margin: 0;
		font-size: 14px;
		line-height: 1.65;
		color: var(--ink-soft);
	}

	.hood-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.hood-card {
		padding: 11px 13px;
		border-radius: var(--radius-sm);
		background: var(--page);
		border: 1px solid var(--rule);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.hood-card strong {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
	}

	.hood-card p {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.src-grid {
		display: grid;
		grid-template-columns: 175px 1fr;
		gap: 6px 14px;
		margin: 0;
		font-size: 12.5px;
	}

	.src-grid dt {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink);
		font-weight: 500;
	}

	.src-grid dd {
		margin: 0;
		color: var(--muted);
	}

	.foot-row {
		padding-top: 14px;
		border-top: 1px solid var(--rule);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.back-btn,
	.gh-link {
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-weight: 500;
		text-decoration: none;
		color: var(--muted);
	}

	.back-btn {
		color: var(--ink);
	}

	.back-btn:hover,
	.gh-link:hover {
		color: var(--accent);
	}

	@media (max-width: 640px) {
		.about-card {
			padding: 20px;
		}
		.hero-stats,
		.hood-grid,
		.src-grid {
			grid-template-columns: 1fr;
		}
		.src-grid {
			gap: 2px;
		}
		.src-grid dd {
			margin-bottom: 8px;
		}
	}
</style>
