<script lang="ts">
	interface Props {
		summary?: string;
		compact?: boolean;
	}

	let { summary = '', compact = false }: Props = $props();
	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function copyShare() {
		if (typeof window === 'undefined') return;
		const url = window.location.href;
		const text = summary ? `${summary} — ${url}` : url;
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
			}
			copied = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => (copied = false), 1800);
		} catch {
			// ignore clipboard error
		}
	}
</script>

<button
	type="button"
	class="share-btn"
	class:compact
	class:copied
	onclick={copyShare}
	title="Copy shareable link & summary"
>
	{#if copied}
		<span>✓ Copied</span>
	{:else}
		<svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
			<path
				d="M6.5 9.5L9.5 6.5M7.2 4.6l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5l-1.3 1.3M8.8 11.4l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5l1.3-1.3"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
			/>
		</svg>
		<span>Share</span>
	{/if}
</button>

<style>
	.share-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 9px;
		border-radius: 5px;
		border: 1px solid var(--rule);
		background: var(--panel);
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		cursor: pointer;
		flex: none;
		transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
	}

	.share-btn.compact {
		padding: 3px 8px;
		font-size: 10px;
	}

	.share-btn:hover {
		border-color: var(--ink);
		color: var(--ink);
	}

	.share-btn.copied {
		border-color: var(--green);
		background: var(--green-bg);
		color: var(--green);
	}
</style>
