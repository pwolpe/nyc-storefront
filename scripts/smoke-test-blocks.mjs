#!/usr/bin/env node
/**
 * Multi-borough Block Elevation Geometry & Tie-Out Smoke Test.
 * Audits 20 notoriously tricky NYC blocks (diagonal avenues, superblocks, U-shaped lots,
 * private streetbeds, viaducts, and outer-borough corridors) against a running server.
 *
 * Usage:
 *   node scripts/smoke-test-blocks.mjs                          # tests http://localhost:5173
 *   node scripts/smoke-test-blocks.mjs https://nycstorefront.com
 */
import fs from 'node:fs';

const BASE_URL = (process.argv[2] || 'http://localhost:5173').replace(/\/$/, '');

const RULES = [
	(s, seg) => seg.streetName === 'E 20th St' && seg.between.includes('Park Ave S'),
	(s, seg) => seg.streetName === 'E 46th St' && seg.between.includes('Park'),
	(s, seg) => seg.streetName === 'Freedom Pl S' && seg.between.includes('62nd'),
	(s, seg) => seg.streetName === 'W 23rd St' && seg.between.includes('8th') && seg.between.includes('9th'),
	(s, seg) => seg.streetName === '33rd St' && seg.between.includes('2nd') && seg.between.includes('3rd') && s.cluster.borough === 'Brooklyn',
	(s, seg) => seg.streetName === 'W 23rd St' && seg.between.includes('7th') && seg.between.includes('8th'),
	(s, seg) => seg.streetName === 'Bleecker St' && seg.total >= 8,
	(s, seg) => seg.streetName === 'Bowery' && seg.total >= 6,
	(s, seg) => seg.streetName === '5th Ave' && seg.total >= 6 && s.cluster.borough === 'Manhattan',
	(s, seg) => seg.streetName === 'Bedford Ave' && seg.total >= 8,
	(s, seg) => seg.streetName === 'Steinway St' && seg.total >= 8,
	(s, seg) => seg.streetName === 'E Fordham Rd' && seg.total >= 6,
	(s, seg) => seg.streetName === '3rd Ave' && seg.total >= 6 && s.cluster.borough === 'Bronx',
	(s, seg) => s.cluster.borough === 'Staten Island' && seg.total >= 4
];

const files = fs.readdirSync('static/data/clusters').filter((f) => f.endsWith('.json'));
const picks = [];
const seen = new Set();

for (const f of files) {
	const s = JSON.parse(fs.readFileSync(`static/data/clusters/${f}`, 'utf8'));
	for (const seg of s.segments) {
		for (let i = 0; i < RULES.length; i++) {
			if (picks.some((p) => p.rule === i)) continue;
			if (RULES[i](s, seg)) {
				const key = `${s.cluster.id}:${seg.id}`;
				if (!seen.has(key)) {
					seen.add(key);
					picks.push({
						rule: i,
						cid: s.cluster.id,
						sid: seg.id,
						label: `${seg.streetName} (${seg.between}) [${s.cluster.borough}]`,
						vac: seg.vacant,
						tot: seg.total
					});
				}
			}
		}
	}
}

let failures = 0;
console.log(`Running ${picks.length}-block geometry & tie-out smoke test against ${BASE_URL}...\n`);

for (const p of picks) {
	const res = await fetch(`${BASE_URL}/api/block-lots?cluster=${p.cid}&segment=${p.sid}`);
	if (!res.ok) {
		failures++;
		console.error(`❌ HTTP ${res.status} — ${p.label}`);
		continue;
	}
	const d = await res.json();
	const issues = [];

	for (const [name, side] of [
		['A', d.sideA],
		['B', d.sideB]
	]) {
		if (side.length === 0) {
			issues.push(`Side ${name} empty`);
			continue;
		}
		if (side[0].x0 > 0.02) issues.push(`Side ${name} leftGap=${side[0].x0.toFixed(3)}`);
		if (side[side.length - 1].x1 < 0.98) {
			issues.push(`Side ${name} rightGap=${(1 - side[side.length - 1].x1).toFixed(3)}`);
		}
		for (let i = 1; i < side.length; i++) {
			const gap = side[i].x0 - side[i - 1].x1;
			if (gap < -0.005) issues.push(`Side ${name} overlap=${gap.toFixed(3)}`);
		}
		for (const l of side) {
			if (l.storefronts.length > 0 && l.landUseLabel.startsWith('Vacant Lot')) {
				issues.push(`Side ${name} VacantLot-with-SF (${l.address})`);
			}
		}
	}

	const allLots = [...d.sideA, ...d.sideB];
	const sumSf = allLots.reduce((a, l) => a + l.storefronts.length, 0);
	const sumVac = allLots.reduce((a, l) => a + l.vacantCount, 0);
	if (sumSf !== p.tot || sumVac !== p.vac) {
		issues.push(`tie-out ${sumVac}/${sumSf} != ${p.vac}/${p.tot}`);
	}

	if (issues.length > 0) {
		failures++;
		console.error(`❌ ${p.cid}/${p.sid} ${p.label} => ${issues.join(' | ')}`);
	} else {
		console.log(`✅ ${p.cid}/${p.sid} ${p.label} (${d.sideA.length}A/${d.sideB.length}B, ${sumVac}/${sumSf})`);
	}
}

console.log(`\nResult: ${picks.length - failures}/${picks.length} blocks clean.`);
if (failures > 0) process.exit(1);
