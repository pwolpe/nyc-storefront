import { createHash, timingSafeEqual } from 'node:crypto';
import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

export const STATS_COOKIE_NAME = 'nyc_stats_auth';

export function getStatsSecret(): string {
	return (process.env.STATS_SECRET || '').trim();
}

function deriveToken(secret: string): string {
	return createHash('sha256').update(`nycstorefront-stats-v1:${secret}`).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
	if (!a || !b) return false;
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export function isStatsAuthorized(cookies: Cookies): {
	authorized: boolean;
	configured: boolean;
	localOpen: boolean;
} {
	const secret = getStatsSecret();
	if (!secret) {
		if (dev) {
			return { authorized: true, configured: false, localOpen: true };
		}
		return { authorized: false, configured: false, localOpen: false };
	}
	const cookieVal = cookies.get(STATS_COOKIE_NAME) || '';
	const expected = deriveToken(secret);
	return {
		authorized: safeEqual(cookieVal, expected),
		configured: true,
		localOpen: false
	};
}

export function setStatsAuthCookie(cookies: Cookies, secret: string, isHttps: boolean): void {
	cookies.set(STATS_COOKIE_NAME, deriveToken(secret), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: isHttps,
		maxAge: 60 * 60 * 24 * 90 // 90 days
	});
}

export function clearStatsAuthCookie(cookies: Cookies): void {
	cookies.delete(STATS_COOKIE_NAME, { path: '/' });
}
