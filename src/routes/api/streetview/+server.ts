import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, platform }) => {
	const apiKey = (
		env.GOOGLE_MAPS_API_KEY ||
		(platform?.env as Record<string, string> | undefined)?.GOOGLE_MAPS_API_KEY ||
		''
	).trim();

	if (!apiKey) {
		throw error(503, 'Street View API key not configured');
	}

	const address = (url.searchParams.get('address') || '').trim();
	const lat = (url.searchParams.get('lat') || '').trim();
	const lng = (url.searchParams.get('lng') || '').trim();

	// Prefer street address so Google points the camera directly at the building facade
	const location = address ? address : lat && lng ? `${lat},${lng}` : '';
	if (!location) {
		throw error(400, 'Missing address or coordinates');
	}

	const params = new URLSearchParams({
		size: '840x520',
		scale: '2',
		fov: '72',
		pitch: '10',
		source: 'outdoor',
		return_error_code: 'true',
		location,
		key: apiKey
	});

	const svUrl = `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);

	try {
		const res = await globalThis.fetch(svUrl, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) {
			throw error(404, 'Street View imagery unavailable for this address');
		}
		const buf = await res.arrayBuffer();
		return new Response(buf, {
			headers: {
				'Content-Type': res.headers.get('content-type') || 'image/jpeg',
				'Cache-Control': dev
					? 'public, max-age=3600'
					: 'public, max-age=86400, s-maxage=604800'
			}
		});
	} catch (e) {
		clearTimeout(timer);
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(502, 'Failed to fetch Street View image');
	}
};
