import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import type { StreetViewAuditResult } from '$lib/types';
import { PersistentCache } from '$lib/server/cache';
import {
	callOpenRouter,
	extractJsonObject,
	getDefaultModel,
	getOpenRouterKey
} from '$lib/server/openrouter';

const auditCache = new PersistentCache<StreetViewAuditResult>('ai-sv-audit-v1', 1000 * 60 * 60 * 72, 1200);
const EDGE_TTL_SEC = 60 * 60 * 72; // 72 hours

function getEdgeCache(): Cache | null {
	try {
		return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
	} catch {
		return null;
	}
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export const POST: RequestHandler = async ({ request, platform }) => {
	const orKey = getOpenRouterKey(platform);
	const mapsKey = (
		env.GOOGLE_MAPS_API_KEY ||
		(platform?.env as Record<string, string> | undefined)?.GOOGLE_MAPS_API_KEY ||
		''
	).trim();

	if (!orKey || !mapsKey) {
		return json({
			configured: false,
			bbl: '',
			visualStatus: 'unclear',
			signageText: null,
			signals: [],
			summary: '',
			discrepancy: null,
			captureDate: null
		} satisfies StreetViewAuditResult);
	}

	let payload: {
		bbl?: string;
		address?: string;
		borough?: string;
		lat?: number | null;
		lng?: number | null;
		captureDate?: string | null;
		dofStatus?: 'vacant' | 'open' | 'mixed' | 'none';
		dofVacant?: number;
		dofTotal?: number;
		knownTenants?: string[];
	};

	try {
		payload = await request.json();
	} catch {
		return json({
			configured: true,
			bbl: '',
			visualStatus: 'unclear',
			signageText: null,
			signals: [],
			summary: '',
			discrepancy: null,
			captureDate: null
		} satisfies StreetViewAuditResult);
	}

	const bbl = (payload.bbl || '').trim();
	if (!bbl) {
		return json({
			configured: true,
			bbl: '',
			visualStatus: 'unclear',
			signageText: null,
			signals: [],
			summary: '',
			discrepancy: null,
			captureDate: null
		} satisfies StreetViewAuditResult);
	}

	// 1. Persistent LRU cache
	const memHit = auditCache.get(bbl);
	if (memHit) {
		return json(memHit);
	}

	// 2. Edge Cache if present
	const edgeCache = getEdgeCache();
	const edgeKey = new Request(`https://cache.nyc-storefront.internal/sv-audit/v1/${encodeURIComponent(bbl)}`);
	if (edgeCache) {
		try {
			const hit = await edgeCache.match(edgeKey);
			if (hit) {
				const data = (await hit.json()) as StreetViewAuditResult;
				auditCache.set(bbl, data);
				return json(data);
			}
		} catch {
			// continue
		}
	}

	// 3. Fetch the exact Street View facade image directly from Google
	const location =
		payload.address && !payload.address.startsWith('BBL ')
			? `${payload.address}, ${payload.borough || 'New York'}, NY`
			: payload.lat != null && payload.lng != null
				? `${payload.lat},${payload.lng}`
				: '';

	if (!location) {
		return json({
			configured: true,
			bbl,
			visualStatus: 'unclear',
			signageText: null,
			signals: [],
			summary: '',
			discrepancy: null,
			captureDate: payload.captureDate || null
		} satisfies StreetViewAuditResult);
	}

	try {
		const svParams = new URLSearchParams({
			size: '640x400',
			fov: '72',
			pitch: '10',
			source: 'outdoor',
			return_error_code: 'true',
			location,
			key: mapsKey
		});
		const svRes = await globalThis.fetch(
			`https://maps.googleapis.com/maps/api/streetview?${svParams.toString()}`
		);
		if (!svRes.ok) {
			return json({
				configured: true,
				bbl,
				visualStatus: 'unclear',
				signageText: null,
				signals: [],
				summary: '',
				discrepancy: null,
				captureDate: payload.captureDate || null
			} satisfies StreetViewAuditResult);
		}

		const contentType = svRes.headers.get('content-type') || 'image/jpeg';
		const imgBase64 = arrayBufferToBase64(await svRes.arrayBuffer());
		const dataUrl = `data:${contentType};base64,${imgBase64}`;

		const dofDesc =
			payload.dofStatus === 'vacant'
				? `NYC DOF 2025 filing reports VACANT (${payload.dofVacant}/${payload.dofTotal} empty)`
				: payload.dofStatus === 'open'
					? `NYC DOF 2025 filing reports OPEN (0/${payload.dofTotal} empty)`
					: payload.dofStatus === 'mixed'
						? `NYC DOF 2025 filing reports MIXED (${payload.dofVacant}/${payload.dofTotal} empty)`
						: 'No DOF commercial filing on record';

		const system = `You are an NYC urban-planning photo auditor inspecting a Google Street View photo of a building's ground-floor storefront(s).
Look ONLY at what is actually visible in the photograph (ground floor signage, awnings, open doors/lights, papered/kraft windows, metal roll-down security gates, "For Lease"/"For Rent" brokerage banners, sidewalk sheds/scaffolding, empty interiors).
Return STRICT JSON:
{
  "visualStatus": "open" | "vacant" | "construction" | "unclear",
  "signageText": "Exact legible business name(s) on awning/signage, or null if none clearly readable",
  "signals": ["Up to 3 short 2-3 word visual cues like 'Active signage', 'Roll-down gate', 'Papered windows', 'For Lease banner', 'Sidewalk shed', 'Empty interior'"],
  "summary": "1 crisp factual sentence (max 24 words) stating what the camera sees on the ground floor.",
  "discrepancyFlag": true or false (TRUE ONLY if the photo clearly contradicts the DOF tax filing — e.g. DOF says OPEN but photo clearly shows papered windows / For Lease / gutted interior, OR DOF says VACANT but photo clearly shows a brightly operating open business with customers/fresh signage. Be conservative: a closed roll-down gate at early morning or scaffolding alone is NOT a definite contradiction!),
  "discrepancyHeadline": "Short 6-11 word headline if discrepancyFlag is true, otherwise null"
}`;

		const user = `Address: ${payload.address || bbl}, ${payload.borough || 'NYC'}.
Street View capture date: ${payload.captureDate || 'unknown'}.
City tax record: ${dofDesc}.
Known city-listed tenants: ${(payload.knownTenants || []).slice(0, 4).join(', ') || 'none'}.
Inspect the ground floor of this photo and return strict JSON.`;

		const ai = await callOpenRouter({
			apiKey: orKey,
			model: getDefaultModel(platform, false),
			fallbackModels: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash'],
			system,
			user,
			imageDataUrl: dataUrl,
			temperature: 0.1,
			maxTokens: 280,
			jsonMode: true,
			timeoutMs: 16000
		});

		const parsed = extractJsonObject<{
			visualStatus?: 'open' | 'vacant' | 'construction' | 'unclear';
			signageText?: string | null;
			signals?: string[];
			summary?: string;
			discrepancyFlag?: boolean;
			discrepancyHeadline?: string | null;
		}>(ai.text);

		const result: StreetViewAuditResult = {
			configured: true,
			bbl,
			visualStatus: parsed?.visualStatus || 'unclear',
			signageText: parsed?.signageText?.trim() || null,
			signals: Array.isArray(parsed?.signals)
				? parsed.signals.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
				: [],
			summary: (parsed?.summary || '').trim(),
			discrepancy:
				parsed?.discrepancyFlag && parsed?.discrepancyHeadline
					? { flagged: true, headline: parsed.discrepancyHeadline.trim() }
					: null,
			captureDate: payload.captureDate || null
		};

		if (result.summary) {
			auditCache.set(bbl, result);
			if (edgeCache) {
				const edgeRes = new Response(JSON.stringify(result), {
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

		return json(result);
	} catch {
		return json({
			configured: true,
			bbl,
			visualStatus: 'unclear',
			signageText: null,
			signals: [],
			summary: '',
			discrepancy: null,
			captureDate: payload.captureDate || null
		} satisfies StreetViewAuditResult);
	}
};
