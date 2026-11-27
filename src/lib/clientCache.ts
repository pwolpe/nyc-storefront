/**
 * Lightweight browser-side in-memory cache so Back/Forward, Door-to-Door stepping,
 * and revisiting blocks or buildings render at 0ms with zero shimmer or re-fetch.
 */
class ClientCache<T> {
	private map = new Map<string, { at: number; data: T }>();
	private inflight = new Map<string, Promise<T | null>>();

	constructor(
		private readonly ttlMs = 1000 * 60 * 15,
		private readonly maxEntries = 200
	) {}

	get(key: string): T | null {
		const hit = this.map.get(key);
		if (!hit) return null;
		if (Date.now() - hit.at > this.ttlMs) {
			this.map.delete(key);
			return null;
		}
		return hit.data;
	}

	set(key: string, data: T): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, { at: Date.now(), data });
		while (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest === undefined) break;
			this.map.delete(oldest);
		}
	}

	/** Deduplicates concurrent fetches (e.g. hover prefetch + click!) */
	async getOrFetch(key: string, fetcher: () => Promise<T | null>): Promise<T | null> {
		const hit = this.get(key);
		if (hit !== null) return hit;
		const existing = this.inflight.get(key);
		if (existing) return existing;
		const p = fetcher()
			.then((val) => {
				if (val !== null) this.set(key, val);
				return val;
			})
			.catch(() => null)
			.finally(() => {
				this.inflight.delete(key);
			});
		this.inflight.set(key, p);
		return p;
	}
}

import type {
	BlockLotsResponse,
	BlockTenantsResponse,
	BuildingDossier,
	LandlordXrayResponse,
	StreetViewAuditResult
} from '$lib/types';

export interface CachedFieldNote {
	bbl: string;
	verdictTag?: string;
	summary: string;
	citations: Array<{ title: string; url: string }>;
	webGrounded: boolean;
}

export interface CachedClusterBrief {
	summary: string;
	citations: Array<{ title: string; url: string }>;
}

export const buildingCache = new ClientCache<BuildingDossier>(1000 * 60 * 20, 120);
export const blockLotsClientCache = new ClientCache<BlockLotsResponse>(1000 * 60 * 30, 160);
export const blockTenantsClientCache = new ClientCache<BlockTenantsResponse>(1000 * 60 * 20, 160);
export const xrayClientCache = new ClientCache<LandlordXrayResponse>(1000 * 60 * 30, 120);
export const fieldNoteClientCache = new ClientCache<CachedFieldNote>(1000 * 60 * 30, 120);
export const visionAuditClientCache = new ClientCache<StreetViewAuditResult>(1000 * 60 * 30, 120);
export const clusterBriefClientCache = new ClientCache<CachedClusterBrief>(1000 * 60 * 30, 80);

export function warmBuilding(bbl: string, aliases?: string[]): void {
	const clean = (bbl || '').split('.')[0].trim();
	if (!/^[1-5]\d{9}$/.test(clean) || buildingCache.get(clean)) return;
	const cleanAliases = [
		...new Set(
			(aliases || [])
				.map((s) => (s || '').split('.')[0].trim())
				.filter((s) => /^[1-5]\d{9}$/.test(s) && s !== clean)
		)
	]
		.sort()
		.slice(0, 6);
	const url =
		`/api/building?bbl=${encodeURIComponent(clean)}` +
		(cleanAliases.length > 0 ? `&alias=${encodeURIComponent(cleanAliases.join(','))}` : '');
	void buildingCache.getOrFetch(clean, async () => {
		const res = await fetch(url, {
			priority: 'low' as RequestPriority
		});
		if (!res.ok) return null;
		return (await res.json()) as BuildingDossier;
	});
}

export function warmBlock(clusterId: string, segmentId: string): void {
	const key = `${clusterId}:${segmentId}`;
	if (!clusterId || !segmentId || blockLotsClientCache.get(key)) return;
	void blockLotsClientCache.getOrFetch(key, async () => {
		const res = await fetch(
			`/api/block-lots?cluster=${encodeURIComponent(clusterId)}&segment=${encodeURIComponent(segmentId)}`,
			{ priority: 'low' as RequestPriority }
		);
		if (!res.ok) return null;
		return (await res.json()) as BlockLotsResponse;
	});
}
