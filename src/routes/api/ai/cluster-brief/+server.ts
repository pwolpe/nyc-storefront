import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PersistentCache } from '$lib/server/cache';
import {
	callOpenRouter,
	getDefaultModel,
	getOpenRouterKey,
	type OpenRouterCitation
} from '$lib/server/openrouter';

interface ClusterBriefResponse {
	configured: boolean;
	summary: string;
	citations?: OpenRouterCitation[];
	error?: string;
}

const clusterCache = new PersistentCache<ClusterBriefResponse>('ai-cluster-brief-v2', 1000 * 60 * 60 * 72, 400);
const EDGE_TTL_SEC = 60 * 60 * 72; // 72 hours

function getEdgeCache(): Cache | null {
	try {
		return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
	} catch {
		return null;
	}
}

function cleanProse(raw: string): string {
	return raw
		.replace(/^["']|["']$/g, '')
		.replace(/\s*\(\[[^\]]+\]\(https?:\/\/[^)]+\)\)/g, '')
		.replace(/\s*\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '')
		.replace(/\s*\[\d+\]/g, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\s+([.,;:])/g, '$1')
		.replace(/,\s*\./g, '.')
		.replace(/\s+/g, ' ')
		.trim();
}

export const POST: RequestHandler = async ({ request, platform }) => {
	const apiKey = getOpenRouterKey(platform);
	if (!apiKey) {
		return json({ configured: false, summary: '' } satisfies ClusterBriefResponse);
	}

	let payload: {
		id?: string;
		name?: string;
		borough?: string;
		rate?: number;
		cityRate?: number;
		vacant?: number;
		total?: number;
		yoyChange?: number | null;
		history?: Array<{ year: number; rate: number; vacant?: number; total?: number }>;
		topStreets?: Array<{ name: string; rate: number; vacant: number; total: number }>;
		worstBlocks?: Array<{
			street: string;
			between: string;
			vacant: number;
			total: number;
			prevVacant?: number;
			delta?: number | null;
		}>;
		topVacantBuildings?: Array<{
			address: string;
			street: string;
			vacant: number;
			total: number;
			shareOfClusterPct: number;
		}>;
		neighbors?: Array<{ name: string; rate: number }>;
	};

	try {
		payload = await request.json();
	} catch {
		return json({ configured: true, summary: '', error: 'Invalid JSON' } satisfies ClusterBriefResponse);
	}

	const id = (payload.id || '').trim();
	if (!id) return json({ configured: true, summary: '', error: 'Missing id' } satisfies ClusterBriefResponse);

	const hit = clusterCache.get(id);
	if (hit) {
		return json(hit);
	}

	const edgeCache = getEdgeCache();
	const edgeKey = new Request(`https://cache.nyc-storefront.internal/cluster-brief/v2/${encodeURIComponent(id)}`);
	if (edgeCache) {
		try {
			const edgeHit = await edgeCache.match(edgeKey);
			if (edgeHit) {
				const cached = (await edgeHit.json()) as ClusterBriefResponse;
				clusterCache.set(id, cached);
				return json(cached);
			}
		} catch {
			// continue
		}
	}

	// Use live web grounding (:online) when a cluster has a sharp move OR heavy concentration in 1-2 anchor buildings
	// so we can actually name the landmark/redevelopment/closings driving the numbers!
	const topBldgShare = payload.topVacantBuildings?.[0]?.shareOfClusterPct ?? 0;
	const bigSwing = Math.abs(payload.yoyChange ?? 0) >= 3.0 || (payload.rate ?? 0) >= 18;
	const useOnline = topBldgShare >= 22 || bigSwing;

	const system = `You are a sharp NYC retail & urban data editor writing a concise 2-sentence "Spatial Takeaway" (max 56 words total) for a neighborhood storefront cluster.
CRITICAL: Explain *why* the vacancy rate looks the way it does — don't just restate numbers!
- Check "topVacantBuildings" first: if 1 or 2 buildings account for a large share of all empty storefronts (e.g. a major warehouse/redevelopment like Terminal Warehouse at 261 11th Ave or Starrett-Lehigh at 601 W 26th St, or a single large corner lot), NAME that building/address and explain whether the spike comes from newly built unleased bays, a known redevelopment/closing, or broad street-level vacancies.
- Contrast busy vs. empty streets inside the cluster when relevant.
- Never invent closings or facts; if using web search, only cite verified NYC retail/building facts. Plain text only — no bullets, no markdown links, no bolding.`;

	try {
		let data: ClusterBriefResponse;
		try {
			const ai = await callOpenRouter({
				apiKey,
				model: getDefaultModel(platform, useOnline),
				system,
				user: JSON.stringify(payload),
				temperature: 0.2,
				maxTokens: 210,
				timeoutMs: useOnline ? 18000 : 12000
			});
			data = {
				configured: true,
				summary: cleanProse(ai.text),
				citations: ai.citations.slice(0, 3)
			};
		} catch {
			const ai = await callOpenRouter({
				apiKey,
				model: getDefaultModel(platform, false),
				system,
				user: JSON.stringify(payload),
				temperature: 0.2,
				maxTokens: 180,
				timeoutMs: 11000
			});
			data = {
				configured: true,
				summary: cleanProse(ai.text),
				citations: []
			};
		}

		if (data.summary) {
			clusterCache.set(id, data);
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
			error: e instanceof Error ? e.message : 'Summary unavailable'
		} satisfies ClusterBriefResponse);
	}
};
