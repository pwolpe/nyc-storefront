import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAnalyticsStore } from '$lib/server/analytics';
import { isStatsAuthorized } from '$lib/server/statsAuth';

export const GET: RequestHandler = ({ cookies }) => {
	const auth = isStatsAuthorized(cookies);
	if (!auth.authorized) {
		return json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
	}
	return json(getAnalyticsStore().getSnapshot(), {
		headers: {
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex, nofollow'
		}
	});
};
