import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'static', 'data');
const SHARD_DIR = path.join(DATA_DIR, 'clusters');
const ART_DIR = path.resolve(import.meta.dirname, '..', 'static', 'art');

describe('Gates Down NYC — 3-Level City → Straightened Cluster Grid → IRL Block Tie-Out', () => {
	const clustersFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'nyc-clusters.json'), 'utf8'));

	it('partitions NYC into street-aligned clickable clusters with tied-out counts', () => {
		assert.ok(clustersFile.meta.totalStorefronts > 60000);
		assert.ok(clustersFile.meta.clusterCount >= 250);
		assert.ok(clustersFile.meta.segmentCount >= 10000);
		assert.ok(clustersFile.meta.dividingSegmentCount >= 400);

		for (const f of clustersFile.clusters.features) {
			const p = f.properties;
			const computed = p.vacant_storefronts / p.total_storefronts;
			assert.ok(Math.abs(computed - p.vacancy_rate) < 0.002, `Rate mismatch in ${p.id}`);
			assert.ok(p.borders && p.borders.summary.length > 0, `Missing street borders on ${p.id}`);
			assert.ok(Array.isArray(p.edge_labels) && p.edge_labels.length >= 2, `Missing edge_labels on ${p.id}`);
		}
	});

	it('generates straightened-grid shards with 1-block segments, context streets, and prev/next navigation', () => {
		const chelseaFeature = clustersFile.clusters.features.find(
			(f) => f.properties.name.includes('Chelsea') && f.properties.top_streets.includes('8th Ave') && f.properties.top_streets.includes('7th Ave')
		);
		assert.ok(chelseaFeature, 'Expected Chelsea 7th/8th Ave cluster');
		const shard = JSON.parse(
			fs.readFileSync(path.join(SHARD_DIR, `${chelseaFeature.properties.id}.json`), 'utf8')
		);

		assert.equal(shard.gridAngleDeg, 28.9, 'Manhattan grid angle should straighten +28.9° CCW');
		assert.ok(Array.isArray(shard.tractRates) && shard.tractRates.length >= 4, 'Expected constituent tractRates');
		assert.ok(Array.isArray(shard.cluster.block_dist) && shard.cluster.block_dist.length === 4, 'Expected 4-bucket block_dist');
		assert.equal(
			shard.cluster.block_dist.reduce((a, b) => a + b, 0),
			shard.segments.length,
			'block_dist buckets should sum to segment count'
		);
		assert.ok(shard.streetsList.length >= 15);
		assert.ok(shard.segments.length >= 80);
		assert.ok(shard.contextLines.length >= 30, 'Expected quiet residential context streets');

		// W 15th St (7th - 8th Ave) should have N/S side labels, BBLs, and adjacent block links
		const w15Blk = shard.segments.find(
			(s) => s.streetName === 'W 15th St' && s.between.includes('7th') && s.between.includes('8th')
		);
		assert.ok(w15Blk, 'Expected W 15th St 7th–8th Ave 1-block segment');
		const detail = shard.segmentDetails[w15Blk.id];
		assert.ok(detail, 'Expected segmentDetail for W 15th St 7th–8th Ave');
		assert.deepEqual(detail.sideLabels, ['North', 'South']);
		assert.equal(detail.storefronts.length, detail.total);
		assert.ok(detail.storefronts.every((sf) => sf.bbl && sf.bbl.length === 10), 'Expected 10-digit BBLs');
		assert.ok(detail.prevSegId && detail.nextSegId, 'Expected prev/next block navigation along W 15th St');

		// W 14th St dividing border segment should record adjacent cluster and both sidewalks
		const w14Div = shard.segments.find((s) => s.streetName === 'W 14th St' && s.isDividing);
		assert.ok(w14Div, 'Expected W 14th St dividing segment');
		const w14Det = shard.segmentDetails[w14Div.id];
		assert.ok(w14Det.dividingClusters.length > 0, 'W 14th St should record bordering clusters');
		assert.equal(w14Det.storefronts.length, w14Det.total);
	});

	it('ships optimized claymation WebP artworks under 150 KB each', () => {
		for (const file of ['hero-pigeon.webp', 'bodega-cat.webp', 'pigeon-peek.webp', 'padlock-vape.webp']) {
			const stat = fs.statSync(path.join(ART_DIR, file));
			assert.ok(stat.size > 5_000 && stat.size < 150_000, `${file} unexpected size: ${stat.size}`);
		}
	});
});
