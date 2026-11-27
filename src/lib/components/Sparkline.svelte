<script lang="ts">
	interface Point {
		label: string;
		value: number;
	}

	interface Props {
		points: Point[];
		width?: number;
		height?: number;
		tone?: 'worse' | 'better' | 'flat' | 'neutral';
		showEndpoints?: boolean;
	}

	let {
		points,
		width = 112,
		height = 24,
		tone = 'neutral',
		showEndpoints = false
	}: Props = $props();

	const strokeColor = $derived(
		tone === 'worse'
			? '#c4281c'
			: tone === 'better'
				? '#0e6e48'
				: tone === 'flat'
					? '#7a7a74'
					: '#111111'
	);

	const geom = $derived.by(() => {
		if (!points || points.length < 2) return null;
		const padX = 3;
		const padY = 4;
		const w = width - padX * 2;
		const h = height - padY * 2;
		const vals = points.map((p) => p.value);
		const minV = Math.min(...vals);
		const maxV = Math.max(...vals);
		const span = Math.max(0.008, maxV - minV);
		const coords = points.map((p, i) => {
			const x = padX + (i / (points.length - 1)) * w;
			const y = padY + (1 - (p.value - minV) / span) * h;
			return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), ...p };
		});
		const d = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
		const areaD = `${d} L${coords[coords.length - 1].x},${height - 1} L${coords[0].x},${height - 1} Z`;
		return { coords, d, areaD, first: coords[0], last: coords[coords.length - 1] };
	});
</script>

{#if geom}
	<div class="spark-wrap">
		<svg
			{width}
			{height}
			viewBox="0 0 {width} {height}"
			class="spark-svg"
			aria-hidden="true"
		>
			<path d={geom.areaD} fill={strokeColor} fill-opacity="0.08" />
			<path
				d={geom.d}
				fill="none"
				stroke={strokeColor}
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
			<circle cx={geom.last.x} cy={geom.last.y} r="2.3" fill={strokeColor} />
		</svg>
		{#if showEndpoints}
			<div class="spark-ends">
				<span>{geom.first.label}</span>
				<span>{geom.last.label}</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	.spark-wrap {
		display: inline-flex;
		flex-direction: column;
		gap: 1px;
		flex: none;
	}

	.spark-svg {
		display: block;
		overflow: visible;
	}

	.spark-ends {
		display: flex;
		justify-content: space-between;
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--muted-light);
		line-height: 1;
	}
</style>
