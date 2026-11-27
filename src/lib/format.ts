export function pct(v: number | null | undefined, digits = 1): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	return `${(v * 100).toFixed(digits)}%`;
}

export function ptsDiff(a: number, b: number, digits = 1): string {
	const d = (a - b) * 100;
	const sign = d > 0 ? '+' : '';
	return `${sign}${d.toFixed(digits)} pts`;
}

export function numFmt(v: number | null | undefined): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	return Math.round(v).toLocaleString('en-US');
}

export function streetViewUrl(lat: number, lng: number): string {
	return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
}

export function rateTone(rate: number): 'hot' | 'steady' | 'thriving' {
	if (rate >= 0.16) return 'hot';
	if (rate <= 0.085) return 'thriving';
	return 'steady';
}

export function deltaPts(delta: number | null | undefined, digits = 1): string {
	if (delta === null || delta === undefined || !Number.isFinite(delta)) return '—';
	const pts = delta * 100;
	if (Math.abs(pts) < 0.05) return '0.0 pts';
	const arrow = pts > 0 ? '↑' : '↓';
	return `${arrow} ${Math.abs(pts).toFixed(digits)} pts`;
}

export function deltaTone(delta: number | null | undefined, threshold = 0.004): 'worse' | 'better' | 'flat' {
	if (delta === null || delta === undefined || !Number.isFinite(delta)) return 'flat';
	if (delta >= threshold) return 'worse';
	if (delta <= -threshold) return 'better';
	return 'flat';
}

export function signedNum(v: number | null | undefined): string {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	const r = Math.round(v);
	return `${r > 0 ? '+' : ''}${r.toLocaleString('en-US')}`;
}
