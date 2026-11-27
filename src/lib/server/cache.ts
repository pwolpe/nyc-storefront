import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CacheEntry<T> {
	at: number;
	data: T;
}

/**
 * Bounded LRU in-memory cache with optional JSON disk backing.
 * On Railway, set CACHE_DIR (e.g. /data/cache on a Volume) so AI Field Notes,
 * Vision Audits, and Cluster Takeaways survive restarts and cost $0 on repeat hits.
 */
export class PersistentCache<T> {
	private map = new Map<string, CacheEntry<T>>();
	private filePath: string | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly name: string,
		private readonly ttlMs: number,
		private readonly maxEntries = 1000
	) {
		try {
			const dir = process.env.CACHE_DIR || '/tmp/nycstorefront-cache';
			mkdirSync(dir, { recursive: true });
			this.filePath = join(dir, `${this.name}.json`);
			const raw = readFileSync(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as Record<string, CacheEntry<T>>;
			const now = Date.now();
			for (const [k, v] of Object.entries(parsed)) {
				if (v && typeof v.at === 'number' && now - v.at < this.ttlMs) {
					this.map.set(k, v);
				}
			}
		} catch {
			// Fresh cache or read-only runtime — operate cleanly in memory
		}
	}

	get(key: string): T | null {
		const hit = this.map.get(key);
		if (!hit) return null;
		if (Date.now() - hit.at >= this.ttlMs) {
			this.map.delete(key);
			return null;
		}
		// Refresh LRU recency
		this.map.delete(key);
		this.map.set(key, hit);
		return hit.data;
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
					if (now - v.at < this.ttlMs) obj[k] = v;
				}
				writeFileSync(this.filePath, JSON.stringify(obj), 'utf8');
			} catch {
				// Non-fatal
			}
		}, 1500);
	}
}
