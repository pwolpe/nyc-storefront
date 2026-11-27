<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { browser } from '$app/environment';

	let { children }: { children: Snippet } = $props();

	let lastSentKey = '';
	let sentInitialReferrer = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	if (browser) {
		afterNavigate((nav) => {
			const pathname = nav.to?.url.pathname ?? window.location.pathname;
			if (!pathname || pathname.startsWith('/stats')) return;
			try {
				if (window.localStorage.getItem('nyc_sf_notrack') === '1') return;
			} catch {
				// Ignore storage access restrictions
			}

			const navKey = `${pathname}`;
			if (navKey === lastSentKey && nav.from !== null) return;
			lastSentKey = navKey;

			const referrer = !sentInitialReferrer ? document.referrer || '' : '';
			sentInitialReferrer = true;

			if (timer) clearTimeout(timer);
			// Brief delay lets SvelteKit finish updating <title> for cluster/building routes
			timer = setTimeout(() => {
				timer = null;
				const payload = JSON.stringify({
					p: pathname,
					r: referrer,
					t: document.title || '',
					w: window.innerWidth || 0
				});
				try {
					if (navigator.sendBeacon) {
						const blob = new Blob([payload], { type: 'application/json' });
						navigator.sendBeacon('/api/v', blob);
						return;
					}
				} catch {
					// Fall back to keepalive fetch
				}
				fetch('/api/v', {
					method: 'POST',
					body: payload,
					headers: { 'Content-Type': 'application/json' },
					keepalive: true
				}).catch(() => {});
			}, 180);
		});
	}
</script>

{@render children()}
