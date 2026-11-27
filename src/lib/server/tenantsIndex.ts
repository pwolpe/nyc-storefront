import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockTenantInfo, TenantRecord } from '$lib/types';

type CompactTenantTuple = [string, string, 'R' | 'L', 'a' | 'r' | 'f', string];

let indexByBbl: Record<string, CompactTenantTuple[]> | null = null;
let loadAttempted = false;

function ensureLoaded(): Record<string, CompactTenantTuple[]> {
	if (indexByBbl) return indexByBbl;
	if (loadAttempted) return {};
	loadAttempted = true;

	const candidates = [
		join(process.cwd(), 'static/data/nyc-tenants-index.json'),
		join(process.cwd(), 'build/client/data/nyc-tenants-index.json')
	];

	for (const p of candidates) {
		try {
			const raw = readFileSync(p, 'utf8');
			const parsed = JSON.parse(raw) as { byBbl?: Record<string, CompactTenantTuple[]> };
			if (parsed?.byBbl) {
				indexByBbl = parsed.byBbl;
				return indexByBbl;
			}
		} catch {
			// try next path
		}
	}
	indexByBbl = {};
	return indexByBbl;
}

export function lookupPrebakedTenants(bbls: Iterable<string>): Record<string, BlockTenantInfo> {
	const db = ensureLoaded();
	const out: Record<string, BlockTenantInfo> = {};
	const statusMap: Record<'a' | 'r' | 'f', TenantRecord['status']> = {
		a: 'active',
		r: 'recent',
		f: 'former'
	};

	for (const raw of bbls) {
		const bbl = (raw || '').split('.')[0].trim();
		const rows = db[bbl];
		if (!rows || rows.length === 0) continue;
		out[bbl] = {
			tenants: rows.map(([name, category, src, st, dt]) => ({
				name,
				category,
				source: src === 'R' ? 'DOHMH' : 'DCWP',
				status: statusMap[st] || 'active',
				lastDate: dt || null
			})),
			vacantYears: 0,
			vacantSinceYear: null,
			priorActivity: null
		};
	}
	return out;
}
