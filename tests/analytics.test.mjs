import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	AnalyticsStore,
	addToSketch,
	classifyPath,
	estimateSketch,
	isBotUserAgent,
	normalizeReferrer,
	sanitizePath
} from '../src/lib/server/analytics.ts';

test('bot user-agent filter catches crawlers and allows real browsers', () => {
	assert.equal(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
	assert.equal(isBotUserAgent('curl/8.7.1'), true);
	assert.equal(isBotUserAgent(''), true);
	assert.equal(
		isBotUserAgent(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
		),
		false
	);
	assert.equal(
		isBotUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
		),
		false
	);
});

test('referrer normalization groups social, search, and ignores self', () => {
	assert.equal(normalizeReferrer('https://t.co/abc123', 'nycstorefront.com'), 'X / Twitter');
	assert.equal(normalizeReferrer('https://news.ycombinator.com/item?id=123'), 'Hacker News');
	assert.equal(normalizeReferrer('https://old.reddit.com/r/nyc/comments/xyz'), 'Reddit');
	assert.equal(normalizeReferrer('https://bsky.app/profile/someone'), 'Bluesky');
	assert.equal(normalizeReferrer('https://comptroller.nyc.gov/reports/'), 'NYC.gov');
	assert.equal(normalizeReferrer('https://nycstorefront.com/trends', 'nycstorefront.com'), '__self__');
	assert.equal(normalizeReferrer(''), 'Direct / Share');
});

test('path sanitization & classification filters internal routes and extracts clusters', () => {
	assert.equal(sanitizePath('/stats'), null);
	assert.equal(sanitizePath('/api/v'), null);
	assert.equal(sanitizePath('/health'), null);
	assert.equal(sanitizePath('/cluster/c-102/?foo=1#bar'), '/cluster/c-102');

	assert.deepEqual(classifyPath('/'), { section: 'City Map', clusterId: null, isBuilding: false });
	assert.deepEqual(classifyPath('/cluster/c-102'), {
		section: 'Clusters',
		clusterId: 'c-102',
		isBuilding: false
	});
	assert.deepEqual(classifyPath('/cluster/c-4/block/seg-75586/building/1007297508'), {
		section: 'Buildings',
		clusterId: 'c-4',
		isBuilding: true
	});
});

test('HyperLogLog promotes seamlessly past 5,000 uniques and stays accurate at viral scale', () => {
	const sketch = { exact: [] };
	const N = 12000;
	for (let i = 0; i < N; i++) {
		addToSketch(sketch, `visitor-${i}`);
	}
	assert.equal(sketch.exact, undefined, 'should promote from exact array to compact HLL');
	assert.ok(sketch.hll && sketch.hll.length < 3000, 'HLL representation should stay under 3 KB');
	const est = estimateSketch(sketch);
	const relErr = Math.abs(est - N) / N;
	assert.ok(relErr < 0.06, `expected HLL estimate near ${N}, got ${est} (err ${(relErr * 100).toFixed(2)}%)`);
});

test('AnalyticsStore tracks unique visitors, dedupes across days, and persists atomically to disk', () => {
	const dir = mkdtempSync(join(tmpdir(), 'nyc-sf-analytics-test-'));
	try {
		const store = new AnalyticsStore(dir);
		const browserUa =
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
		const mobileUa =
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';

		const day1 = new Date('2026-11-26T18:00:00Z');
		const day2 = new Date('2026-11-27T16:00:00Z');

		// Visitor A visits map & cluster on Day 1, and returns on Day 2
		assert.equal(
			store.record({
				path: '/',
				referrer: 'https://t.co/viral',
				ip: '203.0.113.10',
				userAgent: browserUa,
				width: 1440,
				now: day1
			}),
			true
		);
		assert.equal(
			store.record({
				path: '/cluster/c-102',
				title: 'Chelsea-Hudson Yards | NYC Storefront Vacancy',
				ip: '203.0.113.10',
				userAgent: browserUa,
				width: 1440,
				now: day1
			}),
			true
		);
		assert.equal(
			store.record({
				path: '/cluster/c-4/block/seg-75586/building/1007297508',
				title: '424 West 33 Street | NYC Storefront Vacancy',
				ip: '203.0.113.10',
				userAgent: browserUa,
				width: 1440,
				now: day2
			}),
			true
		);

		// Visitor B visits on mobile on Day 2
		assert.equal(
			store.record({
				path: '/',
				referrer: 'https://news.ycombinator.com/item?id=999',
				ip: '203.0.113.22',
				userAgent: mobileUa,
				width: 390,
				now: day2
			}),
			true
		);

		// Bot visit should be ignored
		assert.equal(
			store.record({
				path: '/',
				ip: '198.51.100.1',
				userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
				now: day2
			}),
			false
		);

		store.flush();

		// Reload from disk into a fresh store instance
		const reloaded = new AnalyticsStore(dir);
		const snap = reloaded.getSnapshot(day2);

		assert.equal(snap.today.visitors, 2);
		assert.equal(snap.today.pageviews, 2);
		assert.equal(snap.yesterdayVisitors, 1);
		assert.equal(snap.last7d.visitors, 2, 'returning visitor across days dedupes cleanly');
		assert.equal(snap.allTime.visitors, 2);
		assert.equal(snap.allTime.pageviews, 4);
		assert.equal(snap.allTime.devices.desktop, 3);
		assert.equal(snap.allTime.devices.mobile, 1);
		assert.equal(snap.allTime.topClusters[0].id, 'c-102');
		assert.equal(snap.allTime.topBuildings[0].label, '424 West 33 Street');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
