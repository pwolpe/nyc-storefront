<script lang="ts">
	import type { PageData } from './$types';
	import type {
		BuildingDossier,
		BuildingDofYear,
		LandlordXrayResponse,
		StreetViewAuditResult
	} from '$lib/types';
	import { numFmt, pct, streetViewUrl } from '$lib/format';
	import {
		explainBldgClass,
		explainPermitType,
		explainSourceTag,
		explainZoning,
		formatMonthYear
	} from '$lib/nycGlossary';
	import {
		buildingCache,
		fieldNoteClientCache,
		visionAuditClientCache,
		warmBuilding,
		xrayClientCache
	} from '$lib/clientCache';
	import TopBar from '$lib/components/TopBar.svelte';
	import BuildingHeroVisual from '$lib/components/BuildingHeroVisual.svelte';
	import ShareButton from '$lib/components/ShareButton.svelte';

	let { data }: { data: PageData } = $props();

	const cluster = $derived(data.shard.cluster);
	const seg = $derived(data.segment);
	const bbl = $derived(data.bbl);
	const prevBuilding = $derived(data.prevBuilding);
	const nextBuilding = $derived(data.nextBuilding);
	const cityRate = $derived(data.clustersData.meta.citywideRate);

	let dossier = $state<BuildingDossier | null>(null);
	let loading = $state(true);
	let loadError = $state('');

	type EvidenceTab = 'tenants' | 'dof' | 'permits' | 'oath' | 'c311';
	let activeTab = $state<EvidenceTab>('tenants');
	let showAllRows = $state(false);
	let hoveredYear = $state<number | null>(null);
	let pinnedYear = $state<number | null>(null);

	interface AiBriefState {
		bbl: string;
		verdictTag?: string;
		summary: string;
		citations: Array<{ title: string; url: string }>;
		webGrounded: boolean;
	}

	let aiFieldNote = $state<AiBriefState | null>(null);
	let aiFieldLoading = $state(false);
	let aiConfigured = $state(true);

	// 🔍 Landlord X-Ray (unmasks shell LLCs via NYC HPD + finds other empty storefronts in portfolio)
	let xray = $state<LandlordXrayResponse | null>(null);
	let xrayOpen = $state(false);

	// 👁️ Street View Vision Audit (multimodal facade inspection + Reality Gap detection)
	let visionAudit = $state<StreetViewAuditResult | null>(null);
	let visionLoading = $state(false);

	$effect(() => {
		const d = dossier;
		if (!d) {
			xray = null;
			xrayOpen = false;
			return;
		}
		if (xray?.bbl === d.bbl) return;

		const cachedX = xrayClientCache.get(d.bbl);
		if (cachedX) {
			xray = cachedX;
			xrayOpen = false;
			return;
		}

		const controller = new AbortController();
		xray = null;
		xrayOpen = false;
		const params = new URLSearchParams({ bbl: d.bbl, owner: d.ownerName || '' });
		fetch(`/api/landlord-xray?${params.toString()}`, { signal: controller.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((res: LandlordXrayResponse | null) => {
				if (!controller.signal.aborted && res?.bbl === d.bbl) {
					xrayClientCache.set(d.bbl, res);
					xray = res;
				}
			})
			.catch(() => {});

		return () => controller.abort();
	});

	$effect(() => {
		const d = dossier;
		if (!d || !d.streetViewAvailable) {
			visionAudit = null;
			visionLoading = false;
			return;
		}
		const hasStorefrontSignal =
			d.dofHistory.length > 0 || d.tenants.length > 0 || (d.retailAreaSqft ?? 0) > 0;
		if (!hasStorefrontSignal) {
			visionAudit = null;
			visionLoading = false;
			return;
		}
		if (visionAudit?.bbl === d.bbl) return;

		const cachedV = visionAuditClientCache.get(d.bbl);
		if (cachedV) {
			visionAudit = cachedV;
			visionLoading = false;
			return;
		}

		const controller = new AbortController();
		visionAudit = null;
		visionLoading = true;

		const latest = d.dofHistory[0];
		const dofStatus = !latest
			? 'none'
			: latest.vacant > 0 && latest.occupied === 0
				? 'vacant'
				: latest.vacant > 0
					? 'mixed'
					: 'open';

		fetch('/api/ai/streetview-audit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				bbl: d.bbl,
				address: d.address,
				borough: d.borough,
				lat: d.lat,
				lng: d.lng,
				captureDate: d.streetViewDate,
				dofStatus,
				dofVacant: latest?.vacant ?? 0,
				dofTotal: latest?.total ?? 0,
				knownTenants: d.tenants.slice(0, 4).map((t) => t.name)
			}),
			signal: controller.signal
		})
			.then((r) => (r.ok ? r.json() : null))
			.then((res: StreetViewAuditResult | null) => {
				if (!controller.signal.aborted && res?.configured && res.summary) {
					visionAuditClientCache.set(d.bbl, res);
					visionAudit = res;
				}
			})
			.catch(() => {})
			.finally(() => {
				if (!controller.signal.aborted) visionLoading = false;
			});

		return () => controller.abort();
	});

	const hasInterestingXray = $derived(
		Boolean(
			xray &&
				(xray.totalBuildings >= 2 ||
					(xray.matchedVia !== 'NYC Owner Name' &&
						xray.entityName.toLowerCase() !== (dossier?.ownerName || '').toLowerCase()))
		)
	);

	function buildBriefPayload(d: BuildingDossier) {
		const oathMap = new Map<string, { respondent: string; count: number; latestDate: string; sample: string }>();
		for (const oc of d.oathCases.slice(0, 30)) {
			const k = (oc.respondent || '').trim().toLowerCase();
			if (!k) continue;
			const cur = oathMap.get(k);
			if (!cur) {
				oathMap.set(k, {
					respondent: oc.respondent,
					count: 1,
					latestDate: oc.date,
					sample: oc.description
				});
			} else {
				cur.count++;
				if (oc.date > cur.latestDate) cur.latestDate = oc.date;
			}
		}

		return {
			bbl: d.bbl,
			address: d.address,
			borough: d.borough,
			zipcode: d.zipcode,
			ownerName: d.ownerName,
			isCondo: d.isCondo,
			yearBuilt: d.yearBuilt,
			floors: d.floors,
			retailAreaSqft: d.retailAreaSqft,
			landUseLabel: d.landUseLabel,
			consecutiveVacantYears: d.consecutiveVacantYears,
			blockContext: blockShareNote?.text || '',
			streetName: seg.streetName,
			between: seg.between,
			dofYears: d.dofHistory.slice(0, 7).map((y) => ({
				year: y.year,
				vacant: y.vacant,
				total: y.total,
				activities: [...new Set(y.units.map((u) => u.activity).filter((a) => a && a !== 'Commercial'))].slice(0, 3),
				leaseExpiries: [...new Set(y.units.map((u) => u.leaseExpiry).filter(Boolean) as string[])].slice(0, 2),
				construction: y.units.some((u) => u.construction)
			})),
			tenants: d.tenants.slice(0, 6).map((t) => ({
				name: t.name,
				category: t.category,
				source: t.source,
				status: t.status,
				firstDate: t.firstDate,
				lastDate: t.lastDate
			})),
			permits: d.permits.slice(0, 4).map((p) => ({
				date: p.date,
				jobType: p.jobType,
				workType: p.workType,
				description: p.description
			})),
			oathTop: [...oathMap.values()].sort((a, b) => b.count - a.count).slice(0, 3),
			c311Recent: d.complaints311.slice(0, 3).map((c) => ({
				date: c.date,
				type: c.type,
				descriptor: c.descriptor
			}))
		};
	}

	// Auto-run unified web-grounded Field Note on commercial storefront buildings (skip pure residential/civic lots)
	$effect(() => {
		const d = dossier;
		if (!d) {
			aiFieldNote = null;
			aiFieldLoading = false;
			return;
		}
		if (aiFieldNote?.bbl === d.bbl) return;

		const hasStorefrontSignal =
			d.dofHistory.length > 0 || d.tenants.length > 0 || (d.retailAreaSqft ?? 0) > 0;
		if (!hasStorefrontSignal) {
			aiFieldNote = null;
			aiFieldLoading = false;
			return;
		}

		const cachedFn = fieldNoteClientCache.get(d.bbl);
		if (cachedFn) {
			aiFieldNote = cachedFn;
			aiFieldLoading = false;
			return;
		}

		const controller = new AbortController();
		aiFieldNote = null;
		aiFieldLoading = true;

		fetch('/api/ai/building-brief', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(buildBriefPayload(d)),
			signal: controller.signal
		})
			.then((r) => (r.ok ? r.json() : null))
			.then(
				(
					res: {
						configured?: boolean;
						verdictTag?: string;
						summary?: string;
						citations?: Array<{ title: string; url: string }>;
						webGrounded?: boolean;
					} | null
				) => {
					if (controller.signal.aborted) return;
					if (res && res.configured === false) {
						aiConfigured = false;
						return;
					}
					if (res?.summary) {
						const note = {
							bbl: d.bbl,
							verdictTag: res.verdictTag,
							summary: res.summary,
							citations: res.citations || [],
							webGrounded: Boolean(res.webGrounded)
						};
						fieldNoteClientCache.set(d.bbl, note);
						aiFieldNote = note;
					}
				}
			)
			.catch(() => {})
			.finally(() => {
				if (!controller.signal.aborted) aiFieldLoading = false;
			});

		return () => controller.abort();
	});

	function googleMapsPlaceUrl(businessName: string): string {
		const loc = dossier
			? `${businessName}, ${dossier.address}, ${dossier.borough}, NY`
			: `${businessName}, New York, NY`;
		return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc)}`;
	}

	function prefetchDoor(targetBbl: string | undefined) {
		if (targetBbl) warmBuilding(targetBbl);
	}

	// Quietly pre-warm the two adjacent sidewalk doors so ← Prev / Next → clicks open at 0ms!
	$effect(() => {
		const p = prevBuilding?.bbl;
		const n = nextBuilding?.bbl;
		const timer = setTimeout(() => {
			if (p) warmBuilding(p);
			if (n) warmBuilding(n);
		}, 600);
		return () => clearTimeout(timer);
	});

	$effect(() => {
		const targetBbl = bbl;
		const controller = new AbortController();
		loadError = '';
		showAllRows = false;
		hoveredYear = null;
		pinnedYear = null;

		const applyDossier = (json: BuildingDossier) => {
			dossier = json;
			if (json.tenants.length > 0) activeTab = 'tenants';
			else if (json.dofHistory.length > 0) activeTab = 'dof';
			else if (json.oathCases.length > 0) activeTab = 'oath';
			else if (json.permits.length > 0) activeTab = 'permits';
			else activeTab = 'c311';
		};

		const cached = buildingCache.get(targetBbl);
		if (cached) {
			applyDossier(cached);
			loading = false;
			return;
		}

		loading = true;
		buildingCache
			.getOrFetch(targetBbl, async () => {
				const r = await fetch(`/api/building?bbl=${encodeURIComponent(targetBbl)}`, {
					signal: controller.signal
				});
				if (!r.ok) throw new Error('Unable to load building dossier');
				return (await r.json()) as BuildingDossier;
			})
			.then((json) => {
				if (json && json.bbl === targetBbl && !controller.signal.aborted) {
					applyDossier(json);
				} else if (!json && !controller.signal.aborted) {
					loadError = 'Unable to load building dossier';
				}
			})
			.catch((e) => {
				if (!controller.signal.aborted) loadError = e?.message || 'Load failed';
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});

		return () => controller.abort();
	});

	function moneyFmt(v: number | null): string {
		if (!v) return '—';
		if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
		return `$${Math.round(v).toLocaleString('en-US')}`;
	}

	const displayTitle = $derived(dossier?.address || `BBL ${bbl}`);
	const cityRecordUrl = $derived(
		`https://a856-cityrecord.nyc.gov/Search?Keyword=${encodeURIComponent(dossier?.address || bbl)}`
	);
	const nycBisUrl = $derived(
		`https://a810-bisweb.nyc.gov/bisweb/PropertyBrowseByBBLServlet?allborough=${bbl[0]}&allblock=${parseInt(bbl.slice(1, 6), 10)}&alllot=${parseInt(bbl.slice(6, 10), 10)}`
	);

	// Current storefront status summary
	const currentStatus = $derived.by(() => {
		if (!dossier) return null;
		const latest = dossier.dofHistory[0];
		if (!latest) return { tone: 'neutral', label: dossier.landUseLabel };
		if (latest.vacant > 0 && latest.occupied === 0) {
			return {
				tone: 'vacant',
				label:
					dossier.consecutiveVacantYears >= 2
						? `Vacant ${dossier.consecutiveVacantYears} yrs`
						: `Vacant (${latest.vacant}/${latest.total})`
			};
		}
		if (latest.vacant > 0) {
			return { tone: 'mixed', label: `${latest.vacant}/${latest.total} Vacant` };
		}
		return { tone: 'open', label: `${latest.occupied} Open` };
	});

	// Detect recurring OATH respondent (e.g., "POP-UP VINTAGE CLOTHING" cited 5 times outside The Ginger Man!)
	const notableEnforcement = $derived.by(() => {
		if (!dossier || dossier.oathCases.length === 0) return null;
		const counts = new Map<string, { raw: string; count: number; latestDate: string }>();
		for (const oc of dossier.oathCases) {
			const clean = (oc.respondent || '').trim();
			if (!clean || clean.length < 4) continue;
			const key = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
			if (!key) continue;
			const prev = counts.get(key);
			if (!prev) counts.set(key, { raw: clean, count: 1, latestDate: oc.date });
			else {
				prev.count++;
				if (oc.date > prev.latestDate) prev.latestDate = oc.date;
			}
		}
		const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
		if (!top || top.count < 2) return null;
		const pretty = top.raw
			.toLowerCase()
			.replace(/(^|[\s\-/&])([a-z])/g, (_, sep, ch) => `${sep}${ch.toUpperCase()}`);
		return { name: pretty, count: top.count, latestDate: top.latestDate };
	});

	// Plain-English auto-synthesized "What's Happening Here" summary
	const storyLines = $derived.by(() => {
		if (!dossier) return [];
		const lines: string[] = [];

		// 1. Physical & vacancy headline
		const descParts = [
			dossier.floors ? `${dossier.floors}-story` : null,
			dossier.landUseLabel.toLowerCase(),
			dossier.yearBuilt ? `built in ${dossier.yearBuilt}` : null
		].filter(Boolean);
		const retailPart = dossier.retailAreaSqft ? ` with ${numFmt(dossier.retailAreaSqft)} sq ft of retail` : '';

		const latest = dossier.dofHistory[0];
		if (dossier.consecutiveVacantYears >= 2 && latest) {
			const sinceYr = dossier.dofHistory[dossier.consecutiveVacantYears - 1]?.year;
			lines.push(
				`Reported vacant in ${dossier.consecutiveVacantYears} consecutive NYC DOF filings${sinceYr ? ` (since ${sinceYr})` : ''} — ${descParts.join(' ')}${retailPart}.`
			);
		} else if (latest && latest.vacant > 0) {
			lines.push(
				`${latest.vacant} of ${latest.total} ground-floor ${latest.total === 1 ? 'unit' : 'units'} reported empty in ${latest.year} — ${descParts.join(' ')}${retailPart}.`
			);
		} else if (latest && latest.occupied > 0) {
			lines.push(
				`All ${latest.occupied} registered commercial ${latest.occupied === 1 ? 'unit' : 'units'} reported occupied in ${latest.year} — ${descParts.join(' ')}${retailPart}.`
			);
		} else {
			lines.push(`${descParts.join(' ').replace(/^[a-z]/, (c) => c.toUpperCase())}${retailPart}.`);
		}

		// 2. Lease expiry & construction / renovation clues ("Why is this empty or active?")
		const allUnitsChrono = dossier.dofHistory; // sorted newest first
		const latestVacantLease = allUnitsChrono
			.flatMap((y) => y.units.filter((u) => u.vacant && u.leaseExpiry).map((u) => u.leaseExpiry!))
			.sort((a, b) => b.localeCompare(a))[0];
		const latestActiveLease = allUnitsChrono
			.flatMap((y) => y.units.filter((u) => !u.vacant && u.leaseExpiry).map((u) => u.leaseExpiry!))
			.sort((a, b) => b.localeCompare(a))[0];
		const hasLatestConstruction = Boolean(latest?.units.some((u) => u.construction));

		const recentPermit = dossier.permits[0];
		const recentPermitYr = recentPermit?.date
			? parseInt(
					recentPermit.date.slice(-4).match(/^\d{4}$/)
						? recentPermit.date.slice(-4)
						: recentPermit.date.slice(0, 4),
					10
				) || 0
			: 0;

		if (latest && latest.vacant > 0) {
			const clueParts: string[] = [];
			if (latestVacantLease) {
				clueParts.push(`Last lease ended ${formatMonthYear(latestVacantLease)}`);
			}
			if (hasLatestConstruction || recentPermitYr >= 2024) {
				const pLabel = recentPermit
					? explainPermitType(recentPermit.jobType, recentPermit.workType).toLowerCase()
					: 'renovation';
				clueParts.push(
					recentPermitYr >= 2024
						? `${recentPermitYr} ${pLabel} permit on file — possible active build-out`
						: 'construction reported on storefront filing'
				);
			} else if (dossier.consecutiveVacantYears >= 2) {
				clueParts.push('no recent renovation permits on file');
			}
			if (clueParts.length > 0) {
				const joined = clueParts.join('; ');
				lines.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
			}
		} else if (latest && latest.occupied > 0 && latestActiveLease && latestActiveLease >= '2026-01-01') {
			lines.push(`Reported commercial lease runs through ${formatMonthYear(latestActiveLease)}.`);
		}

		// 3. Named tenant / prior activity + enforcement clues
		const priorOccupied = dossier.dofHistory.find((y) => y.occupied > 0);
		const priorAct = priorOccupied?.units.find((u) => !u.vacant && u.activity !== 'Commercial')?.activity;
		if (dossier.tenants.length > 0) {
			const names = dossier.tenants.slice(0, 2).map((t) => `${t.name} (${t.category})`);
			const verb =
				latest && latest.vacant > 0 && latest.occupied === 0
					? 'Most recently listed in city records under'
					: 'Registered city businesses include';
			lines.push(`${verb} ${names.join(' and ')}.`);
		} else if (latest && latest.vacant > 0 && priorAct) {
			lines.push(`Prior to going dark, city filings listed ${priorAct} here (${priorOccupied?.year}).`);
		}

		if (notableEnforcement) {
			lines.push(
				`City tickets cite "${notableEnforcement.name}" ${notableEnforcement.count} times through ${formatMonthYear(notableEnforcement.latestDate)}.`
			);
		} else if (recentPermit?.date && !(latest && latest.vacant > 0 && recentPermitYr >= 2024)) {
			lines.push(
				`Latest building permit was issued in ${recentPermitYr || recentPermit.date} (${explainPermitType(recentPermit.jobType, recentPermit.workType)}).`
			);
		}

		return lines;
	});

	// 1-line "Share of the Block" plain-English context callout
	const blockShareNote = $derived.by(() => {
		if (!dossier || seg.total === 0) return null;
		const latest = dossier.dofHistory[0];
		if (!latest || latest.total === 0) return null;
		const blkPct = pct(seg.rate, 0);

		if (latest.vacant > 0 && seg.vacant > 0) {
			const cappedVac = Math.min(latest.vacant, seg.vacant);
			if (cappedVac === seg.vacant && seg.vacant === 1) {
				return {
					tone: 'worse' as const,
					text: `This is the only empty storefront on this block of ${seg.streetName} (1 of ${seg.total}).`
				};
			}
			if (cappedVac === seg.vacant) {
				return {
					tone: 'worse' as const,
					text: `Accounts for all ${seg.vacant} empty storefronts on this block of ${seg.streetName}.`
				};
			}
			return {
				tone: 'mixed' as const,
				text: `Accounts for ${cappedVac} of the ${seg.vacant} empty storefronts on this block (${blkPct} of ${seg.streetName} is vacant).`
			};
		}

		if (latest.vacant === 0 && seg.vacant > 0) {
			return {
				tone: 'better' as const,
				text: `Fully leased here, while ${seg.vacant} of ${seg.total} storefronts (${blkPct}) on this block of ${seg.streetName} are empty.`
			};
		}

		return {
			tone: 'better' as const,
			text: `Fully leased on a fully leased block (0 of ${seg.total} empty on ${seg.streetName}).`
		};
	});

	const zoningPlain = $derived(explainZoning(dossier?.zoning));
	const bldgClassPlain = $derived(explainBldgClass(dossier?.bldgClass));

	// Visual 2019–2025 horizontal occupancy timeline + crisp trajectory verdict
	const timelineYears = $derived.by(() => {
		const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
		const map = new Map<number, BuildingDofYear>();
		for (const y of dossier?.dofHistory ?? []) map.set(y.year, y);

		return years.map((yr) => {
			const rec = map.get(yr) ?? null;
			let state: 'open' | 'mixed' | 'vacant' | 'dropped' | 'none' = 'none';
			let sub = 'No filing';
			let ratio = '—';
			if (rec) {
				ratio = `${rec.vacant}/${rec.total}`;
				if (rec.vacant > 0 && rec.occupied === 0) {
					state = 'vacant';
					sub = 'All empty';
				} else if (rec.vacant > 0) {
					state = 'mixed';
					const act = rec.units.find((u) => !u.vacant && u.activity && u.activity !== 'Commercial')?.activity;
					sub = act || `${rec.occupied} open`;
				} else {
					state = 'open';
					const act = rec.units.find((u) => u.activity && u.activity !== 'Commercial')?.activity;
					sub = act || `${rec.occupied} open`;
				}
			} else if (dossier?.droppedSignal && yr === dossier.droppedSignal.latestYear && dossier.droppedSignal.latestCount === 0) {
				state = 'dropped';
				sub = 'Dropped';
				ratio = '0';
			}
			return { year: yr, rec, state, sub, ratio };
		});
	});

	const maxTimelineUnits = $derived(
		Math.max(1, ...timelineYears.map((t) => t.rec?.total ?? 0))
	);

	// Active year for the interactive strip underneath the 2019–2025 bar chart
	const inspectedYearCell = $derived.by(() => {
		const targetYr = hoveredYear ?? pinnedYear ?? dossier?.dofHistory[0]?.year ?? 2025;
		return timelineYears.find((c) => c.year === targetYr) ?? timelineYears[timelineYears.length - 1];
	});

	const buildingTrajectory = $derived.by(() => {
		if (!dossier || dossier.dofHistory.length < 2) {
			return null;
		}
		const chrono = [...dossier.dofHistory].sort((a, b) => a.year - b.year);
		const first = chrono[0];
		const prev = chrono[chrono.length - 2];
		const latest = chrono[chrono.length - 1];
		const latestRate = latest.vacant / Math.max(1, latest.total);
		const prevRate = prev.vacant / Math.max(1, prev.total);
		const firstRate = first.vacant / Math.max(1, first.total);

		const recentPrior = chrono.filter((y) => y.year < latest.year && y.year >= latest.year - 3);
		let recentPeak: BuildingDofYear | null = null;
		for (const y of recentPrior) {
			if (!recentPeak || y.vacant > recentPeak.vacant) recentPeak = y;
		}

		// 1. Improved year-over-year
		if (latest.vacant < prev.vacant || latestRate < prevRate - 0.05) {
			return {
				tone: 'better' as const,
				badge: '↓ Improving',
				detail:
					latest.vacant === 0
						? `Recovered from ${prev.vacant}/${prev.total} empty (${prev.year}) to all ${latest.total} open (${latest.year})`
						: `Fell from ${prev.vacant}/${prev.total} empty (${prev.year}) to ${latest.vacant}/${latest.total} (${latest.year})`
			};
		}

		// 2. Worsened year-over-year
		if (latest.vacant > prev.vacant || latestRate > prevRate + 0.05) {
			return {
				tone: 'worse' as const,
				badge: '↑ Worsening',
				detail: `Rose from ${prev.vacant}/${prev.total} empty (${prev.year}) to ${latest.vacant}/${latest.total} (${latest.year})`
			};
		}

		// 3. Recently recovered and holding full (e.g. 2/3 empty in 2023 -> 0/3 in 2024 & 2025)
		if (latest.vacant === 0 && recentPeak && recentPeak.vacant > 0) {
			let fullSince = latest.year;
			for (let i = chrono.length - 1; i >= 0; i--) {
				if (chrono[i].vacant === 0) fullSince = chrono[i].year;
				else break;
			}
			return {
				tone: 'better' as const,
				badge: '↓ Improved',
				detail: `Recovered from ${recentPeak.vacant}/${recentPeak.total} empty (${recentPeak.year}) — all ${latest.total} open since ${fullSince}`
			};
		}

		// 4. Persistently worse than starting baseline
		if (latest.vacant > 0 && latestRate > firstRate + 0.05) {
			return {
				tone: 'worse' as const,
				badge: '↑ Worsened',
				detail: `Up from ${first.vacant}/${first.total} empty (${first.year}) to ${latest.vacant}/${latest.total} (${latest.year})`
			};
		}

		// 5. No change (stuck vacant vs consistently open)
		if (latest.vacant > 0) {
			return {
				tone: 'chronic' as const,
				badge: '→ No change',
				detail: `Unchanged at ${latest.vacant}/${latest.total} empty (${dossier.consecutiveVacantYears >= 2 ? `${dossier.consecutiveVacantYears} yrs running` : `since ${prev.year}`})`
			};
		}

		return {
			tone: 'steady' as const,
			badge: '→ No change',
			detail: `Consistently open (${first.year}–${latest.year})`
		};
	});

	// Key milestones for the timeline ribbon (tenants, latest permit, dropped signal, recurring OATH)
	const milestones = $derived.by(() => {
		if (!dossier) return [];
		const list: Array<{
			tag: string;
			label: string;
			meta: string;
			tone: 'ink' | 'red' | 'green' | 'amber';
			href?: string;
		}> = [];

		for (const t of dossier.tenants.slice(0, 3)) {
			const span =
				t.firstDate && t.lastDate && t.firstDate.slice(0, 4) !== t.lastDate.slice(0, 4)
					? `${t.firstDate.slice(0, 4)}–${t.lastDate.slice(0, 4)}`
					: t.lastDate
						? t.lastDate.slice(0, 7)
						: t.source;
			list.push({
				tag: explainSourceTag(t.source),
				label: t.name,
				meta: `${t.category} · ${span}`,
				tone: t.status === 'former' ? 'amber' : 'ink',
				href: googleMapsPlaceUrl(t.name)
			});
		}

		if (notableEnforcement) {
			list.push({
				tag: 'City Ticket',
				label: notableEnforcement.name,
				meta: `${notableEnforcement.count} notices · ${formatMonthYear(notableEnforcement.latestDate)}`,
				tone: 'red'
			});
		}

		if (dossier.permits[0]) {
			const p = dossier.permits[0];
			list.push({
				tag: 'Permit',
				label: explainPermitType(p.jobType, p.workType),
				meta: `${p.date ? formatMonthYear(p.date) : 'Issued'} · ${p.status}`,
				tone: 'green'
			});
		}

		return list;
	});
</script>

<svelte:head>
	<title>{displayTitle} — NYC Storefront Vacancy</title>
	<meta property="og:title" content="{displayTitle} ({seg.streetName}) — NYC Storefront Vacancy" />
	<meta
		property="og:description"
		content="Storefront history (2019–2025), Landlord X-Ray, Street View Vision Audit, and live retail field note for {displayTitle} in {cluster.borough}."
	/>
	<meta name="twitter:title" content="{displayTitle} — NYC Storefront Vacancy" />
	<meta
		name="twitter:description"
		content="Storefront history, Landlord X-Ray, and Street View audit for {displayTitle} on nycstorefront.com."
	/>
</svelte:head>

<div class="page-shell">
	<TopBar
		{cityRate}
		clustersData={data.clustersData}
		cluster={{ id: cluster.id, name: cluster.name, rate: cluster.vacancy_rate }}
		block={{
			id: seg.id,
			label: `${seg.streetName} (${seg.between})`,
			rate: seg.rate
		}}
		building={{ bbl, label: displayTitle }}
	/>

	<main class="container bldg-body">
		{#if loadError}
			<div class="alert-card surface">
				<strong>Could not load live building records:</strong> {loadError}
			</div>
		{:else if loading && !dossier}
			<div class="loading-hero">
				<div class="skel hero-l surface"></div>
				<div class="skel hero-r surface"></div>
			</div>
			<div class="skel strip surface"></div>
		{:else if dossier}
			<!-- Top Nav Strip: Back to Block + Door-to-Door Sidewalk Stepper -->
			<nav class="bldg-nav-bar" aria-label="Block and adjacent buildings">
				<a href="/cluster/{cluster.id}/block/{seg.id}" class="back-link">
					← {seg.streetName} ({seg.between})
				</a>
				<div class="nav-right-group">
					{#if prevBuilding || nextBuilding}
						<div class="door-stepper">
							{#if prevBuilding}
								<a
									href="/cluster/{cluster.id}/block/{seg.id}/building/{prevBuilding.bbl}"
									class="door-link"
									title="Walk next door to {prevBuilding.label}"
									onmouseenter={() => prefetchDoor(prevBuilding.bbl)}
								>
									<span class="dl-arr">←</span>
									<i class="dl-dot kind-{prevBuilding.kind}"></i>
									<span>{prevBuilding.label}</span>
								</a>
							{/if}
							{#if prevBuilding && nextBuilding}
								<span class="dl-sep" aria-hidden="true">|</span>
							{/if}
							{#if nextBuilding}
								<a
									href="/cluster/{cluster.id}/block/{seg.id}/building/{nextBuilding.bbl}"
									class="door-link"
									title="Walk next door to {nextBuilding.label}"
									onmouseenter={() => prefetchDoor(nextBuilding.bbl)}
								>
									<span>{nextBuilding.label}</span>
									<i class="dl-dot kind-{nextBuilding.kind}"></i>
									<span class="dl-arr">→</span>
								</a>
							{/if}
						</div>
					{/if}
					<ShareButton
						compact
						summary="{displayTitle} ({dossier.borough}): {currentStatus?.label || dossier.landUseLabel}"
					/>
				</div>
			</nav>

			<!-- 1. Editorial 2-Column Hero: Building Story + Live Street View / Parcel / Aerial Visual -->
			<section class="hero-split">
				<div class="hero-copy">
					<div class="title-row">
						<h1>{displayTitle}</h1>
						{#if currentStatus}
							<span class="status-pill tone-{currentStatus.tone}">{currentStatus.label}</span>
						{/if}
						{#if buildingTrajectory}
							<span class="traj-pill tone-{buildingTrajectory.tone}" title={buildingTrajectory.detail}>
								{buildingTrajectory.badge}
							</span>
						{/if}
					</div>

					<div class="sub-meta">
						<span>{dossier.borough}{dossier.zipcode ? ` ${dossier.zipcode}` : ''}</span>
						<span class="sep">·</span>
						<span>Owner: <strong>{dossier.ownerName}</strong></span>
						{#if hasInterestingXray && xray}
							<button
								type="button"
								class="xray-pill"
								class:open={xrayOpen}
								class:has-vac={xray.vacantStorefronts >= 2}
								onclick={() => (xrayOpen = !xrayOpen)}
								title="Unmask LLC & inspect other NYC storefronts controlled by {xray.entityName}"
							>
								<span>
									Portfolio: {xray.totalBuildings} NYC {xray.totalBuildings === 1 ? 'bldg' : 'bldgs'}
									{#if xray.totalStorefronts > 0}
										· {xray.vacantStorefronts}/{xray.totalStorefronts} empty
									{/if}
								</span>
								<span class="xr-caret">{xrayOpen ? '▴' : '▾'}</span>
							</button>
						{/if}
						<span class="sep">·</span>
						<span class="mono" title="NYC Borough-Block-Lot tax parcel ID">Tax Lot {dossier.bbl}</span>
					</div>

					{#if xrayOpen && xray}
						<div class="xray-drawer" role="region" aria-label="Landlord portfolio X-Ray">
							<div class="xr-head">
								<div class="xr-entity">
									<span class="xr-kicker">LANDLORD X-RAY · {xray.matchedVia.toUpperCase()}</span>
									<strong>{xray.entityName}</strong>
									{#if xray.businessAddress}
										<span class="xr-addr">Registered office: {xray.businessAddress}</span>
									{/if}
								</div>
								{#if xray.totalStorefronts > 0}
									<div class="xr-stat">
										<b class:hot={xray.vacantStorefronts / xray.totalStorefronts >= 0.16}>
											{pct(xray.vacantStorefronts / xray.totalStorefronts, 0)}
										</b>
										<span>{xray.vacantStorefronts}/{xray.totalStorefronts} storefronts empty</span>
									</div>
								{/if}
							</div>

							{#if xray.buildings.length > 0}
								<div class="xr-list">
									{#each xray.buildings as b}
										{#if b.href}
											<a href={b.href} class="xr-row">
												<div class="xr-b-info">
													<strong>{b.address}</strong>
													<span>{b.borough}</span>
												</div>
												<div class="xr-b-stat">
													<span class="xr-badge" class:vac={b.vacant > 0}>
														{b.vacant > 0 ? `${b.vacant}/${b.total} empty` : `${b.total} open`}
													</span>
													{#if b.vacantYears >= 2}
														<span class="xr-yr">{b.vacantYears}y</span>
													{/if}
													<span class="xr-go">→</span>
												</div>
											</a>
										{:else}
											<div class="xr-row current">
												<div class="xr-b-info">
													<strong>{b.address}{b.isCurrent ? ' (this building)' : ''}</strong>
													<span>{b.borough}</span>
												</div>
												<div class="xr-b-stat">
													<span class="xr-badge" class:vac={b.vacant > 0}>
														{b.vacant > 0 ? `${b.vacant}/${b.total} empty` : `${b.total} open`}
													</span>
												</div>
											</div>
										{/if}
									{/each}
								</div>
							{:else}
								<p class="xr-empty">
									Linked across {xray.totalBuildings} NYC HPD buildings; no other ground-floor commercial storefronts filed in DOF.
								</p>
							{/if}
						</div>
					{/if}

					<!-- Auto-synthesized Building Story + Unified Web-Grounded AI Field Note -->
					<div class="story-box" class:ai-upgraded={Boolean(aiFieldNote)} class:ai-loading={aiFieldLoading && aiConfigured && !aiFieldNote}>
						{#if aiFieldNote}
							<div class="fn-head">
								<span class="fn-kicker">
									✦ Field Note{aiFieldNote.webGrounded ? ' · NYC Records + Live Web' : ''}
								</span>
								{#if aiFieldNote.verdictTag}
									<span class="fn-verdict">{aiFieldNote.verdictTag}</span>
								{/if}
							</div>
							<p class="fn-summary">{aiFieldNote.summary}</p>
							{#if aiFieldNote.citations.length > 0}
								<div class="web-cites">
									{#each aiFieldNote.citations as c}
										<a
											href={c.url}
											target="_blank"
											rel="noopener noreferrer"
											class="cite-pill"
											title={c.url}
										>
											{c.title} ↗
										</a>
									{/each}
								</div>
							{/if}
						{:else if aiFieldLoading && aiConfigured}
							<div class="fn-head">
								<span class="fn-kicker thinking">
									<span class="wb-spark pulse" aria-hidden="true">✦</span>
									Investigating NYC records &amp; live web…
								</span>
							</div>
							<div class="fn-shimmer" aria-hidden="true">
								<span class="sh-line w1"></span>
								<span class="sh-line w2"></span>
								<span class="sh-line w3"></span>
							</div>
						{:else}
							{#each storyLines as line}
								<p>{line}</p>
							{/each}
						{/if}
					</div>

					<!-- 1-Line Share of the Block Context Callout -->
					{#if blockShareNote}
						<div class="block-context tone-{blockShareNote.tone}">
							<span class="bc-dot"></span>
							<span>{blockShareNote.text}</span>
						</div>
					{/if}

					<!-- Automated Discrepancy Alert (when storefront units vanished between filings) -->
					{#if dossier.droppedSignal}
						<div class="dropped-alert">
							<span class="da-tag">UNREPORTED UNIT</span>
							<span>
								Dropped from {dossier.droppedSignal.priorCount} unit{dossier.droppedSignal.priorCount === 1 ? '' : 's'} ({dossier.droppedSignal.priorYear})
								to {dossier.droppedSignal.latestCount} ({dossier.droppedSignal.latestYear}) — missing: {dossier.droppedSignal.priorAddresses.join(', ')}.
							</span>
						</div>
					{/if}

					<!-- Compact 6-Metric Property Grid (Plain English + official code on hover/subtitle) -->
					<div class="mini-specs">
						<div class="ms-cell">
							<span class="ms-k">Built / Height</span>
							<b>{dossier.yearBuilt || '—'} · {dossier.floors ? `${dossier.floors} floors` : '—'}</b>
						</div>
						<div class="ms-cell">
							<span class="ms-k">Retail Space</span>
							<b>{dossier.retailAreaSqft ? `${numFmt(dossier.retailAreaSqft)} sq ft` : 'Not listed'}</b>
						</div>
						<div class="ms-cell">
							<span class="ms-k">Lot Width</span>
							<b>{dossier.lotFrontFt ? `${dossier.lotFrontFt} × ${dossier.lotDepthFt || '?'} ft` : '—'}</b>
						</div>
						<div
							class="ms-cell"
							title="NYC Dept. of Finance tax assessment (typically ~45% of market value for commercial/mixed-use buildings)"
						>
							<span class="ms-k">Tax Assessed</span>
							<b>{moneyFmt(dossier.assessedTotal)}</b>
						</div>
						<div class="ms-cell">
							<span class="ms-k">Building Units</span>
							<b>{dossier.unitsRes} apt · {Math.max(0, dossier.unitsTotal - dossier.unitsRes)} comm</b>
						</div>
						<div class="ms-cell" title="NYC Zoning: {dossier.zoning || '—'} · Building Class: {dossier.bldgClass || '—'}">
							<span class="ms-k">Zoning &amp; Type</span>
							<b class="ms-plain">{bldgClassPlain || zoningPlain}</b>
							{#if dossier.zoning || dossier.bldgClass}
								<span class="ms-sub">{zoningPlain} ({[dossier.zoning, dossier.bldgClass].filter(Boolean).join(' · ')})</span>
							{/if}
						</div>
					</div>

					<div class="ext-links">
						{#if dossier.lat && dossier.lng}
							<a href={streetViewUrl(dossier.lat, dossier.lng)} target="_blank" rel="noopener noreferrer">
								Interactive Street View ↗
							</a>
						{/if}
						<a href={cityRecordUrl} target="_blank" rel="noopener noreferrer">City Record ↗</a>
						<a href={nycBisUrl} target="_blank" rel="noopener noreferrer">NYC DOB Profile ↗</a>
					</div>
				</div>

				<div class="hero-media">
					<BuildingHeroVisual {dossier} {visionAudit} {visionLoading} />
				</div>
			</section>

			<!-- 2. Visual 2019–2025 Storefront Occupancy & Trajectory Chart -->
			<section class="timeline-card surface">
				<div class="tl-head">
					<div class="tl-title-wrap">
						<span class="kicker">Storefront Occupancy · 2019–2025</span>
						{#if buildingTrajectory}
							<div class="tl-verdict tone-{buildingTrajectory.tone}">
								<strong>{buildingTrajectory.badge}</strong>
								<span>{buildingTrajectory.detail}</span>
							</div>
						{/if}
					</div>
					<span class="tl-legend">
						<span><i class="sw open"></i>Open unit</span>
						<span><i class="sw vacant"></i>Vacant unit</span>
						<span><i class="sw none"></i>Unfiled</span>
					</span>
				</div>

				<div
					class="occ-chart"
					role="group"
					aria-label="Interactive yearly storefront occupancy chart from 2019 to 2025"
					onmouseleave={() => (hoveredYear = null)}
				>
					{#each timelineYears as cell (cell.year)}
						{@const rec = cell.rec}
						{@const useBlocks = maxTimelineUnits <= 6}
						{@const isActiveYr = inspectedYearCell?.year === cell.year}
						<button
							type="button"
							class="occ-col state-{cell.state}"
							class:active={isActiveYr}
							onmouseenter={() => (hoveredYear = cell.year)}
							onfocus={() => (hoveredYear = cell.year)}
							onclick={() => (pinnedYear = pinnedYear === cell.year ? null : cell.year)}
						>
							<span class="occ-ratio">
								{#if rec}
									{rec.vacant === 0 ? `${rec.occupied}/${rec.total} open` : `${rec.vacant}/${rec.total} empty`}
								{:else if cell.state === 'dropped'}
									Dropped
								{:else}
									—
								{/if}
							</span>

							<div class="occ-stage">
								{#if rec && rec.total > 0}
									{#if useBlocks}
										<div class="unit-stack">
											{#each Array(rec.vacant) as _}
												<span
													class="u-blk vac"
													style="height: {Math.max(8, Math.floor((62 - (maxTimelineUnits - 1) * 3) / maxTimelineUnits))}px"
												></span>
											{/each}
											{#each Array(rec.occupied) as _}
												<span
													class="u-blk occ"
													style="height: {Math.max(8, Math.floor((62 - (maxTimelineUnits - 1) * 3) / maxTimelineUnits))}px"
												></span>
											{/each}
										</div>
									{:else}
										{@const barH = Math.max(14, Math.round((rec.total / maxTimelineUnits) * 62))}
										{@const vacH = Math.round((rec.vacant / rec.total) * barH)}
										{@const occH = barH - vacH}
										<div class="prop-bar" style="height: {barH}px">
											{#if vacH > 0}<span class="pb-vac" style="height: {vacH}px"></span>{/if}
											{#if occH > 0}<span class="pb-occ" style="height: {occH}px"></span>{/if}
										</div>
									{/if}
								{:else}
									<div class="u-empty" class:dropped={cell.state === 'dropped'}></div>
								{/if}
							</div>

							<div class="occ-foot">
								<span class="occ-yr">{cell.year}</span>
								<span class="occ-sub" title={cell.sub}>{cell.sub}</span>
							</div>
						</button>
					{/each}
				</div>

				<!-- Interactive Year Inspector Strip (updates on hover or click of any year column) -->
				{#if inspectedYearCell}
					<div class="year-inspector" aria-live="polite">
						<span class="yi-yr">{inspectedYearCell.year}</span>
						{#if inspectedYearCell.rec}
							{@const r = inspectedYearCell.rec}
							<span class="yi-summary">
								{r.vacant === 0
									? `All ${r.occupied} ${r.occupied === 1 ? 'storefront' : 'storefronts'} open`
									: `${r.vacant} of ${r.total} empty`}
							</span>
							<div class="yi-units">
								{#each r.units.slice(0, 4) as u}
									<span class="yi-chip" class:vac={u.vacant}>
										{u.vacant ? 'Vacant' : u.activity}
										{#if u.leaseExpiry}
											<em>· {u.vacant ? 'ended' : 'thru'} {formatMonthYear(u.leaseExpiry)}</em>
										{/if}
										{#if u.construction}
											<em>· Construction</em>
										{/if}
									</span>
								{/each}
								{#if r.units.length > 4}
									<span class="yi-more">+{r.units.length - 4} more</span>
								{/if}
							</div>
						{:else}
							<span class="yi-summary muted">No city storefront filing on record for {inspectedYearCell.year}.</span>
						{/if}
					</div>
				{/if}

				{#if milestones.length > 0}
					<div class="milestone-row">
						{#each milestones as m}
							{#if m.href}
								<a
									href={m.href}
									target="_blank"
									rel="noopener noreferrer"
									class="ms-pill ms-link tone-{m.tone}"
									title="View {m.label} on Google Maps"
								>
									<span class="mp-tag">{m.tag}</span>
									<strong>{m.label} <span class="biz-ext">↗</span></strong>
									<span class="mp-meta">{m.meta}</span>
								</a>
							{:else}
								<div class="ms-pill tone-{m.tone}">
									<span class="mp-tag">{m.tag}</span>
									<strong>{m.label}</strong>
									<span class="mp-meta">{m.meta}</span>
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			</section>

			<!-- 3. Single Compact Tabbed Evidence Panel (replaces 4 giant scrolling lists) -->
			<section class="evidence-card surface">
				<div class="ev-tabs" role="tablist" aria-label="Official NYC building records">
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'tenants'}
						class="ev-tab"
						class:active={activeTab === 'tenants'}
						onclick={() => {
							activeTab = 'tenants';
							showAllRows = false;
						}}
					>
						Businesses &amp; Licenses <em>{dossier.tenants.length}</em>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'dof'}
						class="ev-tab"
						class:active={activeTab === 'dof'}
						onclick={() => {
							activeTab = 'dof';
							showAllRows = false;
						}}
					>
						Storefront History <em>{dossier.dofHistory.length}</em>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'oath'}
						class="ev-tab"
						class:active={activeTab === 'oath'}
						onclick={() => {
							activeTab = 'oath';
							showAllRows = false;
						}}
					>
						City Tickets &amp; Fines <em>{dossier.oathCases.length}</em>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'permits'}
						class="ev-tab"
						class:active={activeTab === 'permits'}
						onclick={() => {
							activeTab = 'permits';
							showAllRows = false;
						}}
					>
						Renovation Permits <em>{dossier.permits.length}</em>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'c311'}
						class="ev-tab"
						class:active={activeTab === 'c311'}
						onclick={() => {
							activeTab = 'c311';
							showAllRows = false;
						}}
					>
						311 Reports <em>{dossier.complaints311.length}</em>
					</button>
				</div>

				<div class="ev-body">
					{#if activeTab === 'dof'}
						{#if dossier.dofHistory.length === 0}
							<p class="empty-msg">No commercial storefront filings found with NYC DOF for this building.</p>
						{:else}
							<div class="dof-list">
								{#each dossier.dofHistory as yr (yr.year)}
									<div class="dof-row">
										<div class="dr-yr">
											<strong>{yr.year}</strong>
											<span class:vac={yr.vacant > 0}>{yr.vacant}/{yr.total} empty</span>
										</div>
										<div class="dr-units">
											{#each yr.units as u}
												<div class="dr-unit" class:vac={u.vacant}>
													<span class="du-addr">{u.address}</span>
													<span class="du-act">
														{u.activity}
														{#if u.leaseExpiry}
															· Lease {u.vacant ? 'ended' : 'thru'} {formatMonthYear(u.leaseExpiry)}
														{/if}
														{u.construction ? ' · Construction' : ''}
													</span>
													<span class="du-pill" class:vac={u.vacant}>{u.vacant ? 'Vacant' : 'Open'}</span>
												</div>
											{/each}
										</div>
									</div>
								{/each}
							</div>
							<p class="dof-note">
								Note: NYC DOF's 2023–2025 business-type labels are omitted due to a citywide category-mapping error in NYC Open Data; see Businesses &amp; Licenses for verified tenant names.
							</p>
						{/if}
					{:else if activeTab === 'tenants'}
						{#if dossier.tenants.length === 0}
							<p class="empty-msg">
								No food-service (DOHMH) or DCWP-licensed businesses registered under this BBL (general offices and non-licensed boutiques aren't listed in these registries).
							</p>
						{:else}
							<ul class="ev-list">
								{#each dossier.tenants as t}
									<li class="ev-row">
										<div class="er-main">
											<a
												href={googleMapsPlaceUrl(t.name)}
												target="_blank"
												rel="noopener noreferrer"
												class="biz-link"
												title="Open {t.name} on Google Maps"
											>
												<strong>{t.name}</strong>
												<span class="biz-ext">↗</span>
											</a>
											<span class="er-cat">{t.category}</span>
										</div>
										<div class="er-meta">
											<span class="er-badge" title="NYC {t.source}">{explainSourceTag(t.source)}</span>
											{#if t.firstDate || t.lastDate}
												<span>{t.firstDate && t.lastDate && t.firstDate !== t.lastDate ? `${t.firstDate} → ${t.lastDate}` : t.lastDate || t.firstDate}</span>
											{/if}
											{#if t.inspections > 0}
												<span>· {t.inspections} inspections</span>
											{/if}
											<span class="er-status {t.status}">{t.status}</span>
										</div>
									</li>
								{/each}
							</ul>
						{/if}
					{:else if activeTab === 'oath'}
						{#if dossier.oathCases.length === 0}
							<p class="empty-msg">No OATH violation notices found for this BBL.</p>
						{:else}
							{@const rows = showAllRows ? dossier.oathCases : dossier.oathCases.slice(0, 6)}
							<ul class="ev-list">
								{#each rows as oc}
									<li class="ev-row">
										<div class="er-main">
											<span class="er-date">{oc.date || '—'}</span>
											<span class="er-agency">{oc.agency}</span>
											<span class="er-desc">{oc.description}</span>
										</div>
										<div class="er-meta">
											{#if oc.respondent}<span>{oc.respondent}</span>{/if}
											{#if oc.status}<span>· {oc.status}</span>{/if}
											{#if oc.amount}<span class="er-amt">${numFmt(oc.amount)}</span>{/if}
										</div>
									</li>
								{/each}
							</ul>
							{#if dossier.oathCases.length > 6}
								<button type="button" class="more-btn" onclick={() => (showAllRows = !showAllRows)}>
									{showAllRows ? 'Show fewer' : `Show all ${dossier.oathCases.length} notices`}
								</button>
							{/if}
						{/if}
					{:else if activeTab === 'permits'}
						{#if dossier.permits.length === 0}
							<p class="empty-msg">No recent alteration or build-out permits found for this BBL.</p>
						{:else}
							{@const rows = showAllRows ? dossier.permits : dossier.permits.slice(0, 6)}
							<ul class="ev-list">
								{#each rows as pm}
									<li class="ev-row">
										<div class="er-main">
											<span class="er-date">{pm.date || '—'}</span>
											<span class="er-agency" title="DOB code: {pm.jobType}">
												{explainPermitType(pm.jobType, pm.workType)}
											</span>
											{#if pm.description && pm.description.toUpperCase() !== pm.jobType.toUpperCase()}
												<span class="er-desc">{pm.description}</span>
											{/if}
										</div>
										<div class="er-meta">
											<span>{pm.status}</span>
										</div>
									</li>
								{/each}
							</ul>
							{#if dossier.permits.length > 6}
								<button type="button" class="more-btn" onclick={() => (showAllRows = !showAllRows)}>
									{showAllRows ? 'Show fewer' : `Show all ${dossier.permits.length} permits`}
								</button>
							{/if}
						{/if}
					{:else if activeTab === 'c311'}
						{#if dossier.complaints311.length === 0}
							<p class="empty-msg">No 311 service requests logged for this BBL since 2023.</p>
						{:else}
							{@const rows = showAllRows ? dossier.complaints311 : dossier.complaints311.slice(0, 6)}
							<ul class="ev-list">
								{#each rows as c}
									<li class="ev-row">
										<div class="er-main">
											<span class="er-date">{c.date || '—'}</span>
											<span class="er-agency">{c.type}</span>
											{#if c.descriptor}<span class="er-desc">{c.descriptor}</span>{/if}
										</div>
										<div class="er-meta">
											<span>{c.status}</span>
										</div>
									</li>
								{/each}
							</ul>
							{#if dossier.complaints311.length > 6}
								<button type="button" class="more-btn" onclick={() => (showAllRows = !showAllRows)}>
									{showAllRows ? 'Show fewer' : `Show all ${dossier.complaints311.length} reports`}
								</button>
							{/if}
						{/if}
					{/if}
				</div>
			</section>
		{/if}
	</main>
</div>

<style>
	.page-shell {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--page);
	}

	.bldg-body {
		padding-top: 18px;
		padding-bottom: 44px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	/* Top Nav Strip: Back to Block + Door-to-Door Sidewalk Stepper */
	.bldg-nav-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.door-stepper {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.nav-right-group {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.door-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--ink-soft);
		text-decoration: none;
		padding: 3px 8px;
		border: 1px solid var(--rule);
		border-radius: 5px;
		background: var(--panel);
		transition: border-color 0.1s ease, color 0.1s ease;
	}

	.door-link:hover {
		border-color: var(--ink);
		color: var(--ink);
	}

	.dl-arr {
		color: var(--muted);
	}

	.dl-sep {
		color: var(--line);
		font-size: 11px;
	}

	.dl-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #c8c8c2;
		flex: none;
	}

	.dl-dot.kind-vacant {
		background: var(--red);
	}

	.dl-dot.kind-occupied {
		background: var(--green);
	}

	.dl-dot.kind-mixed {
		background: var(--amber);
	}

	.block-context {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 11px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--rule);
		background: var(--panel);
		font-size: 12px;
		color: var(--ink-soft);
		line-height: 1.35;
	}

	.bc-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex: none;
		background: var(--muted);
	}

	.block-context.tone-better .bc-dot {
		background: var(--green);
	}

	.block-context.tone-worse .bc-dot {
		background: var(--red);
	}

	.block-context.tone-mixed .bc-dot {
		background: var(--amber);
	}

	.ms-plain {
		font-family: var(--font-body) !important;
		font-size: 12px !important;
	}

	.ms-sub {
		display: block;
		font-size: 10px;
		color: var(--muted);
		margin-top: 1px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* 1. Editorial 2-Column Hero */
	.hero-split {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 480px;
		gap: 20px;
		align-items: start;
	}

	.hero-copy {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}

	.back-link {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		text-decoration: none;
		color: var(--muted);
		align-self: flex-start;
	}

	.back-link:hover {
		color: var(--accent);
	}

	.title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.title-row h1 {
		font-size: clamp(22px, 2.5vw, 29px);
		line-height: 1.15;
		letter-spacing: -0.025em;
	}

	.status-pill {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		padding: 3px 9px;
		border-radius: 5px;
		background: var(--quiet);
		color: var(--ink-soft);
	}

	.status-pill.tone-vacant {
		background: var(--red-bg);
		color: var(--red);
	}

	.status-pill.tone-mixed {
		background: var(--amber-bg);
		color: var(--amber);
	}

	.status-pill.tone-open {
		background: var(--green-bg);
		color: var(--green);
	}

	.sub-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted);
	}

	.sub-meta strong {
		color: var(--ink);
		font-weight: 500;
	}

	.sub-meta .sep {
		color: var(--line);
	}

	.xray-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 7px;
		border-radius: 99px;
		border: 1px solid var(--rule);
		background: var(--panel);
		color: var(--ink);
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		cursor: pointer;
		transition: border-color 0.12s ease, background 0.12s ease;
	}

	.xray-pill:hover,
	.xray-pill.open {
		border-color: var(--ink);
		background: var(--quiet);
	}

	.xray-pill.has-vac {
		background: var(--red-bg);
		border-color: #f4c6be;
		color: var(--red);
	}

	.xray-pill.has-vac:hover {
		border-color: var(--red);
	}

	.xr-caret {
		font-size: 9px;
		opacity: 0.75;
	}

	.xray-drawer {
		padding: 11px 13px;
		background: var(--panel);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
		display: flex;
		flex-direction: column;
		gap: 9px;
	}

	.xr-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.xr-entity {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.xr-kicker {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		color: var(--muted);
	}

	.xr-entity strong {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.xr-addr {
		font-size: 11px;
		color: var(--muted);
	}

	.xr-stat {
		text-align: right;
		font-family: var(--font-mono);
		flex: none;
	}

	.xr-stat b {
		display: block;
		font-size: 15px;
		font-weight: 700;
		line-height: 1.1;
		color: var(--ink);
	}

	.xr-stat b.hot {
		color: var(--red);
	}

	.xr-stat span {
		font-size: 10px;
		color: var(--muted);
	}

	.xr-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 185px;
		overflow-y: auto;
	}

	.xr-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 8px;
		border-radius: 5px;
		border: 1px solid var(--rule);
		background: var(--page);
		text-decoration: none;
		color: var(--ink);
		font-size: 12px;
		transition: border-color 0.1s ease, background 0.1s ease;
	}

	a.xr-row:hover {
		border-color: var(--ink);
		background: var(--panel);
	}

	.xr-row.current {
		opacity: 0.78;
	}

	.xr-b-info {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}

	.xr-b-info strong {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.xr-b-info span {
		font-size: 11px;
		color: var(--muted);
		flex: none;
	}

	.xr-b-stat {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex: none;
		font-family: var(--font-mono);
	}

	.xr-badge {
		font-size: 10.5px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--green-bg);
		color: var(--green);
	}

	.xr-badge.vac {
		background: var(--red-bg);
		color: var(--red);
	}

	.xr-yr {
		font-size: 10px;
		font-weight: 600;
		color: var(--plum);
	}

	.xr-go {
		font-size: 11px;
		color: var(--muted-light);
	}

	.xr-empty {
		margin: 0;
		font-size: 11.5px;
		color: var(--muted);
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 11px;
	}

	.story-box {
		padding: 12px 14px;
		background: var(--panel);
		border: 1px solid var(--rule);
		border-left: 3px solid var(--ink);
		border-radius: var(--radius-sm);
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.story-box p {
		font-size: 13px;
		line-height: 1.48;
		color: var(--ink-soft);
	}

	.story-box p:first-child {
		color: var(--ink);
		font-weight: 500;
	}

	.story-box.ai-upgraded {
		border-left-color: #e62217;
	}

	.story-box.ai-loading {
		border-left-color: var(--line);
		min-height: 92px;
	}

	.fn-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 1px;
	}

	.fn-kicker {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #b42318;
	}

	.fn-kicker.thinking {
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.fn-shimmer {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding: 4px 0 2px;
	}

	.sh-line {
		display: block;
		height: 11px;
		border-radius: 4px;
		background: linear-gradient(90deg, #efefe9 25%, #e4e4dc 50%, #efefe9 75%);
		background-size: 200% 100%;
		animation: aiShimmer 1.35s infinite ease-in-out;
	}

	.sh-line.w1 { width: 96%; }
	.sh-line.w2 { width: 88%; }
	.sh-line.w3 { width: 62%; }

	@keyframes aiShimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

	.fn-verdict {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--quiet);
		color: var(--ink);
	}

	.story-box p.fn-summary {
		color: var(--ink);
		font-weight: 400;
		font-size: 13.2px;
		line-height: 1.52;
	}

	.wb-spark {
		color: #e62217;
	}

	.wb-spark.pulse {
		animation: pulseSpark 0.9s infinite ease-in-out;
	}

	@keyframes pulseSpark {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 1; }
	}

	.web-cites {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-top: 4px;
	}

	.cite-pill {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
		text-decoration: none;
		padding: 2px 7px;
		border-radius: 99px;
		background: var(--page);
		border: 1px solid var(--rule);
		max-width: 220px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: border-color 0.12s ease, color 0.12s ease;
	}

	.cite-pill:hover {
		border-color: var(--ink);
		color: var(--ink);
	}

	.dropped-alert {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 8px 12px;
		background: var(--amber-bg);
		border: 1px solid #f0cfa0;
		border-radius: var(--radius-sm);
		font-size: 12px;
		color: #6b3f04;
	}

	.da-tag {
		flex: none;
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 700;
		letter-spacing: 0.05em;
		color: var(--amber);
	}

	.mini-specs {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px 14px;
		padding: 10px 12px;
		background: var(--panel);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
	}

	.ms-cell {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.ms-k {
		font-family: var(--font-mono);
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted-light);
	}

	.ms-cell b {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ext-links {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		margin-top: 2px;
	}

	.ext-links a {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
		text-decoration: none;
	}

	.ext-links a:hover {
		color: var(--accent);
	}

	/* 2. Visual 2019–2025 Storefront Occupancy & Trajectory Chart */
	.traj-pill {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		padding: 3px 9px;
		border-radius: 5px;
		background: var(--quiet);
		color: var(--muted);
	}

	.traj-pill.tone-better {
		background: var(--green-bg);
		color: var(--green);
	}

	.traj-pill.tone-worse {
		background: var(--red-bg);
		color: var(--red);
	}

	.traj-pill.tone-chronic {
		background: #f8ecea;
		color: #8f1422;
	}

	.timeline-card {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.tl-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.tl-title-wrap {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.tl-verdict {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 12.5px;
		color: var(--ink-soft);
	}

	.tl-verdict strong {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 700;
	}

	.tl-verdict.tone-better strong {
		color: var(--green);
	}

	.tl-verdict.tone-worse strong {
		color: var(--red);
	}

	.tl-verdict.tone-chronic strong {
		color: #8f1422;
	}

	.tl-verdict.tone-steady strong {
		color: var(--ink);
	}

	.tl-legend {
		display: inline-flex;
		align-items: center;
		gap: 12px;
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
	}

	.tl-legend span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.sw {
		width: 8px;
		height: 8px;
		border-radius: 2px;
		display: inline-block;
	}

	.sw.open {
		background: var(--green);
	}

	.sw.vacant {
		background: var(--red);
	}

	.sw.none {
		background: #e2e2dc;
	}

	.occ-chart {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 8px;
		padding: 10px 10px 8px;
		background: var(--page);
		border: 1px solid var(--rule);
		border-radius: var(--radius-sm);
	}

	.occ-col {
		border: 1px solid transparent;
		background: transparent;
		padding: 6px 4px 5px;
		border-radius: 5px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 5px;
		min-width: 0;
		transition: background 0.1s ease, border-color 0.1s ease;
	}

	.occ-col:hover,
	.occ-col.active {
		background: var(--panel);
		border-color: var(--line);
	}

	.year-inspector {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 10px;
		padding: 8px 11px;
		border-radius: var(--radius-sm);
		background: var(--page);
		border: 1px solid var(--rule);
		font-size: 12px;
	}

	.yi-yr {
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-weight: 700;
		color: var(--ink);
		padding-right: 8px;
		border-right: 1px solid var(--line);
	}

	.yi-summary {
		font-weight: 600;
		color: var(--ink);
	}

	.yi-summary.muted {
		font-weight: 400;
		color: var(--muted);
	}

	.yi-units {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		align-items: center;
	}

	.yi-chip {
		font-family: var(--font-mono);
		font-size: 10.5px;
		padding: 2px 7px;
		border-radius: 4px;
		background: var(--green-bg);
		color: var(--green);
	}

	.yi-chip.vac {
		background: var(--red-bg);
		color: var(--red);
	}

	.yi-chip em {
		font-style: normal;
		opacity: 0.85;
	}

	.yi-more {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}

	.occ-ratio {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		color: var(--muted);
		white-space: nowrap;
	}

	.occ-col.state-open .occ-ratio {
		color: var(--green);
	}

	.occ-col.state-vacant .occ-ratio {
		color: var(--red);
	}

	.occ-col.state-mixed .occ-ratio {
		color: var(--ink);
	}

	.occ-stage {
		width: 100%;
		height: 66px;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		padding-bottom: 4px;
		border-bottom: 1.5px solid var(--line);
	}

	.unit-stack {
		width: min(56px, 82%);
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.u-blk {
		width: 100%;
		border-radius: 3px;
		display: block;
	}

	.u-blk.occ,
	.pb-occ {
		background: #1b8057;
	}

	.u-blk.vac,
	.pb-vac {
		background: repeating-linear-gradient(
			-45deg,
			#d9381e 0px,
			#d9381e 3px,
			#b42318 3px,
			#b42318 5.5px
		);
	}

	.prop-bar {
		width: min(56px, 82%);
		border-radius: 3px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.pb-vac,
	.pb-occ {
		width: 100%;
		display: block;
	}

	.u-empty {
		width: min(56px, 82%);
		height: 12px;
		border: 1px dashed #d4d4ce;
		border-radius: 3px;
		background: transparent;
	}

	.u-empty.dropped {
		border-color: #d97706;
		background: var(--amber-bg);
	}

	.occ-foot {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		width: 100%;
		min-width: 0;
	}

	.occ-yr {
		font-family: var(--font-mono);
		font-size: 11.5px;
		font-weight: 700;
		color: var(--ink);
	}

	.occ-sub {
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--muted);
		max-width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: center;
	}

	.milestone-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding-top: 8px;
		border-top: 1px solid var(--rule);
	}

	.ms-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 9px;
		border-radius: 4px;
		background: var(--page);
		border: 1px solid var(--rule);
		font-size: 11.5px;
	}

	.ms-pill.tone-red {
		background: #fff8f6;
		border-color: #f0c2b8;
	}

	.ms-pill strong {
		font-weight: 600;
		color: var(--ink);
	}

	.mp-tag {
		font-family: var(--font-mono);
		font-size: 9.5px;
		font-weight: 700;
		color: var(--muted);
	}

	.ms-pill.tone-red .mp-tag {
		color: var(--red);
	}

	.ms-pill.tone-green .mp-tag {
		color: var(--green);
	}

	.mp-meta {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted);
	}

	/* 3. Compact Tabbed Evidence Panel */
	.evidence-card {
		overflow: hidden;
	}

	.ev-tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		padding: 6px 10px 0;
		border-bottom: 1px solid var(--rule);
		background: var(--page);
	}

	.ev-tab {
		border: 0;
		background: transparent;
		padding: 8px 12px 9px;
		font-family: var(--font-body);
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		transition: color 0.12s ease;
	}

	.ev-tab:hover {
		color: var(--ink);
	}

	.ev-tab.active {
		color: var(--ink);
		font-weight: 600;
		border-bottom-color: var(--ink);
	}

	.ev-tab em {
		font-style: normal;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted-light);
	}

	.ev-tab.active em {
		color: var(--accent);
	}

	.ev-body {
		padding: 12px 16px 14px;
	}

	.empty-msg {
		font-size: 12.5px;
		color: var(--muted);
		padding: 6px 0;
	}

	.dof-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.dof-row {
		display: grid;
		grid-template-columns: 90px 1fr;
		gap: 10px;
		align-items: start;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--rule);
	}

	.dof-row:last-child {
		padding-bottom: 0;
		border-bottom: 0;
	}

	.dr-yr {
		display: flex;
		flex-direction: column;
		font-family: var(--font-mono);
	}

	.dr-yr strong {
		font-size: 13px;
	}

	.dr-yr span {
		font-size: 10px;
		color: var(--muted);
	}

	.dr-yr span.vac {
		color: var(--red);
		font-weight: 600;
	}

	.dr-units {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.dr-unit {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 9px;
		border-radius: 4px;
		background: var(--page);
		font-size: 12px;
	}

	.dr-unit.vac {
		background: #fff7f5;
	}

	.du-addr {
		font-weight: 500;
		color: var(--ink);
	}

	.du-act {
		flex: 1;
		color: var(--muted);
		font-size: 11.5px;
	}

	.du-pill {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		padding: 1.5px 7px;
		border-radius: 4px;
		background: var(--green-bg);
		color: var(--green);
	}

	.du-pill.vac {
		background: var(--red-bg);
		color: var(--red);
	}

	.dof-note {
		margin-top: 10px;
		font-size: 11px;
		color: var(--muted);
		line-height: 1.45;
	}

	.ev-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}

	.ev-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 0;
		border-bottom: 1px solid var(--rule);
		font-size: 12px;
	}

	.ev-row:last-child {
		border-bottom: 0;
	}

	.er-main {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		flex-wrap: wrap;
	}

	.er-date {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
		flex: none;
	}

	.er-agency {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 600;
		color: var(--ink);
		flex: none;
	}

	.er-cat {
		font-size: 11.5px;
		color: var(--muted);
	}

	.biz-link {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
		color: var(--ink);
		text-decoration: none;
	}

	.biz-link:hover {
		color: var(--accent);
	}

	.biz-link:hover strong {
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.biz-ext {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--muted-light);
		transition: color 0.1s ease;
	}

	.biz-link:hover .biz-ext,
	.ms-link:hover .biz-ext {
		color: var(--accent);
	}

	.ms-link {
		text-decoration: none;
		color: inherit;
		transition: border-color 0.1s ease, background 0.1s ease;
	}

	.ms-link:hover {
		border-color: var(--ink);
		background: var(--panel);
	}

	.er-desc {
		color: var(--ink-soft);
	}

	.er-meta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: none;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}

	.er-badge {
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--quiet);
		color: var(--ink-soft);
		font-weight: 600;
	}

	.er-amt {
		color: var(--red);
		font-weight: 600;
	}

	.er-status {
		text-transform: uppercase;
		font-size: 9.5px;
		font-weight: 600;
		padding: 1.5px 6px;
		border-radius: 3px;
		background: var(--quiet);
	}

	.er-status.active {
		background: var(--green-bg);
		color: var(--green);
	}

	.er-status.former {
		background: var(--red-bg);
		color: var(--red);
	}

	.more-btn {
		margin-top: 8px;
		border: 1px solid var(--rule);
		background: var(--page);
		padding: 5px 11px;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--ink-soft);
		cursor: pointer;
	}

	.more-btn:hover {
		border-color: var(--ink);
		color: var(--ink);
	}

	/* Skeleton Loading */
	.loading-hero {
		display: grid;
		grid-template-columns: 1fr 480px;
		gap: 20px;
	}

	.skel {
		background: linear-gradient(90deg, #f2f2ee 25%, #fafaf8 50%, #f2f2ee 75%);
		background-size: 200% 100%;
		animation: pulse 1.2s ease infinite;
	}

	.skel.hero-l,
	.skel.hero-r {
		height: 316px;
	}

	.skel.strip {
		height: 110px;
	}

	@keyframes pulse {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}

	.alert-card {
		padding: 16px;
		color: var(--red);
	}

	@media (max-width: 960px) {
		.hero-split,
		.loading-hero {
			grid-template-columns: 1fr;
		}
		.occ-chart {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
		.ev-row {
			flex-direction: column;
			gap: 3px;
		}
	}
</style>
