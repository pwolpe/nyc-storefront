import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Lightweight, privacy-first, viral-proof site analytics store.
 *
 * - Zero cookies, zero raw IP persistence. Visitors are counted using a daily
 *   salted HMAC hash of (IP + User-Agent).
 * - Exact Set counting up to EXACT_LIMIT unique visitors per bucket, seamlessly
 *   transitioning to a compact 2 KB HyperLogLog (2^11 = 2048 registers) if a
 *   day or all-time total ever spikes past 5,000 uniques (handles millions of
 *   visitors in constant memory & disk).
 * - Persists atomically to /data/analytics/traffic.json on Railway (derived
 *   from CACHE_DIR=/data/cache) or /tmp/nycstorefront-analytics locally.
 */

const EXACT_LIMIT = 5000;
const HLL_P = 11; // 2048 registers -> ~2.3% std error, 2 KB per counter
const HLL_M = 1 << HLL_P;
const HLL_ALPHA = 0.7213 / (1 + 1.079 / HLL_M);
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes for "Live right now"
const MAX_STORED_DAYS = 400;
const MAX_HOURLY_BUCKETS = 96; // keep last 4 days of hourly granularity
const MAX_KEYS_PER_MAP = 300;
const NYC_TZ = 'America/New_York';

// Bot / crawler / healthcheck filter (case-insensitive)
const BOT_RE =
	/bot\b|crawl|spider|slurp|mediapartners|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake|datadog|newrelic|facebookexternalhit|facebot|twitterbot|linkedinbot|discordbot|slackbot|whatsapp|telegrambot|applebot|bingpreview|bytespider|gptbot|claudebot|anthropic-ai|oai-searchbot|perplexitybot|ccbot|semrush|ahrefs|mj12bot|dotbot|yandex|baiduspider|duckduckbot|petalbot|sogou|exabot|ia_archiver|curl\/|wget\/|python-requests|python-urllib|go-http-client|axios\/|node-fetch|undici|postmanruntime|insomnia/i;

export interface HllSketch {
	exact?: string[]; // sorted/array of visitor hashes while <= EXACT_LIMIT
	hll?: string; // base64-encoded Uint8Array(2048) once > EXACT_LIMIT
}

export interface DayBucket {
	date: string; // YYYY-MM-DD in America/New_York
	pageviews: number;
	visitors: HllSketch;
	pages: Record<string, number>;
	referrers: Record<string, number>;
	sections: Record<string, number>;
	devices: { desktop: number; mobile: number; tablet: number };
	clusters: Record<string, number>;
	buildings: Record<string, number>;
}

export interface HourBucket {
	hour: string; // YYYY-MM-DDTHH in America/New_York
	pageviews: number;
	visitors: HllSketch;
}

export interface PersistedAnalytics {
	version: 1;
	salt: string;
	createdAt: string;
	totalPageviews: number;
	allTimeVisitors: HllSketch;
	pageTitles: Record<string, string>;
	days: Record<string, DayBucket>;
	hours: Record<string, HourBucket>;
}

export interface VisitInput {
	path: string;
	referrer?: string;
	title?: string;
	width?: number;
	ip: string;
	userAgent: string;
	host?: string;
	now?: Date;
}

export interface LiveVisitor {
	lastSeen: number;
	path: string;
	section: string;
	device: 'desktop' | 'mobile' | 'tablet';
}

export interface StatsRangeSummary {
	label: string;
	pageviews: number;
	visitors: number;
	pagesPerVisitor: number;
	sections: Record<string, number>;
	devices: { desktop: number; mobile: number; tablet: number };
	topPages: Array<{ path: string; title: string; views: number }>;
	topReferrers: Array<{ source: string; views: number }>;
	topClusters: Array<{ id: string; views: number }>;
	topBuildings: Array<{ path: string; label: string; views: number }>;
}

export interface StatsSnapshot {
	generatedAt: string;
	trackingSince: string;
	todayDate: string;
	liveCount: number;
	livePages: Array<{ path: string; title: string; count: number }>;
	today: StatsRangeSummary;
	yesterdayVisitors: number;
	yesterdayPageviews: number;
	last7d: StatsRangeSummary;
	last30d: StatsRangeSummary;
	allTime: StatsRangeSummary;
	peakDay: { date: string; visitors: number; pageviews: number } | null;
	peakHour48h: { hour: string; visitors: number; pageviews: number } | null;
	hourly48: Array<{ hour: string; label: string; pageviews: number; visitors: number }>;
	daily30: Array<{ date: string; label: string; pageviews: number; visitors: number }>;
}

// ---------- Compact HyperLogLog helpers ----------

function emptySketch(): HllSketch {
	return { exact: [] };
}

function hash64Bits(input: string): { idx: number; rho: number } {
	const digest = createHash('sha256').update(input).digest();
	// Use first 64 bits (8 bytes): top HLL_P (11) bits = register index, remaining 53 bits = leading zeros + 1
	const hi = digest.readUInt32BE(0);
	const lo = digest.readUInt32BE(4);
	const idx = hi >>> (32 - HLL_P);
	// Remaining 21 bits of hi + 32 bits of lo = 53 bits
	const remHi = (hi << HLL_P) >>> 0; // top 21 bits hold remaining bits, bottom 11 are 0
	let leadingZeros = 0;
	if (remHi !== 0) {
		leadingZeros = Math.clz32(remHi);
	} else if (lo !== 0) {
		leadingZeros = 21 + Math.clz32(lo);
	} else {
		leadingZeros = 53;
	}
	const rho = Math.min(54, leadingZeros + 1);
	return { idx, rho };
}

function decodeHll(b64: string): Uint8Array {
	const buf = Buffer.from(b64, 'base64');
	if (buf.length === HLL_M) return new Uint8Array(buf.buffer, buf.byteOffset, HLL_M);
	const out = new Uint8Array(HLL_M);
	out.set(buf.subarray(0, HLL_M));
	return out;
}

function addHllRegister(regs: Uint8Array, id: string): void {
	const { idx, rho } = hash64Bits(id);
	if (rho > regs[idx]) regs[idx] = rho;
}

export function addToSketch(sketch: HllSketch, id: string): void {
	if (sketch.hll) {
		const regs = decodeHll(sketch.hll);
		addHllRegister(regs, id);
		sketch.hll = Buffer.from(regs).toString('base64');
		return;
	}
	if (!sketch.exact) sketch.exact = [];
	if (sketch.exact.includes(id)) return;
	if (sketch.exact.length < EXACT_LIMIT) {
		sketch.exact.push(id);
		return;
	}
	// Promote exact Set -> HyperLogLog once bucket exceeds EXACT_LIMIT
	const regs = new Uint8Array(HLL_M);
	for (const existing of sketch.exact) addHllRegister(regs, existing);
	addHllRegister(regs, id);
	delete sketch.exact;
	sketch.hll = Buffer.from(regs).toString('base64');
}

export function estimateSketch(sketch: HllSketch | undefined): number {
	if (!sketch) return 0;
	if (sketch.exact) return sketch.exact.length;
	if (!sketch.hll) return 0;
	return estimateRegs(decodeHll(sketch.hll));
}

function estimateRegs(regs: Uint8Array): number {
	let sum = 0;
	let zeros = 0;
	for (let i = 0; i < HLL_M; i++) {
		const v = regs[i];
		sum += Math.pow(2, -v);
		if (v === 0) zeros++;
	}
	let est = (HLL_ALPHA * HLL_M * HLL_M) / sum;
	if (est <= 2.5 * HLL_M && zeros > 0) {
		// Small-range linear counting correction
		est = HLL_M * Math.log(HLL_M / zeros);
	}
	return Math.round(est);
}

/** Merge multiple day sketches (for 7d / 30d unique estimates). */
export function unionSketchEstimate(sketches: HllSketch[]): number {
	if (sketches.length === 0) return 0;
	if (sketches.length === 1) return estimateSketch(sketches[0]);

	// If all sketches are still exact and small enough, do exact union!
	const allExact = sketches.every((s) => Array.isArray(s.exact) && !s.hll);
	if (allExact) {
		const set = new Set<string>();
		let overflow = false;
		for (const s of sketches) {
			for (const id of s.exact ?? []) {
				set.add(id);
				if (set.size > EXACT_LIMIT * 2) {
					overflow = true;
					break;
				}
			}
			if (overflow) break;
		}
		if (!overflow) return set.size;
	}

	const merged = new Uint8Array(HLL_M);
	for (const s of sketches) {
		if (s.hll) {
			const regs = decodeHll(s.hll);
			for (let i = 0; i < HLL_M; i++) {
				if (regs[i] > merged[i]) merged[i] = regs[i];
			}
		} else if (s.exact) {
			for (const id of s.exact) addHllRegister(merged, id);
		}
	}
	return estimateRegs(merged);
}

// ---------- Normalization helpers ----------

export function isBotUserAgent(ua: string): boolean {
	if (!ua || ua.trim().length < 8) return true;
	return BOT_RE.test(ua);
}

export function sanitizePath(rawPath: string): string | null {
	if (!rawPath || typeof rawPath !== 'string') return null;
	let p = rawPath.trim();
	const q = p.indexOf('?');
	if (q !== -1) p = p.slice(0, q);
	const h = p.indexOf('#');
	if (h !== -1) p = p.slice(0, h);
	if (!p.startsWith('/')) return null;
	if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
	if (p.length > 160) p = p.slice(0, 160);
	if (
		p.startsWith('/api') ||
		p.startsWith('/stats') ||
		p.startsWith('/health') ||
		p.startsWith('/_app') ||
		p.startsWith('/data/') ||
		p.startsWith('/art/')
	) {
		return null;
	}
	return p;
}

export function classifyPath(path: string): {
	section: string;
	clusterId: string | null;
	isBuilding: boolean;
} {
	if (path === '/') return { section: 'City Map', clusterId: null, isBuilding: false };
	if (path === '/trends') return { section: 'Trends', clusterId: null, isBuilding: false };
	if (path === '/about') return { section: 'About', clusterId: null, isBuilding: false };
	const buildingMatch = path.match(/^\/cluster\/([^/]+)\/block\/([^/]+)\/building\/([^/]+)/);
	if (buildingMatch) {
		return { section: 'Buildings', clusterId: buildingMatch[1], isBuilding: true };
	}
	const blockMatch = path.match(/^\/cluster\/([^/]+)\/block\/([^/]+)/);
	if (blockMatch) {
		return { section: 'Blocks', clusterId: blockMatch[1], isBuilding: false };
	}
	const clusterMatch = path.match(/^\/cluster\/([^/]+)/);
	if (clusterMatch) {
		return { section: 'Clusters', clusterId: clusterMatch[1], isBuilding: false };
	}
	return { section: 'Other', clusterId: null, isBuilding: false };
}

export function normalizeReferrer(rawRef: string | undefined, ownHost?: string): string {
	if (!rawRef || typeof rawRef !== 'string') return 'Direct / Share';
	const trimmed = rawRef.trim();
	if (!trimmed) return 'Direct / Share';
	let host = '';
	try {
		const u = new URL(trimmed);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Direct / Share';
		host = u.hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return 'Direct / Share';
	}
	if (!host) return 'Direct / Share';
	const cleanOwn = (ownHost || '').toLowerCase().split(':')[0].replace(/^www\./, '');
	if (
		host === 'nycstorefront.com' ||
		host === 'localhost' ||
		host === '127.0.0.1' ||
		(cleanOwn && host === cleanOwn)
	) {
		return '__self__';
	}

	if (host === 't.co' || host === 'x.com' || host === 'twitter.com' || host.endsWith('.twitter.com')) {
		return 'X / Twitter';
	}
	if (host === 'news.ycombinator.com') return 'Hacker News';
	if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') return 'Reddit';
	if (host === 'bsky.app' || host.endsWith('.bsky.app')) return 'Bluesky';
	if (host === 'threads.net' || host.endsWith('.threads.net')) return 'Threads';
	if (host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in') return 'LinkedIn';
	if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com') return 'Facebook';
	if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'Instagram';
	if (host === 'substack.com' || host.endsWith('.substack.com')) return 'Substack';
	if (host === 'github.com' || host.endsWith('.github.com')) return 'GitHub';
	if (host === 'comptroller.nyc.gov' || host.endsWith('.nyc.gov')) return 'NYC.gov';
	if (host === 'google.com' || host.startsWith('google.') || host.endsWith('.google.com')) {
		return 'Google';
	}
	if (host === 'bing.com' || host.endsWith('.bing.com')) return 'Bing';
	if (host === 'duckduckgo.com') return 'DuckDuckGo';
	if (host === 'search.brave.com') return 'Brave Search';
	if (host === 'kagi.com') return 'Kagi';
	if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return 'Perplexity';
	if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'ChatGPT';
	if (host === 'claude.ai') return 'Claude';
	if (host === 'nyc.streetsblog.org' || host.endsWith('streetsblog.org')) return 'Streetsblog';
	if (host === 'hellgatenyc.com') return 'Hell Gate';
	if (host === 'gothamist.com') return 'Gothamist';
	if (host === 'nytimes.com' || host.endsWith('.nytimes.com')) return 'NY Times';
	if (host === 'curbed.com' || host === 'nymag.com') return 'Curbed / NYMag';
	if (host === 'thecity.nyc') return 'THE CITY';
	return host.slice(0, 48);
}

function detectDevice(ua: string, width?: number): 'desktop' | 'mobile' | 'tablet' {
	if (/ipad|tablet|playbook|silk/i.test(ua)) return 'tablet';
	if (/mobi|iphone|ipod|android.*mobile/i.test(ua)) return 'mobile';
	if (typeof width === 'number' && width > 0) {
		if (width < 640) return 'mobile';
		if (width < 1024 && /android/i.test(ua)) return 'tablet';
	}
	return 'desktop';
}

function formatNyParts(date: Date): { day: string; hour: string } {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: NYC_TZ,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		hourCycle: 'h23'
	});
	const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
	const hr = parts.hour === '24' ? '00' : parts.hour;
	const day = `${parts.year}-${parts.month}-${parts.day}`;
	return { day, hour: `${day}T${hr}` };
}

function formatHourLabel(hourKey: string): string {
	// hourKey: YYYY-MM-DDTHH
	const [datePart, hrStr] = hourKey.split('T');
	const hr = Number(hrStr);
	const ampm = hr >= 12 ? 'p' : 'a';
	const h12 = hr % 12 === 0 ? 12 : hr % 12;
	const [, m, d] = datePart.split('-');
	return `${Number(m)}/${Number(d)} ${h12}${ampm}`;
}

function formatDayLabel(dayKey: string): string {
	const [, m, d] = dayKey.split('-');
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${months[Number(m) - 1] || m} ${Number(d)}`;
}

function cleanTitle(rawTitle: string | undefined): string {
	if (!rawTitle || typeof rawTitle !== 'string') return '';
	return rawTitle
		.replace(/\s*\|\s*NYC Storefront Vacancy\s*$/i, '')
		.replace(/\s*—\s*NYC Storefront Vacancy\s*$/i, '')
		.trim()
		.slice(0, 90);
}

function incrementCapped(map: Record<string, number>, key: string, maxKeys = MAX_KEYS_PER_MAP): void {
	if (Object.prototype.hasOwnProperty.call(map, key)) {
		map[key] += 1;
		return;
	}
	if (Object.keys(map).length >= maxKeys) {
		map['(other)'] = (map['(other)'] || 0) + 1;
		return;
	}
	map[key] = 1;
}

// ---------- Store Class ----------

export class AnalyticsStore {
	private data: PersistedAnalytics;
	private filePath: string | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	private live = new Map<string, LiveVisitor>();

	constructor(analyticsDir?: string) {
		const dir =
			analyticsDir ??
			process.env.ANALYTICS_DIR ??
			(process.env.CACHE_DIR
				? join(dirname(process.env.CACHE_DIR), 'analytics')
				: '/tmp/nycstorefront-analytics');

		let loaded: PersistedAnalytics | null = null;
		try {
			mkdirSync(dir, { recursive: true });
			this.filePath = join(dir, 'traffic.json');
			const raw = readFileSync(this.filePath, 'utf8');
			const parsed = JSON.parse(raw) as PersistedAnalytics;
			if (parsed && parsed.version === 1 && parsed.days && parsed.hours) {
				loaded = parsed;
			}
		} catch {
			// Fresh start or read-only runtime
		}

		this.data = loaded ?? {
			version: 1,
			salt: randomBytes(24).toString('hex'),
			createdAt: new Date().toISOString(),
			totalPageviews: 0,
			allTimeVisitors: emptySketch(),
			pageTitles: {},
			days: {},
			hours: {}
		};
	}

	record(input: VisitInput): boolean {
		if (isBotUserAgent(input.userAgent)) return false;
		const path = sanitizePath(input.path);
		if (!path) return false;

		const now = input.now ?? new Date();
		const nowMs = now.getTime();
		const { day, hour } = formatNyParts(now);

		// Anonymous privacy-preserving hash (never stores raw IP; consistent across days so 7d/30d/all-time dedupe cleanly)
		const ipUa = `${input.ip || 'unknown'}|${input.userAgent.slice(0, 160)}`;
		const visitorHash = createHmac('sha256', this.data.salt)
			.update(`v1|${ipUa}`)
			.digest('base64url')
			.slice(0, 14);

		const { section, clusterId, isBuilding } = classifyPath(path);
		const device = detectDevice(input.userAgent, input.width);
		const ref = normalizeReferrer(input.referrer, input.host);

		// Update live active visitors map
		this.live.set(visitorHash, { lastSeen: nowMs, path, section, device });
		if (this.live.size > 5000) this.pruneLive(nowMs);

		// Ensure day bucket
		let dayBucket = this.data.days[day];
		if (!dayBucket) {
			dayBucket = {
				date: day,
				pageviews: 0,
				visitors: emptySketch(),
				pages: {},
				referrers: {},
				sections: {},
				devices: { desktop: 0, mobile: 0, tablet: 0 },
				clusters: {},
				buildings: {}
			};
			this.data.days[day] = dayBucket;
		}

		// Ensure hour bucket
		let hourBucket = this.data.hours[hour];
		if (!hourBucket) {
			hourBucket = {
				hour,
				pageviews: 0,
				visitors: emptySketch()
			};
			this.data.hours[hour] = hourBucket;
		}

		// Increment counters
		this.data.totalPageviews += 1;
		addToSketch(this.data.allTimeVisitors, visitorHash);

		dayBucket.pageviews += 1;
		addToSketch(dayBucket.visitors, visitorHash);
		incrementCapped(dayBucket.pages, path);
		if (ref !== '__self__') {
			incrementCapped(dayBucket.referrers, ref, 150);
		}
		dayBucket.sections[section] = (dayBucket.sections[section] || 0) + 1;
		dayBucket.devices[device] += 1;
		if (clusterId) {
			incrementCapped(dayBucket.clusters, clusterId, 400);
		}
		if (isBuilding) {
			incrementCapped(dayBucket.buildings, path, 200);
		}

		hourBucket.pageviews += 1;
		addToSketch(hourBucket.visitors, visitorHash);

		const title = cleanTitle(input.title);
		if (title && path !== '/' && Object.keys(this.data.pageTitles).length < 2000) {
			this.data.pageTitles[path] = title;
		} else if (title && this.data.pageTitles[path]) {
			this.data.pageTitles[path] = title;
		}

		this.pruneOldBuckets();
		this.scheduleSave();
		return true;
	}

	private pruneLive(nowMs: number): void {
		const cutoff = nowMs - ACTIVE_WINDOW_MS;
		for (const [k, v] of this.live.entries()) {
			if (v.lastSeen < cutoff) this.live.delete(k);
		}
	}

	private pruneOldBuckets(): void {
		const hourKeys = Object.keys(this.data.hours);
		if (hourKeys.length > MAX_HOURLY_BUCKETS) {
			hourKeys.sort();
			for (const k of hourKeys.slice(0, hourKeys.length - MAX_HOURLY_BUCKETS)) {
				delete this.data.hours[k];
			}
		}
		const dayKeys = Object.keys(this.data.days);
		if (dayKeys.length > MAX_STORED_DAYS) {
			dayKeys.sort();
			for (const k of dayKeys.slice(0, dayKeys.length - MAX_STORED_DAYS)) {
				delete this.data.days[k];
			}
		}
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (!this.filePath || this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.flush();
		}, 5000);
	}

	flush(): void {
		if (!this.dirty || !this.filePath) return;
		this.dirty = false;
		try {
			const tmpPath = `${this.filePath}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(this.data), 'utf8');
			renameSync(tmpPath, this.filePath);
		} catch {
			// Non-fatal; keep running in memory
		}
	}

	getSnapshot(now = new Date()): StatsSnapshot {
		const nowMs = now.getTime();
		this.pruneLive(nowMs);

		const { day: todayDate } = formatNyParts(now);

		// Build continuous 48-hour series in NY timezone
		const hourly48: Array<{ hour: string; label: string; pageviews: number; visitors: number }> = [];
		const seenHours = new Set<string>();
		for (let i = 47; i >= 0; i--) {
			const dt = new Date(nowMs - i * 3600 * 1000);
			const { hour } = formatNyParts(dt);
			if (seenHours.has(hour)) continue;
			seenHours.add(hour);
			const bucket = this.data.hours[hour];
			hourly48.push({
				hour,
				label: formatHourLabel(hour),
				pageviews: bucket?.pageviews ?? 0,
				visitors: estimateSketch(bucket?.visitors)
			});
		}

		// Build continuous 30-day series in NY timezone
		const daily30: Array<{ date: string; label: string; pageviews: number; visitors: number }> = [];
		const last7Keys: string[] = [];
		const last30Keys: string[] = [];
		const seenDays = new Set<string>();
		for (let i = 29; i >= 0; i--) {
			const dt = new Date(nowMs - i * 86400 * 1000);
			const { day } = formatNyParts(dt);
			if (seenDays.has(day)) continue;
			seenDays.add(day);
			last30Keys.push(day);
			if (i < 7) last7Keys.push(day);
			const bucket = this.data.days[day];
			daily30.push({
				date: day,
				label: formatDayLabel(day),
				pageviews: bucket?.pageviews ?? 0,
				visitors: estimateSketch(bucket?.visitors)
			});
		}

		const yesterdayDate = daily30.length >= 2 ? daily30[daily30.length - 2].date : '';
		const yesterdayBucket = yesterdayDate ? this.data.days[yesterdayDate] : undefined;

		// Aggregate live pages
		const liveByPath = new Map<string, number>();
		for (const v of this.live.values()) {
			liveByPath.set(v.path, (liveByPath.get(v.path) || 0) + 1);
		}
		const livePages = Array.from(liveByPath.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([path, count]) => ({
				path,
				title: this.data.pageTitles[path] || (path === '/' ? 'NYC City Map' : path),
				count
			}));

		// Peak day across all stored days
		let peakDay: { date: string; visitors: number; pageviews: number } | null = null;
		for (const bucket of Object.values(this.data.days)) {
			const visitors = estimateSketch(bucket.visitors);
			if (
				!peakDay ||
				visitors > peakDay.visitors ||
				(visitors === peakDay.visitors && bucket.pageviews > peakDay.pageviews)
			) {
				if (bucket.pageviews > 0) {
					peakDay = { date: bucket.date, visitors, pageviews: bucket.pageviews };
				}
			}
		}

		// Peak hour in last 48h
		let peakHour48h: { hour: string; visitors: number; pageviews: number } | null = null;
		for (const h of hourly48) {
			if (
				h.pageviews > 0 &&
				(!peakHour48h ||
					h.visitors > peakHour48h.visitors ||
					(h.visitors === peakHour48h.visitors && h.pageviews > peakHour48h.pageviews))
			) {
				peakHour48h = { hour: h.hour, visitors: h.visitors, pageviews: h.pageviews };
			}
		}

		const allDayKeys = Object.keys(this.data.days);

		return {
			generatedAt: now.toISOString(),
			trackingSince: this.data.createdAt,
			todayDate,
			liveCount: this.live.size,
			livePages,
			today: this.summarizeDays('Today', [todayDate]),
			yesterdayVisitors: estimateSketch(yesterdayBucket?.visitors),
			yesterdayPageviews: yesterdayBucket?.pageviews ?? 0,
			last7d: this.summarizeDays('Last 7 Days', last7Keys),
			last30d: this.summarizeDays('Last 30 Days', last30Keys),
			allTime: this.summarizeDays('All Time', allDayKeys, {
				pageviews: this.data.totalPageviews,
				visitors: estimateSketch(this.data.allTimeVisitors)
			}),
			peakDay,
			peakHour48h,
			hourly48,
			daily30
		};
	}

	private summarizeDays(
		label: string,
		dayKeys: string[],
		overrideTotals?: { pageviews: number; visitors: number }
	): StatsRangeSummary {
		let pageviews = 0;
		const sketches: HllSketch[] = [];
		const pages: Record<string, number> = {};
		const referrers: Record<string, number> = {};
		const sections: Record<string, number> = {};
		const devices = { desktop: 0, mobile: 0, tablet: 0 };
		const clusters: Record<string, number> = {};
		const buildings: Record<string, number> = {};

		for (const dk of dayKeys) {
			const b = this.data.days[dk];
			if (!b) continue;
			pageviews += b.pageviews;
			sketches.push(b.visitors);
			for (const [k, v] of Object.entries(b.pages)) pages[k] = (pages[k] || 0) + v;
			for (const [k, v] of Object.entries(b.referrers)) referrers[k] = (referrers[k] || 0) + v;
			for (const [k, v] of Object.entries(b.sections)) sections[k] = (sections[k] || 0) + v;
			devices.desktop += b.devices.desktop || 0;
			devices.mobile += b.devices.mobile || 0;
			devices.tablet += b.devices.tablet || 0;
			for (const [k, v] of Object.entries(b.clusters)) clusters[k] = (clusters[k] || 0) + v;
			for (const [k, v] of Object.entries(b.buildings)) buildings[k] = (buildings[k] || 0) + v;
		}

		const finalPageviews = overrideTotals ? Math.max(pageviews, overrideTotals.pageviews) : pageviews;
		const visitors = overrideTotals
			? overrideTotals.visitors
			: dayKeys.length === 1
				? estimateSketch(sketches[0])
				: unionSketchEstimate(sketches);

		const topPages = Object.entries(pages)
			.filter(([k]) => k !== '(other)')
			.sort((a, b) => b[1] - a[1])
			.slice(0, 15)
			.map(([path, views]) => ({
				path,
				title: this.data.pageTitles[path] || (path === '/' ? 'NYC City Map' : path),
				views
			}));

		const topReferrers = Object.entries(referrers)
			.filter(([k]) => k !== '(other)')
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([source, views]) => ({ source, views }));

		const topClusters = Object.entries(clusters)
			.filter(([k]) => k !== '(other)')
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([id, views]) => ({ id, views }));

		const topBuildings = Object.entries(buildings)
			.filter(([k]) => k !== '(other)')
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([path, views]) => ({
				path,
				label: this.data.pageTitles[path] || path.split('/').pop() || path,
				views
			}));

		return {
			label,
			pageviews: finalPageviews,
			visitors,
			pagesPerVisitor: visitors > 0 ? Math.round((finalPageviews / visitors) * 10) / 10 : 0,
			sections,
			devices,
			topPages,
			topReferrers,
			topClusters,
			topBuildings
		};
	}
}

// Singleton store shared across requests, flushed cleanly on container shutdown
let singleton: AnalyticsStore | null = null;
let shutdownHooked = false;

export function getAnalyticsStore(): AnalyticsStore {
	if (!singleton) {
		singleton = new AnalyticsStore();
		if (!shutdownHooked && typeof process !== 'undefined' && process.on) {
			shutdownHooked = true;
			const onExit = () => singleton?.flush();
			process.on('SIGTERM', onExit);
			process.on('SIGINT', onExit);
			process.on('beforeExit', onExit);
		}
	}
	return singleton;
}
