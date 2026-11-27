<script lang="ts">
	import '../app.css';
	import type { Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { navigating } from '$app/state';
	import { browser } from '$app/environment';

	let { children }: { children: Snippet } = $props();
	const isNavigating = $derived(Boolean(navigating.to));

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

{#if isNavigating}
	<div class="nav-progress-bar" role="progressbar" aria-label="Loading page"></div>
{/if}

{@render children()}

<style>
	.nav-progress-bar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		z-index: 9999;
		pointer-events: none;
		background: linear-gradient(90deg, rgba(255, 66, 0, 0.15) 0%, #ff4200 45%, rgba(255, 66, 0, 0.15) 100%);
		background-size: 200% 100%;
		animation: nav-progress-slide 0.9s ease-in-out infinite;
	}

	@keyframes nav-progress-slide {
		0% {
			background-position: 100% 0;
		}
		100% {
			background-position: -100% 0;
		}
	}
</style>
