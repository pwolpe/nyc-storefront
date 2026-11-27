import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getAnalyticsStore } from '$lib/server/analytics';
import {
	clearStatsAuthCookie,
	getStatsSecret,
	isStatsAuthorized,
	safeEqual,
	setStatsAuthCookie
} from '$lib/server/statsAuth';

export const load: PageServerLoad = ({ url, cookies, setHeaders }) => {
	setHeaders({
		'Cache-Control': 'no-store',
		'X-Robots-Tag': 'noindex, nofollow'
	});

	const secret = getStatsSecret();
	const keyParam = url.searchParams.get('key')?.trim() || '';
	const isHttps = url.protocol === 'https:' || process.env.NODE_ENV === 'production';

	// Support magic bookmark URL: /stats?key=<STATS_SECRET> -> sets HttpOnly cookie & strips query string
	if (secret && keyParam && safeEqual(keyParam, secret)) {
		setStatsAuthCookie(cookies, secret, isHttps);
		throw redirect(303, '/stats');
	}

	const auth = isStatsAuthorized(cookies);
	if (!auth.authorized) {
		return {
			authorized: false,
			configured: auth.configured,
			localOpen: false,
			snapshot: null
		};
	}

	return {
		authorized: true,
		configured: auth.configured,
		localOpen: auth.localOpen,
		snapshot: getAnalyticsStore().getSnapshot()
	};
};

export const actions: Actions = {
	login: async ({ request, cookies, url }) => {
		const secret = getStatsSecret();
		if (!secret) {
			return fail(400, { error: 'STATS_SECRET is not configured on this server.' });
		}
		const formData = await request.formData();
		const key = String(formData.get('key') || '').trim();
		if (!safeEqual(key, secret)) {
			return fail(401, { error: 'Incorrect passcode.' });
		}
		const isHttps = url.protocol === 'https:' || process.env.NODE_ENV === 'production';
		setStatsAuthCookie(cookies, secret, isHttps);
		throw redirect(303, '/stats');
	},
	logout: async ({ cookies }) => {
		clearStatsAuthCookie(cookies);
		throw redirect(303, '/stats');
	}
};
