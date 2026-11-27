import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CacheEntry<T> {
	at: number;
	data: T;
}

/**
 * Bounded LRU in-memory cache with Stale-While-Revalidate (SWR) & JSON disk persistence.
 * On Railway, mount a Volume at /data/cache and set CACHE_DIR=/data/cache so every
 * visited block, building, Landlord X-Ray, Vision Audit, and AI Field Note survives deploys
 * and returns in <45ms forever, quietly refreshing in the background once stale.
 */
export class PersistentCache<T> {
	private map = new Map<string, CacheEntry<T>>();
	private filePath: string | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private refreshing = new Set<string>();

	constructor(
		private readonly name: string,
		private readonly freshMs: number,
		private readonly maxEntries = 1500,
		private readonly maxStaleMs = 1000 * 60 * 60 * 24 * 30 // serve stale up to 30 days while revalidating
	) {
		try {
			const dir = process.env.CACHE_DIR || '/tmp/nycstorefront-cache';
			mkdirSync(dir, { recursive: true });
			this.filePath = join(dir, `${this.name}.json`);
			const raw = readFileSync(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as Record<string, CacheEntry<T>>;
			const now = Date.now();
			for (const [k, v] of Object.entries(parsed)) {
				if (v && typeof v.at === 'number' && now - v.at < this.maxStaleMs) {
					this.map.set(k, v);
				}
			}
		} catch {
			// Fresh cache or read-only runtime — operate cleanly in memory
		}
	}

	/**
	 * Returns cached value immediately if within freshMs (or within maxStaleMs when stale).
	 * Callers can inspect `stale` to trigger non-blocking background refresh via `revalidate()`.
	 */
	getWithStatus(key: string): { data: T; stale: boolean } | null {
		const hit = this.map.get(key);
		if (!hit) return null;
		const age = Date.now() - hit.at;
		if (age >= this.maxStaleMs) {
			this.map.delete(key);
			return null;
		}
		// Refresh LRU recency
		this.map.delete(key);
		this.map.set(key, hit);
		return { data: hit.data, stale: age >= this.freshMs };
	}

	get(key: string): T | null {
		const res = this.getWithStatus(key);
		return res && !res.stale ? res.data : null;
	}

	/** Deduplicated non-blocking background refresh for stale-while-revalidate. */
	revalidate(key: string, loader: () => Promise<T | null>): void {
		if (this.refreshing.has(key)) return;
		this.refreshing.add(key);
		loader()
			.then((fresh) => {
				if (fresh !== null) this.set(key, fresh);
			})
			.catch(() => {})
			.finally(() => {
				this.refreshing.delete(key);
			});
	}

	set(key: string, data: T): void {
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, { at: Date.now(), data });
		while (this.map.size > this.maxEntries) {
			const oldestKey = this.map.keys().next().value;
			if (oldestKey === undefined) break;
			this.map.delete(oldestKey);
		}
		this.schedulePersist();
	}

	private schedulePersist(): void {
		if (!this.filePath || this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			if (!this.filePath) return;
			try {
				const obj: Record<string, CacheEntry<T>> = {};
				const now = Date.now();
				for (const [k, v] of this.map.entries()) {
					if (now - v.at < this.maxStaleMs) obj[k] = v;
				}
				writeFileSync(this.filePath, JSON.stringify(obj), 'utf8');
			} catch {
				// Non-fatal
			}
		}, 1500);
	}
}
