import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PersistentCache } from '$lib/server/cache';
import {
	callOpenRouter,
	getDefaultModel,
	getOpenRouterKey,
	type OpenRouterCitation
} from '$lib/server/openrouter';

interface BuildingBriefResponse {
	configured: boolean;
	verdictTag?: string;
	summary: string;
	citations: OpenRouterCitation[];
	webGrounded: boolean;
	error?: string;
}

const briefCache = new PersistentCache<BuildingBriefResponse>('ai-building-brief-v3', 1000 * 60 * 60 * 72, 1200);
const EDGE_TTL_SEC = 60 * 60 * 72; // 72 hours

function cleanWebText(raw: string): { verdictTag?: string; summary: string } {
	let verdictTag: string | undefined;
	let body = raw.trim();

	const firstLineMatch = body.match(/^VERDICT\s*:\s*([^\n]+)\n+([\s\S]+)$/i);
	if (firstLineMatch) {
		verdictTag = firstLineMatch[1].replace(/[*#"`]/g, '').trim().slice(0, 32);
		body = firstLineMatch[2].trim();
	}

	const summary = body
		.replace(/\s*\(\[[^\]]+\]\(https?:\/\/[^)]+\)\)/g, '')
		.replace(/\s*\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '')
		.replace(/\s*\[\d+\]/g, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\s+([.,;:])/g, '$1')
		.replace(/,\s*\./g, '.')
		.replace(/\s+/g, ' ')
		.trim();

	return { verdictTag, summary };
}

function getEdgeCache(): Cache | null {
	try {
		const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
		return c ?? null;
	} catch {
		return null;
	}
}

export const POST: RequestHandler = async ({ request, platform }) => {
	const apiKey = getOpenRouterKey(platform);
	if (!apiKey) {
		return json({
			configured: false,
			summary: '',
			citations: [],
			webGrounded: false
		} satisfies BuildingBriefResponse);
	}

	let payload: {
		bbl?: string;
		address?: string;
		borough?: string;
		zipcode?: string;
		ownerName?: string;
		isCondo?: boolean;
		yearBuilt?: number | null;
		floors?: number | null;
		retailAreaSqft?: number | null;
		landUseLabel?: string;
		consecutiveVacantYears?: number;
		blockContext?: string;
		streetName?: string;
		between?: string;
		dofYears?: Array<{
			year: number;
			vacant: number;
			total: number;
			activities: string[];
			leaseExpiries: string[];
			construction: boolean;
		}>;
		tenants?: Array<{
			name: string;
			category: string;
			source: string;
			status: string;
			firstDate: string | null;
			lastDate: string | null;
		}>;
		permits?: Array<{ date: string; jobType: string; workType: string; description: string }>;
		oathTop?: Array<{ respondent: string; count: number; latestDate: string; sample: string }>;
		c311Recent?: Array<{ date: string; type: string; descriptor: string }>;
	};

	try {
		payload = await request.json();
	} catch {
		return json({
			configured: true,
			summary: '',
			citations: [],
			webGrounded: false,
			error: 'Invalid JSON'
		} satisfies BuildingBriefResponse);
	}

	const bbl = (payload.bbl || '').trim();
	if (!bbl) {
		return json({
			configured: true,
			summary: '',
			citations: [],
			webGrounded: false,
			error: 'Missing BBL'
		} satisfies BuildingBriefResponse);
	}

	// 1. Check persistent LRU cache (in-memory + disk-backed on Railway)
	const memHit = briefCache.get(bbl);
	if (memHit) {
		return json(memHit);
	}

	// 2. Check Edge Cache if present
	const edgeCache = getEdgeCache();
	const edgeKey = new Request(`https://cache.nyc-storefront.internal/ai-brief/v3/${encodeURIComponent(bbl)}`);
	if (edgeCache) {
		try {
			const edgeHit = await edgeCache.match(edgeKey);
			if (edgeHit) {
				const cachedData = (await edgeHit.json()) as BuildingBriefResponse;
				briefCache.set(bbl, cachedData);
				return json(cachedData);
			}
		} catch {
			// proceed to live generation
		}
	}

	const compactFacts = {
		address: payload.address,
		borough: payload.borough,
		zipcode: payload.zipcode,
		corridor: `${payload.streetName || ''} (${payload.between || ''})`.trim(),
		building: `${payload.floors || '?'}F ${payload.landUseLabel || ''}, built ${payload.yearBuilt || '?'}, ${payload.retailAreaSqft ? `${payload.retailAreaSqft} sqft retail` : 'retail size unrecorded'}`,
		owner: payload.isCondo ? 'Condo association' : payload.ownerName,
		consecutiveVacantYears: payload.consecutiveVacantYears,
		blockContext: payload.blockContext,
		dofYears: (payload.dofYears || []).slice(0, 7),
		tenants: (payload.tenants || []).slice(0, 6),
		permits: (payload.permits || []).slice(0, 4),
		oathTop: (payload.oathTop || []).slice(0, 3),
		c311Recent: (payload.c311Recent || []).slice(0, 3)
	};

	const todayLabel = new Date().toLocaleDateString('en-US', {
		month: 'long',
		day: 'numeric',
		year: 'numeric'
	});

	const system = `You are a sharp NYC retail & urbanism reporter writing a concise "Field Note" for a single storefront building.
Today's date is ${todayLabel}.
Combine the provided NYC public records (DOF 2019-2025 filings, tenant/restaurant history, DOB permits, OATH, 311) WITH live web search for this exact address to report both the history and what is happening right now (current open business, recent closing, active build-out, or commercial lease listing).

CRITICAL TEMPORAL RULES:
- Always check the year of every web article, CB4/SLA letter, or city record relative to today (${todayLabel}).
- NEVER write about a past year (such as 2022, 2023, 2024, or 2025) in present or future tense (e.g. NEVER say "slated to open in late 2023" or "aiming to open in 2024"). Frame older articles strictly in past tense ("In late 2023, ... applied for...") and cross-check newer 2025-2026 DOF/DOHMH/DCWP records to see what is actually open or empty today.
- Base your VERDICT tag on the LATEST verified status (2025 DOF + 2025-2026 licenses, inspections, or recent web listings), not an outdated 2023-2024 proposal.

Output format (strict, no markdown links, no bullets, no bolding):
VERDICT: <2-3 word status tag like "Active listing", "Active buildout", "Recent turnover", "Long-term dark", "Open & busy", or "Mixed ground floor">
<2-3 tight journalistic sentences, max 68 words total. Name specific past/current businesses, dates, permits, or brokerage listings only when verified. Never fabricate openings or closings; if live web has nothing new, synthesize the NYC records crisply.>`;

	const user = `Today's date: ${todayLabel}.
NYC storefront: ${payload.address || bbl}, ${payload.borough || 'New York'}, NY ${payload.zipcode || ''}.
Structured NYC public records:
${JSON.stringify(compactFacts)}`;

	try {
		let data: BuildingBriefResponse;

		try {
			// Primary: single unified web-grounded call (:online)
			const ai = await callOpenRouter({
				apiKey,
				model: getDefaultModel(platform, true),
				system,
				user,
				temperature: 0.2,
				maxTokens: 320,
				timeoutMs: 20000
			});
			const parsed = cleanWebText(ai.text);
			data = {
				configured: true,
				verdictTag: parsed.verdictTag,
				summary: parsed.summary,
				citations: ai.citations,
				webGrounded: ai.citations.length > 0 || true
			};
		} catch {
			// Graceful fallback: local-only synthesis on the 6 NYC datasets
			const ai = await callOpenRouter({
				apiKey,
				model: getDefaultModel(platform, false),
				system,
				user,
				temperature: 0.2,
				maxTokens: 260,
				timeoutMs: 12000
			});
			const parsed = cleanWebText(ai.text);
			data = {
				configured: true,
				verdictTag: parsed.verdictTag,
				summary: parsed.summary,
				citations: [],
				webGrounded: false
			};
		}

		if (data.summary) {
			briefCache.set(bbl, data);
			if (edgeCache) {
				const edgeRes = new Response(JSON.stringify(data), {
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': `public, max-age=${EDGE_TTL_SEC}`
					}
				});
				const waitUntil = (platform as unknown as { ctx?: { waitUntil?: (p: Promise<unknown>) => void } })
					?.ctx?.waitUntil;
				const putPromise = edgeCache.put(edgeKey, edgeRes).catch(() => {});
				if (waitUntil) waitUntil(putPromise);
				else await putPromise;
			}
		}

		return json(data);
	} catch (e) {
		return json({
			configured: true,
			summary: '',
			citations: [],
			webGrounded: false,
			error: e instanceof Error ? e.message : 'Field note unavailable'
		} satisfies BuildingBriefResponse);
	}
};
