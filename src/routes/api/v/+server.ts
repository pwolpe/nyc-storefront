import type { RequestHandler } from './$types';
import { getAnalyticsStore } from '$lib/server/analytics';

/**
 * Lightweight same-origin pageview beacon endpoint (/api/v).
 * Named neutrally so ad blockers don't drop legitimate human visits.
 * Returns 204 No Content immediately; zero cookies, zero third-party calls.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	try {
		const raw = await request.text();
		if (!raw || raw.length > 2048) {
			return new Response(null, { status: 204 });
		}
		const payload = JSON.parse(raw) as {
			p?: unknown;
			r?: unknown;
			t?: unknown;
			w?: unknown;
		};

		if (typeof payload.p !== 'string') {
			return new Response(null, { status: 204 });
		}

		// Railway / reverse proxies put the visitor IP in x-forwarded-for
		const xff = request.headers.get('x-forwarded-for');
		let ip = xff ? xff.split(',')[0].trim() : '';
		if (!ip) {
			try {
				ip = getClientAddress();
			} catch {
				ip = 'unknown';
			}
		}

		const userAgent = request.headers.get('user-agent') || '';
		const host = request.headers.get('host') || '';

		getAnalyticsStore().record({
			path: payload.p,
			referrer: typeof payload.r === 'string' ? payload.r : undefined,
			title: typeof payload.t === 'string' ? payload.t : undefined,
			width: typeof payload.w === 'number' ? payload.w : undefined,
			ip,
			userAgent,
			host
		});
	} catch {
		// Never break a user session over analytics
	}

	return new Response(null, {
		status: 204,
		headers: { 'Cache-Control': 'no-store' }
	});
};
