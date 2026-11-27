/**
 * Plain-English translators for NYC real-estate, zoning, building class,
 * DOB permit, and agency codes so non-experts can read a building page in seconds.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMonthYear(iso: string | null | undefined): string {
	if (!iso) return '';
	const m = iso.match(/^(\d{4})-(\d{2})/);
	if (!m) return iso;
	const mo = parseInt(m[2], 10);
	if (mo >= 1 && mo <= 12) return `${MONTHS[mo - 1]} ${m[1]}`;
	return m[1];
}

export function explainZoning(code: string | null | undefined): string {
	const raw = (code || '').trim().toUpperCase();
	if (!raw) return 'Not listed';
	if (raw === 'PARK') return 'Public parkland';
	if (raw.startsWith('BPC')) return 'Battery Park City mixed-use';

	// Commercial districts (C1-C8)
	if (/^C1|^C2/.test(raw)) return 'Neighborhood retail & apartments';
	if (/^C3/.test(raw)) return 'Waterfront recreation & retail';
	if (/^C4/.test(raw)) return 'Regional shopping & apartments';
	if (/^C5/.test(raw)) return 'Prime central commercial';
	if (/^C6/.test(raw)) return 'High-density commercial & mixed-use';
	if (/^C7/.test(raw)) return 'Large-scale entertainment / commercial';
	if (/^C8/.test(raw)) return 'Auto & heavy commercial services';

	// Manufacturing districts (M1-M3)
	if (/^M1.*\/R/.test(raw)) return 'Mixed loft, retail & residential';
	if (/^M1/.test(raw)) return 'Light industrial, lofts & retail';
	if (/^M2/.test(raw)) return 'Medium industrial & waterfront';
	if (/^M3/.test(raw)) return 'Heavy industrial';

	// Residential districts (R1-R10)
	if (/^R[1-5]/.test(raw)) return 'Low-density residential';
	if (/^R[6-8]/.test(raw)) return 'Mid-rise apartment district';
	if (/^R9|^R10/.test(raw)) return 'High-rise residential & retail';

	return raw;
}

const EXACT_BLDG_CLASS: Record<string, string> = {
	RM: 'Mixed-use condo',
	R4: 'Elevator condo',
	R1: 'Walk-up condo',
	R2: 'Walk-up condo',
	R3: 'Low-rise condo',
	R5: 'Commercial condo',
	R6: 'Residential condo',
	R9: 'Co-op in condo',
	RB: 'Office condo',
	RK: 'Retail condo',
	K1: '1-story retail',
	K2: 'Multi-story retail',
	K3: 'Department store',
	K4: 'Store & apartments',
	K5: 'Diner / restaurant',
	K6: 'Shopping center',
	K7: 'Bank building',
	K8: 'Big-box retail',
	K9: 'Commercial retail',
	C1: 'Walk-up apartments',
	C4: 'Old-law tenement',
	C5: 'Converted walk-up',
	C6: 'Walk-up co-op',
	C7: 'Walk-up w/ ground retail',
	D1: 'Elevator apartments',
	D4: 'Elevator co-op',
	D6: 'Elevator apts w/ retail',
	D7: 'Elevator apts w/ retail',
	D8: 'Luxury apartments',
	O1: 'Low-rise office',
	O2: 'Mid-rise office',
	O3: 'Mid-rise office',
	O4: 'Office tower',
	O5: 'Office w/ retail',
	O6: 'Office w/ retail',
	O7: 'Professional office',
	O8: 'Office w/ apartments',
	O9: 'Commercial office',
	H1: 'Luxury hotel',
	H2: 'Full-service hotel',
	H3: 'Boutique hotel',
	L1: 'Loft building',
	L8: 'Loft w/ ground retail',
	L9: 'Mixed loft building',
	S1: '1-family w/ storefront',
	S2: '2-family w/ storefront',
	S3: '3-family w/ storefront',
	S4: '4-family w/ storefront',
	S5: '5–6 family w/ storefront',
	S9: 'Mixed residence & store'
};

export function explainBldgClass(code: string | null | undefined): string {
	const raw = (code || '').trim().toUpperCase();
	if (!raw) return '';
	if (EXACT_BLDG_CLASS[raw]) return EXACT_BLDG_CLASS[raw];
	const first = raw[0];
	if (first === 'K') return 'Retail building';
	if (first === 'S') return 'Home w/ storefront';
	if (first === 'C') return 'Walk-up apartments';
	if (first === 'D') return 'Elevator apartments';
	if (first === 'R') return 'Condo building';
	if (first === 'O') return 'Office building';
	if (first === 'L') return 'Loft building';
	if (first === 'H') return 'Hotel';
	if (first === 'A' || first === 'B') return '1–2 family house';
	if (first === 'E' || first === 'F') return 'Warehouse / industrial';
	if (first === 'G') return 'Garage / auto';
	if (first === 'W') return 'School / educational';
	if (first === 'M') return 'House of worship';
	if (first === 'P' || first === 'J') return 'Theater / cultural';
	return raw;
}

export function explainPermitType(jobType: string | null | undefined, workType?: string): string {
	const j = (jobType || '').trim().toUpperCase();
	const w = (workType || '').trim().toUpperCase();
	if (j === 'NB' || j === 'NEW BUILDING') return 'New building construction';
	if (j === 'DM' || j === 'FULL DEMOLITION') return 'Demolition';
	if (j === 'A1' || j === 'ALT-CO' || j.includes('CO')) return 'Major gut renovation';
	if (j === 'A2' || j === 'ALT2' || j === 'ALTERATION') {
		if (w.includes('PL') || w.includes('PLUMBING')) return 'Plumbing renovation';
		if (w.includes('MH') || w.includes('MECHANICAL')) return 'HVAC / mechanical work';
		return 'Interior renovation';
	}
	if (j === 'A3' || j === 'ALT3') return 'Minor alteration / facade';
	if (j === 'SG' || j === 'SIGN' || w.includes('SIGN')) return 'Storefront signage';
	if (w.includes('GENERAL CONSTRUCTION')) return 'General construction';
	if (w.includes('PLUMBING')) return 'Plumbing work';
	if (w.includes('MECHANICAL')) return 'HVAC / mechanical work';
	if (w.includes('SIDEWALK SHED')) return 'Sidewalk shed / scaffolding';
	if (j && j !== 'DOB NOW') return jobType || 'Building permit';
	return workType ? workType.charAt(0).toUpperCase() + workType.slice(1).toLowerCase() : 'Building renovation';
}

export function explainSourceTag(source: 'DOHMH' | 'DCWP' | 'OPEN_RESTAURANTS' | 'OATH'): string {
	if (source === 'DOHMH') return 'Health Dept';
	if (source === 'DCWP') return 'Biz License';
	if (source === 'OPEN_RESTAURANTS') return 'Outdoor Dining';
	return 'City Archive';
}
