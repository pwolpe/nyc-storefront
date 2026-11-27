import type { HandleServerError } from '@sveltejs/kit';

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	// Suppress noisy 404 scanner/crawler probes (e.g. /.env, /wp-config.php, /ads.txt)
	// so they don't emit stderr lines that Railway classifies as runtime errors.
	if (status === 404) {
		return { message: 'Not Found' };
	}

	console.error(`[${status}] ${event.request.method} ${event.url.pathname}`, error);
	return { message };
};
