import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const ARCGIS_CHECK_URL =
	'https://services2.arcgis.com/ZpsvDOsGv97WuKRh/arcgis/rest/services/nta_quarterly_gdf/FeatureServer/0/query?where=1%3D1&outFields=quarter,reporting_date&returnGeometry=false&resultRecordCount=1&f=json';

export const GET: RequestHandler = async ({ fetch }) => {
	const summaryRes = await fetch('/data/comptroller-summary.json');
	const bundled = summaryRes.ok ? await summaryRes.json() : null;

	return json({
		status: 'synced',
		latestQuarter: bundled?.latestQuarter || '2026 Q3',
		sourceUpdated: bundled?.sourceUpdated || '2026-11-24',
		syncedAt: bundled?.syncedAt,
		sources: [
			{
				name: 'NYC Comptroller Live XYZ Neighborhood Map (ArcGIS)',
				url: 'https://comptroller.nyc.gov/services/for-the-public/storefront-vacancy/dashboard/'
			},
			{
				name: 'NYC Comptroller Quarterly Data Sheet',
				url: 'https://docs.google.com/spreadsheets/d/1hul6428-S1Azg5hmCc-xFyZSIqsyQZ-CT1tobN8qDbI/export?format=xlsx'
			},
			{
				name: 'NYC DOF Storefronts Reported Vacant or Not (92iy-9c3n)',
				url: 'https://data.cityofnewyork.us/City-Government/Storefronts-Reported-Vacant-or-Not/92iy-9c3n'
			}
		]
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const token = env.SYNC_TOKEN;
	if (token && request.headers.get('authorization') !== `Bearer ${token}`) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const res = await fetch(ARCGIS_CHECK_URL, { signal: AbortSignal.timeout(6000) });
		if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
		const data = await res.json();
		const attr = data.features?.[0]?.attributes || {};
		const meta = {
			quarter: attr.quarter || '2026 Q3',
			reportingDate: attr.reporting_date || null,
			checkedAt: new Date().toISOString()
		};

		return json({ ok: true, meta });
	} catch (err) {
		return json({ ok: false, error: String(err) }, { status: 502 });
	}
};
