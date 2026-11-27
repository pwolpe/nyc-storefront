import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanDofActivity, dedupeDofRows, parseDofVacant, parseDofYear } from '../src/lib/dofDedupe.js';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('NYC DOF Storefront Registry (92iy-9c3n) Deduplication Guardrails', () => {
	it('parses multi-year and single-year reporting_year strings without 2022/2023 collision', () => {
		assert.equal(parseDofYear('2019 and 2020'), 2019);
		assert.equal(parseDofYear('2020 and 2021'), 2020);
		assert.equal(parseDofYear('2021 and 2022'), 2021);
		assert.equal(parseDofYear('2022 and 2023'), 2022);
		assert.equal(parseDofYear('2023'), 2023);
		assert.equal(parseDofYear('2024'), 2024);
		assert.equal(parseDofYear('2025'), 2025);
	});

	it('normalizes YES/Y and NO/N and excludes blank June-30-only rows', () => {
		assert.equal(parseDofVacant('YES'), true);
		assert.equal(parseDofVacant('Y'), true);
		assert.equal(parseDofVacant('NO'), false);
		assert.equal(parseDofVacant('N'), false);
		assert.equal(parseDofVacant(''), null);
		assert.equal(parseDofVacant(undefined), null);
	});

	it('deduplicates 540 W 28th St (1006991202) 2023 Feb 15 + June 3 RPIE from 4/5 down to true 2/3', () => {
		const raw2023 = [
			{
				borough_block_lot: '1006991202',
				reporting_year: '2023',
				filing_due_date: '2024-02-15T00:00:00.000',
				vacant_on_12_31: 'YES'
			},
			{
				borough_block_lot: '1006991202',
				reporting_year: '2023',
				filing_due_date: '2024-02-15T00:00:00.000',
				vacant_on_12_31: 'YES'
			},
			{
				borough_block_lot: '1006991202',
				reporting_year: '2023',
				filing_due_date: '2024-06-03T00:00:00.000',
				vacant_on_12_31: 'YES'
			},
			{
				borough_block_lot: '1006991202',
				reporting_year: '2023',
				filing_due_date: '2024-06-03T00:00:00.000',
				vacant_on_12_31: 'YES'
			},
			{
				borough_block_lot: '1006991202',
				reporting_year: '2023',
				filing_due_date: '2024-06-03T00:00:00.000',
				vacant_on_12_31: 'NO'
			},
			// Mid-year June 30 row with no vacant_on_12_31 must be ignored
			{
				borough_block_lot: '1006991202',
				reporting_year: '2024',
				filing_due_date: '2024-08-15T00:00:00.000',
				vacant_6_30_or_date_sold: 'YES'
			}
		];

		const clean = dedupeDofRows(raw2023);
		assert.equal(clean.length, 3, 'Should keep only the 3 June Annual RPIE rows');
		const vacantCount = clean.filter((r) => parseDofVacant(r.vacant_on_12_31) === true).length;
		const occupiedCount = clean.filter((r) => parseDofVacant(r.vacant_on_12_31) === false).length;
		assert.equal(vacantCount, 2);
		assert.equal(occupiedCount, 1);
	});

	it('retains Feb 15 supplemental rows for RPIE-exempt buildings that did not file in June', () => {
		const rows = [
			{
				borough_block_lot: '1001230045',
				reporting_year: '2024',
				filing_due_date: '2025-02-15T00:00:00.000',
				vacant_on_12_31: 'Y'
			},
			{
				borough_block_lot: '1009990001',
				reporting_year: '2024',
				filing_due_date: '2025-02-15T00:00:00.000',
				vacant_on_12_31: 'Y'
			},
			{
				borough_block_lot: '1009990001',
				reporting_year: '2024',
				filing_due_date: '2025-06-03T00:00:00.000',
				vacant_on_12_31: 'YES'
			}
		];
		const clean = dedupeDofRows(rows);
		assert.equal(clean.length, 2);
		assert.ok(clean.some((r) => r.borough_block_lot === '1001230045'), 'Feb-only BBL must be kept');
		assert.equal(
			clean.filter((r) => r.borough_block_lot === '1009990001').length,
			1,
			'Dual-filed BBL must not double-count'
		);
	});

	it('ensures built nyc-clusters.json dofHistory has no artificial 2022->2023 double-counting spike', () => {
		const data = JSON.parse(
			fs.readFileSync(path.join(ROOT, 'static', 'data', 'nyc-clusters.json'), 'utf8')
		);
		const hist = data.meta.dofHistory;
		assert.ok(Array.isArray(hist) && hist.length === 5, 'Expected 5-year dofHistory (2021-2025)');
		const y22 = hist.find((h) => h.year === 2022);
		const y23 = hist.find((h) => h.year === 2023);
		assert.ok(y22 && y23);
		assert.ok(
			Math.abs(y23.rate - y22.rate) < 0.015,
			`Suspicious 2022->2023 DOF jump (${y22.rate} -> ${y23.rate}); check Feb 15 supplemental deduplication`
		);
	});

	it('suppresses corrupted 2023+ DOF activity codes while preserving 2019-2022 labels', () => {
		assert.equal(cleanDofActivity('EDUCATIONAL SERVICES', 2025, false), '');
		assert.equal(cleanDofActivity('EDUCATIONAL SERVICES', 2023, false), '');
		assert.equal(cleanDofActivity('WHOLESALE', 2024, false), '');
		assert.equal(cleanDofActivity('FOOD SERVICES', 2022, false), 'Food Services');
		assert.equal(cleanDofActivity('RETAIL', 2021, false), 'Retail');
		assert.equal(cleanDofActivity('RETAIL', 2021, true), '');
	});

	it('guards every file querying 92iy-9c3n so none can bypass dofDedupe', () => {
		const scanDirs = [path.join(ROOT, 'src'), path.join(ROOT, 'scripts')];
		const offenders = [];

		function walk(dir) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (/\.(ts|js|mjs|svelte)$/.test(entry.name)) {
					const txt = fs.readFileSync(full, 'utf8');
					if (txt.includes('resource/92iy-9c3n.json') && !txt.includes('dofDedupe')) {
						offenders.push(path.relative(ROOT, full));
					}
				}
			}
		}

		for (const d of scanDirs) walk(d);
		assert.deepEqual(
			offenders,
			[],
			`Files querying DOF 92iy-9c3n without importing dofDedupe: ${offenders.join(', ')}`
		);
	});
});
