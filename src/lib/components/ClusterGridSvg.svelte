<script lang="ts">
	import { goto } from '$app/navigation';
	import type {
		BorderCluster,
		ClusterShard,
		ClustersFile,
		SegmentSummary,
		ContextStreetLine
	} from '$lib/types';
	import { pct } from '$lib/format';

	interface Props {
		shard: ClusterShard;
		clustersData: ClustersFile;
		highlightedStreetSlug?: string | null;
		highlightedSegId?: string | null;
		highlightedNeighborId?: string | null;
		onHoverStreet?: (slug: string | null) => void;
		onHoverSegment?: (segId: string | null) => void;
		onHoverNeighbor?: (neighborId: string | null) => void;
	}

	let {
		shard,
		clustersData,
		highlightedStreetSlug = null,
		highlightedSegId = null,
		highlightedNeighborId = null,
		onHoverStreet = () => {},
		onHoverSegment = () => {},
		onHoverNeighbor = () => {}
	}: Props = $props();

	let hoveredSeg = $state<SegmentSummary | null>(null);
	let hoveredContext = $state<ContextStreetLine | null>(null);
	let hoveredNeighborId = $state<string | null>(null);

	const activeNeighborId = $derived(hoveredNeighborId ?? highlightedNeighborId);

	function segColor(r: number): string {
		if (r >= 0.25) return '#8f1422';
		if (r >= 0.16) return '#d9381e';
		if (r >= 0.10) return '#e4724e';
		if (r > 0) return '#ebb09c';
		return '#c6c6bf';
	}

	function segWidth(r: number, isActive: boolean, isSameStreet: boolean): number {
		if (isActive) return 13;
		if (isSameStreet) return r > 0 ? 5.2 : 3.8;
		if (r >= 0.25) return 3.8;
		if (r >= 0.16) return 3.4;
		if (r >= 0.10) return 2.9;
		if (r > 0) return 2.5;
		return 2.0;
	}

	const activeSeg = $derived.by(() => {
		if (hoveredSeg) return hoveredSeg;
		if (highlightedSegId) {
			return shard.segments.find((s) => s.id === highlightedSegId) || null;
		}
		return null;
	});

	const activeStreetSlug = $derived(activeSeg?.streetSlug ?? highlightedStreetSlug ?? null);

	const activeCrossNames = $derived.by(() => {
		const set = new Set<string>();
		if (!activeSeg) return set;
		if (activeSeg.endA) set.add(activeSeg.endA.toLowerCase());
		if (activeSeg.endB) set.add(activeSeg.endB.toLowerCase());
		return set;
	});

	const MARGIN_LEFT = 150;
	const MARGIN_TOP = 84;
	const MARGIN_RIGHT = 82;
	const MARGIN_BOTTOM = 68;
	const SVG_W = 1040;
	const SVG_H = 740;
	const FRAME_L = MARGIN_LEFT - 4;
	const FRAME_T = MARGIN_TOP - 4;
	const FRAME_R = SVG_W - 10;
	const FRAME_B = SVG_H - 10;

	interface ProjectedSeg {
		seg: SegmentSummary;
		pts: [number, number][];
		d: string; // full-length path (used on hover + hit area)
		dTrim: string; // cleanly inset path with square butt ends (zero messy intersection overlaps at rest!)
		mid: [number, number];
		lenPx: number;
	}

	interface ProjectedContext {
		ctx: ContextStreetLine;
		pts: [number, number][];
		d: string;
	}

	interface ProjectedNeighbor {
		nb: BorderCluster;
		paths: string[];
		label: string;
		rateText: string;
		diffText: string;
		lx: number;
		ly: number;
		pillW: number;
		showAtRest: boolean;
		area: number;
	}

	/** Sutherland-Hodgman clip of a 2D polygon ring against an axis-aligned rectangle */
	function clipRingToRect(
		ring: [number, number][],
		minX: number,
		minY: number,
		maxX: number,
		maxY: number
	): [number, number][] {
		const clipEdge = (
			pts: [number, number][],
			inside: (p: [number, number]) => boolean,
			intersect: (a: [number, number], b: [number, number]) => [number, number]
		): [number, number][] => {
			if (pts.length === 0) return [];
			const out: [number, number][] = [];
			let prev = pts[pts.length - 1];
			let prevIn = inside(prev);
			for (const cur of pts) {
				const curIn = inside(cur);
				if (curIn) {
					if (!prevIn) out.push(intersect(prev, cur));
					out.push(cur);
				} else if (prevIn) {
					out.push(intersect(prev, cur));
				}
				prev = cur;
				prevIn = curIn;
			}
			return out;
		};

		let pts = ring;
		pts = clipEdge(
			pts,
			(p) => p[0] >= minX,
			(a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0] || 1e-9)]
		);
		pts = clipEdge(
			pts,
			(p) => p[0] <= maxX,
			(a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0] || 1e-9)]
		);
		pts = clipEdge(
			pts,
			(p) => p[1] >= minY,
			(a, b) => [a[0] + ((b[0] - a[0]) * (minY - a[1])) / (b[1] - a[1] || 1e-9), minY]
		);
		pts = clipEdge(
			pts,
			(p) => p[1] <= maxY,
			(a, b) => [a[0] + ((b[0] - a[0]) * (maxY - a[1])) / (b[1] - a[1] || 1e-9), maxY]
		);
		return pts;
	}

	function polyAreaCentroid(pts: [number, number][]): { area: number; cx: number; cy: number } {
		if (pts.length < 3) return { area: 0, cx: 0, cy: 0 };
		let a2 = 0;
		let cx = 0;
		let cy = 0;
		for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
			const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
			a2 += cross;
			cx += (pts[j][0] + pts[i][0]) * cross;
			cy += (pts[j][1] + pts[i][1]) * cross;
		}
		if (Math.abs(a2) < 1e-3) {
			const avgX = pts.reduce((s, p) => s + p[0], 0) / pts.length;
			const avgY = pts.reduce((s, p) => s + p[1], 0) / pts.length;
			return { area: 0, cx: avgX, cy: avgY };
		}
		return {
			area: Math.abs(a2) * 0.5,
			cx: cx / (3 * a2),
			cy: cy / (3 * a2)
		};
	}

	function pointInRingSvg(x: number, y: number, ring: [number, number][]): boolean {
		let inside = false;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const xi = ring[i][0];
			const yi = ring[i][1];
			const xj = ring[j][0];
			const yj = ring[j][1];
			const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
			if (hit) inside = !inside;
		}
		return inside;
	}

	function neighborFill(rate: number, active: boolean): string {
		if (active) {
			if (rate >= 0.2) return 'rgba(180, 35, 24, 0.13)';
			if (rate >= 0.1) return 'rgba(217, 56, 30, 0.10)';
			return 'rgba(17, 17, 17, 0.065)';
		}
		if (rate >= 0.2) return 'rgba(180, 35, 24, 0.065)';
		if (rate >= 0.1) return 'rgba(217, 56, 30, 0.038)';
		return 'rgba(17, 17, 17, 0.022)';
	}

	interface MarginLabel {
		name: string;
		slug: string;
		pos: number;
		rawPos: number;
		anchorCoord: number;
		weight: number;
		hasCommercial: boolean;
	}

	const blueprint = $derived.by(() => {
		const [lng0, lat0] = shard.cluster.center;
		const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
		const ky = 111320;
		const rad = (shard.gridAngleDeg * Math.PI) / 180;
		const cosA = Math.cos(rad);
		const sinA = Math.sin(rad);

		function rot(lng: number, lat: number): [number, number] {
			const dx = (lng - lng0) * kx;
			const dy = (lat - lat0) * ky;
			return [dx * cosA - dy * sinA, dx * sinA + dy * cosA];
		}

		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;

		const includePt = ([x, y]: [number, number]) => {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		};

		for (const s of shard.segments) {
			for (const p of s.line) includePt(rot(p[0], p[1]));
		}
		for (const c of shard.contextLines) {
			for (const p of c.line) includePt(rot(p[0], p[1]));
		}
		if (!Number.isFinite(minX)) {
			minX = -100;
			maxX = 100;
			minY = -100;
			maxY = 100;
		}

		const spanX = Math.max(80, maxX - minX);
		const spanY = Math.max(80, maxY - minY);
		const plotW = SVG_W - MARGIN_LEFT - MARGIN_RIGHT;
		const plotH = SVG_H - MARGIN_TOP - MARGIN_BOTTOM;
		const scale = Math.min(plotW / spanX, plotH / spanY) * 0.84;

		const offsetX = MARGIN_LEFT + (plotW - spanX * scale) / 2;
		const offsetY = MARGIN_TOP + (plotH - spanY * scale) / 2;

		function toSvg(lng: number, lat: number): [number, number] {
			const [rx, ry] = rot(lng, lat);
			const sx = offsetX + (rx - minX) * scale;
			const sy = offsetY + (maxY - ry) * scale;
			return [Number(sx.toFixed(1)), Number(sy.toFixed(1))];
		}

		function lineToPath(pts: [number, number][]): string {
			return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
		}

		// Trim each end slightly back from the intersection center so resting blocks meet cleanly with zero messy overlap
		function trimPolyline(pts: [number, number][], insetPx: number): [number, number][] {
			if (pts.length < 2) return pts;
			const out = pts.map((p) => [p[0], p[1]] as [number, number]);
			// Trim start
			const dx0 = out[1][0] - out[0][0];
			const dy0 = out[1][1] - out[0][1];
			const len0 = Math.hypot(dx0, dy0);
			if (len0 > insetPx * 2.6) {
				out[0] = [
					Number((out[0][0] + (dx0 / len0) * insetPx).toFixed(1)),
					Number((out[0][1] + (dy0 / len0) * insetPx).toFixed(1))
				];
			}
			// Trim end
			const n = out.length;
			const dx1 = out[n - 1][0] - out[n - 2][0];
			const dy1 = out[n - 1][1] - out[n - 2][1];
			const len1 = Math.hypot(dx1, dy1);
			if (len1 > insetPx * 2.6) {
				out[n - 1] = [
					Number((out[n - 1][0] - (dx1 / len1) * insetPx).toFixed(1)),
					Number((out[n - 1][1] - (dy1 / len1) * insetPx).toFixed(1))
				];
			}
			return out;
		}

		const polys =
			shard.geometry.type === 'Polygon'
				? [shard.geometry.coordinates]
				: shard.geometry.coordinates;
		const boundaryPaths: string[] = [];
		const clusterRingsSvg: [number, number][][] = [];
		for (const poly of polys) {
			const ring = poly[0];
			if (!ring || ring.length < 3) continue;
			const rPts = ring.map((c) => toSvg(c[0], c[1]));
			clusterRingsSvg.push(rPts);
			boundaryPaths.push(`${lineToPath(rPts)} Z`);
		}

		// Project bordering clusters geographically into the exact same rotated SVG frame!
		const featureById = new Map<string, (typeof clustersData.clusters.features)[number]>();
		for (const f of clustersData.clusters.features) {
			featureById.set(f.properties.id, f);
		}

		// Count neighborhood-prefix duplicates so two bordering Midtown clusters distinguish themselves cleanly
		const prefixCounts = new Map<string, number>();
		for (const nb of shard.borderClusters) {
			const pref = nb.name.split(':')[0].trim();
			prefixCounts.set(pref, (prefixCounts.get(pref) || 0) + 1);
		}

		const cCx = (FRAME_L + FRAME_R) / 2;
		const cCy = (FRAME_T + FRAME_B) / 2;
		const rawNeighbors: ProjectedNeighbor[] = [];

		for (const nb of shard.borderClusters) {
			const feat = featureById.get(nb.id);
			if (!feat?.geometry) continue;
			const nbPolys =
				feat.geometry.type === 'Polygon'
					? [feat.geometry.coordinates]
					: feat.geometry.coordinates;

			const paths: string[] = [];
			let bestArea = 0;
			let bestCx = 0;
			let bestCy = 0;
			let bestClipped: [number, number][] = [];

			for (const poly of nbPolys) {
				const ring = poly[0];
				if (!ring || ring.length < 3) continue;
				const rPts = ring.map((c) => toSvg(c[0], c[1]));
				paths.push(`${lineToPath(rPts)} Z`);
				const clipped = clipRingToRect(rPts, FRAME_L, FRAME_T, FRAME_R, FRAME_B);
				if (clipped.length >= 3) {
					const { area, cx, cy } = polyAreaCentroid(clipped);
					if (area > bestArea) {
						bestArea = area;
						bestCx = cx;
						bestCy = cy;
						bestClipped = clipped;
					}
				}
			}

			if (paths.length === 0 || bestArea < 120) continue;

			// If an L-shaped neighbor's centroid accidentally lands inside our cluster polygon,
			// pick the clipped vertex farthest from the center and pull slightly inward from frame edges
			let lx = bestCx;
			let ly = bestCy;
			if (clusterRingsSvg.some((r) => pointInRingSvg(lx, ly, r)) && bestClipped.length > 0) {
				let farPt = bestClipped[0];
				let farD = -1;
				for (const pt of bestClipped) {
					const d = Math.hypot(pt[0] - cCx, pt[1] - cCy);
					if (d > farD) {
						farD = d;
						farPt = pt;
					}
				}
				lx = farPt[0];
				ly = farPt[1];
			}

			const pref = nb.name.split(':')[0].trim();
			const rest = nb.name.includes(':') ? nb.name.split(':')[1].split('&')[0].trim() : '';
			const shortLabel =
				(prefixCounts.get(pref) || 0) > 1 && rest
					? `${pref.split('-')[0].trim()} · ${rest}`
					: pref.length > 22
						? pref.split('-')[0].trim()
						: pref;

			const rateText = pct(nb.vacancy_rate, 0);
			const diffPts = (nb.vacancy_rate - shard.cluster.vacancy_rate) * 100;
			const diffText = `${diffPts >= 0 ? '+' : ''}${diffPts.toFixed(1)} pts`;
			const fullRestText = `${shortLabel} · ${rateText}`;
			const pillW = Math.max(96, Math.min(280, fullRestText.length * 6.25 + 24));

			lx = Math.max(FRAME_L + pillW / 2 + 8, Math.min(FRAME_R - pillW / 2 - 8, lx));
			ly = Math.max(FRAME_T + 18, Math.min(FRAME_B - 18, ly));

			// Ensure the resting pill's corners never bleed over the current cluster's street grid!
			const pillTouchesCluster = (cx: number, cy: number): boolean => {
				const hw = pillW / 2 + 6;
				const hh = 14;
				const pts: [number, number][] = [
					[cx, cy],
					[cx - hw, cy - hh],
					[cx + hw, cy - hh],
					[cx - hw, cy + hh],
					[cx + hw, cy + hh],
					[cx - hw, cy],
					[cx + hw, cy]
				];
				return pts.some(([px, py]) => clusterRingsSvg.some((r) => pointInRingSvg(px, py, r)));
			};

			if (pillTouchesCluster(lx, ly)) {
				// Nudge radially outward away from the cluster center in small steps to clear the border
				const vx = lx - cCx;
				const vy = ly - cCy;
				const vlen = Math.hypot(vx, vy) || 1;
				const ux = vx / vlen;
				const uy = vy / vlen;
				for (let step = 12; step <= 110; step += 10) {
					const nx = Math.max(FRAME_L + pillW / 2 + 8, Math.min(FRAME_R - pillW / 2 - 8, lx + ux * step));
					const ny = Math.max(FRAME_T + 18, Math.min(FRAME_B - 18, ly + uy * step));
					if (!pillTouchesCluster(nx, ny)) {
						lx = nx;
						ly = ny;
						break;
					}
				}
			}

			rawNeighbors.push({
				nb,
				paths,
				label: shortLabel,
				rateText,
				diffText,
				lx: Number(lx.toFixed(1)),
				ly: Number(ly.toFixed(1)),
				pillW: Math.round(pillW),
				showAtRest: !pillTouchesCluster(lx, ly),
				area: bestArea
			});
		}

		// Largest visible neighbors get resting labels without overlapping each other or the cluster streets
		rawNeighbors.sort((a, b) => b.area - a.area);
		const placedPills: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
		for (const item of rawNeighbors) {
			const canShow = item.showAtRest && item.area >= 2400 && placedPills.length < 6;
			item.showAtRest = false;
			if (!canShow) continue;
			const box = {
				x0: item.lx - item.pillW / 2 - 4,
				y0: item.ly - 14,
				x1: item.lx + item.pillW / 2 + 4,
				y1: item.ly + 14
			};
			const collides = placedPills.some(
				(o) => !(box.x1 < o.x0 || box.x0 > o.x1 || box.y1 < o.y0 || box.y0 > o.y1)
			);
			if (!collides) {
				item.showAtRest = true;
				placedPills.push(box);
			}
		}

		const contextLines: ProjectedContext[] = shard.contextLines.map((ctx) => {
			const pts = ctx.line.map(([lng, lat]) => toSvg(lng, lat));
			return { ctx, pts, d: lineToPath(pts) };
		});

		const segments: ProjectedSeg[] = shard.segments.map((seg) => {
			const pts = seg.line.map(([lng, lat]) => toSvg(lng, lat));
			const midIdx = Math.floor(pts.length / 2);
			const a = pts[0];
			const b = pts[pts.length - 1];
			const mid: [number, number] =
				pts.length === 2 ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : pts[midIdx];
			const lenPx = Math.hypot(b[0] - a[0], b[1] - a[1]);
			const trimPts = trimPolyline(pts, 2.4);
			return { seg, pts, d: lineToPath(pts), dTrim: lineToPath(trimPts), mid, lenPx };
		});

		const horizMap = new Map<
			string,
			{ name: string; slug: string; minX: number; yAtMinX: number; weight: number; hasCommercial: boolean }
		>();
		const vertMap = new Map<
			string,
			{ name: string; slug: string; minY: number; xAtMinY: number; weight: number; hasCommercial: boolean }
		>();

		const registerForLabel = (
			name: string,
			slug: string,
			pts: [number, number][],
			weight: number,
			hasCommercial: boolean
		) => {
			if (!name || pts.length < 2) return;
			const a = pts[0];
			const b = pts[pts.length - 1];
			const dx = Math.abs(b[0] - a[0]);
			const dy = Math.abs(b[1] - a[1]);
			if (dx + dy < 6) return;

			if (dx >= dy) {
				const leftPt = a[0] <= b[0] ? a : b;
				const prev = horizMap.get(name);
				if (!prev) {
					horizMap.set(name, {
						name,
						slug,
						minX: leftPt[0],
						yAtMinX: leftPt[1],
						weight,
						hasCommercial
					});
				} else {
					prev.weight += weight;
					prev.hasCommercial = prev.hasCommercial || hasCommercial;
					if (leftPt[0] < prev.minX) {
						prev.minX = leftPt[0];
						prev.yAtMinX = leftPt[1];
					}
				}
			} else {
				const topPt = a[1] <= b[1] ? a : b;
				const prev = vertMap.get(name);
				if (!prev) {
					vertMap.set(name, {
						name,
						slug,
						minY: topPt[1],
						xAtMinY: topPt[0],
						weight,
						hasCommercial
					});
				} else {
					prev.weight += weight;
					prev.hasCommercial = prev.hasCommercial || hasCommercial;
					if (topPt[1] < prev.minY) {
						prev.minY = topPt[1];
						prev.xAtMinY = topPt[0];
					}
				}
			}
		};

		for (const item of segments) {
			registerForLabel(item.seg.streetName, item.seg.streetSlug, item.pts, item.seg.total + 4, true);
		}
		for (const item of contextLines) {
			const slug = item.ctx.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			registerForLabel(item.ctx.name, slug, item.pts, 1, false);
		}

		const horizRaw: MarginLabel[] = [...horizMap.values()]
			.map((v) => ({
				name: v.name,
				slug: v.slug,
				pos: v.yAtMinX,
				rawPos: v.yAtMinX,
				anchorCoord: v.minX,
				weight: v.weight,
				hasCommercial: v.hasCommercial
			}))
			.sort((a, b) => b.weight - a.weight);

		const horizLabels: MarginLabel[] = [];
		for (const lbl of horizRaw) {
			if (!horizLabels.some((o) => Math.abs(o.pos - lbl.pos) < 17)) {
				horizLabels.push(lbl);
			}
		}
		horizLabels.sort((a, b) => a.pos - b.pos);

		const vertRaw: MarginLabel[] = [...vertMap.values()]
			.map((v) => ({
				name: v.name,
				slug: v.slug,
				pos: v.xAtMinY,
				rawPos: v.xAtMinY,
				anchorCoord: v.minY,
				weight: v.weight,
				hasCommercial: v.hasCommercial
			}))
			.sort((a, b) => b.weight - a.weight);

		const estVertW = (name: string) => name.length * 6.5 + 14;
		const vertLabels: MarginLabel[] = [];
		for (const lbl of vertRaw) {
			const collides = vertLabels.some((o) => {
				const minGap = Math.max(56, (estVertW(o.name) + estVertW(lbl.name)) / 2 - 10);
				return Math.abs(o.pos - lbl.pos) < minGap;
			});
			if (!collides) {
				vertLabels.push({ ...lbl });
			}
		}
		vertLabels.sort((a, b) => a.pos - b.pos);
		// Gently separate tight neighboring avenue labels (e.g. "Madison Ave" & "Park Ave S") so text never touches
		for (let i = 1; i < vertLabels.length; i++) {
			const prev = vertLabels[i - 1];
			const cur = vertLabels[i];
			const needed = (estVertW(prev.name) + estVertW(cur.name)) / 2 + 4;
			const gap = cur.pos - prev.pos;
			if (gap < needed) {
				const shift = (needed - gap) / 2;
				prev.pos = Math.max(MARGIN_LEFT + 20, prev.pos - shift);
				cur.pos = Math.min(SVG_W - 24, cur.pos + shift);
			}
		}

		return {
			boundaryPaths,
			neighbors: rawNeighbors,
			contextLines,
			segments,
			horizLabels,
			vertLabels,
			allHorizMap: horizMap,
			allVertMap: vertMap
		};
	});

	const extraActiveHoriz = $derived.by(() => {
		if (!activeSeg) return null;
		if (blueprint.horizLabels.some((l) => l.name === activeSeg.streetName)) return null;
		const rec = blueprint.allHorizMap.get(activeSeg.streetName);
		if (!rec) return null;
		return {
			name: rec.name,
			slug: rec.slug,
			pos: rec.yAtMinX,
			rawPos: rec.yAtMinX,
			anchorCoord: rec.minX,
			weight: rec.weight,
			hasCommercial: true
		};
	});

	const extraActiveVert = $derived.by(() => {
		if (!activeSeg) return null;
		if (blueprint.vertLabels.some((l) => l.name === activeSeg.streetName)) return null;
		const rec = blueprint.allVertMap.get(activeSeg.streetName);
		if (!rec) return null;
		return {
			name: rec.name,
			slug: rec.slug,
			pos: rec.xAtMinY,
			rawPos: rec.xAtMinY,
			anchorCoord: rec.minY,
			weight: rec.weight,
			hasCommercial: true
		};
	});

	const orderedSegments = $derived.by(() => {
		const clear: ProjectedSeg[] = [];
		const vacant: ProjectedSeg[] = [];
		const sameStreet: ProjectedSeg[] = [];
		const active: ProjectedSeg[] = [];
		for (const item of blueprint.segments) {
			if (activeSeg && item.seg.id === activeSeg.id) {
				active.push(item);
			} else if (activeStreetSlug && item.seg.streetSlug === activeStreetSlug) {
				sameStreet.push(item);
			} else if (item.seg.rate > 0) {
				vacant.push(item);
			} else {
				clear.push(item);
			}
		}
		return [...clear, ...vacant, ...sameStreet, ...active];
	});

	function handleSegEnter(seg: SegmentSummary) {
		hoveredContext = null;
		hoveredSeg = seg;
		onHoverStreet(seg.streetSlug);
		onHoverSegment(seg.id);
	}

	function handleSegLeave() {
		hoveredSeg = null;
		onHoverStreet(null);
		onHoverSegment(null);
	}

	function openBlock(seg: SegmentSummary) {
		goto(`/cluster/${shard.cluster.id}/block/${seg.id}`);
	}
</script>

<div class="blueprint-wrap">
	<!-- Top Blueprint Toolbar -->
	<div class="bp-bar">
		<div class="bp-bar-left">
			<span class="bp-meta">
				{Math.abs(shard.gridAngleDeg) >= 2
					? `GRID STRAIGHTENED ${shard.gridAngleDeg > 0 ? '+' : ''}${shard.gridAngleDeg.toFixed(1)}°`
					: 'NORTH-SOUTH GRID'}
			</span>
		</div>

		<div class="bp-legend" aria-label="Vacancy color scale">
			<span class="lg-item"><i style="background:#c6c6bf"></i>0%</span>
			<span class="lg-item"><i style="background:#ebb09c"></i>1–9%</span>
			<span class="lg-item"><i style="background:#e4724e"></i>10–15%</span>
			<span class="lg-item"><i style="background:#d9381e"></i>16–24%</span>
			<span class="lg-item"><i style="background:#8f1422"></i>25%+</span>
			<span class="lg-item quiet"><i style="background:#e5e5e0"></i>Res</span>
		</div>
	</div>

	<!-- Straightened Architectural SVG Grid -->
	<div class="svg-stage">
		<svg
			viewBox="0 0 {SVG_W} {SVG_H}"
			class="grid-svg"
			role="img"
			aria-label="Straightened street blueprint of {shard.cluster.name}"
		>
			<defs>
				<clipPath id="map-frame-clip">
					<rect
						x={FRAME_L}
						y={FRAME_T}
						width={FRAME_R - FRAME_L}
						height={FRAME_B - FRAME_T}
						rx="6"
					/>
				</clipPath>
			</defs>

			<!-- Clean Swiss gallery canvas + subtle inner drafting plate -->
			<rect x="0" y="0" width={SVG_W} height={SVG_H} fill="#fafaf9" />
			<rect
				x={FRAME_L}
				y={FRAME_T}
				width={FRAME_R - FRAME_L}
				height={FRAME_B - FRAME_T}
				rx="6"
				fill="#fafaf9"
				stroke="#ebebea"
				stroke-width="1"
			/>

			<!-- Geographic Adjacent Cluster Territories (clipped cleanly inside drafting frame) -->
			<g class="neighbors-layer" clip-path="url(#map-frame-clip)">
				{#each blueprint.neighbors as item (item.nb.id)}
					{@const isNbHot = activeNeighborId === item.nb.id}
					<g
						class="nb-poly-group"
						class:hot={isNbHot}
						role="link"
						tabindex="0"
						aria-label="Adjacent cluster {item.nb.name}, {pct(item.nb.vacancy_rate, 1)} vacancy"
						onmouseenter={() => {
							hoveredNeighborId = item.nb.id;
							onHoverNeighbor(item.nb.id);
						}}
						onmouseleave={() => {
							hoveredNeighborId = null;
							onHoverNeighbor(null);
						}}
						onfocus={() => {
							hoveredNeighborId = item.nb.id;
							onHoverNeighbor(item.nb.id);
						}}
						onblur={() => {
							hoveredNeighborId = null;
							onHoverNeighbor(null);
						}}
						onclick={() => goto(`/cluster/${item.nb.id}`)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								goto(`/cluster/${item.nb.id}`);
							}
						}}
					>
						{#each item.paths as d}
							<path
								{d}
								fill={neighborFill(item.nb.vacancy_rate, isNbHot)}
								stroke={isNbHot ? '#111111' : '#dcdcd6'}
								stroke-width={isNbHot ? 1.25 : 0.9}
								stroke-dasharray={isNbHot ? undefined : '3 3'}
								class="nb-poly-path"
							/>
						{/each}
					</g>
				{/each}

				<!-- Crisp current cluster territory cutout so our streets sit on pure bright paper -->
				{#each blueprint.boundaryPaths as d}
					<path {d} fill="#fafaf9" stroke="#d8d8d2" stroke-width="1" pointer-events="none" />
				{/each}
			</g>

			<!-- Whisper-faint dashed guide hairlines on hover (subtle orientation without pulling focus) -->
			<g class="leader-layer">
				{#each blueprint.horizLabels as lbl (lbl.name)}
					{@const obscuredByExtra = Boolean(extraActiveHoriz && Math.abs(lbl.pos - extraActiveHoriz.pos) < 17)}
					{@const isHot =
						!obscuredByExtra &&
						(activeStreetSlug === lbl.slug || activeCrossNames.has(lbl.name.toLowerCase()))}
					{#if isHot}
						<line
							x1={MARGIN_LEFT - 10}
							y1={lbl.rawPos}
							x2={Math.max(MARGIN_LEFT, lbl.anchorCoord - 6)}
							y2={lbl.rawPos}
							stroke="#c8c8c2"
							stroke-width="0.9"
							stroke-dasharray="2 3"
						/>
					{/if}
				{/each}
				{#if extraActiveHoriz}
					<line
						x1={MARGIN_LEFT - 10}
						y1={extraActiveHoriz.rawPos}
						x2={Math.max(MARGIN_LEFT, extraActiveHoriz.anchorCoord - 6)}
						y2={extraActiveHoriz.rawPos}
						stroke="#c8c8c2"
						stroke-width="0.9"
						stroke-dasharray="2 3"
					/>
				{/if}
				{#each blueprint.vertLabels as lbl (lbl.name)}
					{@const obscuredByExtra = Boolean(extraActiveVert && Math.abs(lbl.pos - extraActiveVert.pos) < 58)}
					{@const isHot =
						!obscuredByExtra &&
						(activeStreetSlug === lbl.slug || activeCrossNames.has(lbl.name.toLowerCase()))}
					{#if isHot}
						<line
							x1={lbl.rawPos}
							y1={MARGIN_TOP - 10}
							x2={lbl.rawPos}
							y2={Math.max(MARGIN_TOP, lbl.anchorCoord - 6)}
							stroke="#c8c8c2"
							stroke-width="0.9"
							stroke-dasharray="2 3"
						/>
					{/if}
				{/each}
				{#if extraActiveVert}
					<line
						x1={extraActiveVert.rawPos}
						y1={MARGIN_TOP - 10}
						x2={extraActiveVert.rawPos}
						y2={Math.max(MARGIN_TOP, extraActiveVert.anchorCoord - 6)}
						stroke="#c8c8c2"
						stroke-width="0.9"
						stroke-dasharray="2 3"
					/>
				{/if}
			</g>

			<!-- Continuous whisper-light underlying grid skeleton across ALL streets so intersections read crisply -->
			<g class="skeleton-layer" pointer-events="none">
				{#each blueprint.segments as item (item.seg.id)}
					<path
						d={item.d}
						fill="none"
						stroke="#e8e8e3"
						stroke-width="1.2"
						stroke-linecap="square"
					/>
				{/each}
			</g>

			<!-- Quiet Residential / Non-Retail Context Streets -->
			<g class="context-layer">
				{#each blueprint.contextLines as item (item.ctx.id)}
					{@const isCtxHovered = hoveredContext?.id === item.ctx.id}
					<path
						d={item.d}
						fill="none"
						stroke={isCtxHovered ? '#9e9e98' : '#e8e8e3'}
						stroke-width={isCtxHovered ? 4 : 1.2}
						stroke-linecap={isCtxHovered ? 'round' : 'butt'}
						stroke-linejoin="round"
						class="ctx-stroke"
					/>
					<path
						d={item.d}
						fill="none"
						stroke="transparent"
						stroke-width="14"
						stroke-linecap="round"
						role="presentation"
						onmouseenter={() => {
							hoveredSeg = null;
							hoveredContext = item.ctx;
						}}
						onmouseleave={() => {
							if (hoveredContext?.id === item.ctx.id) hoveredContext = null;
						}}
					/>
					{#if isCtxHovered}
						{@const midPt = item.pts[Math.floor(item.pts.length / 2)]}
						{@const ctxText = `${item.ctx.name}${item.ctx.between ? ` (${item.ctx.between})` : ''} · Residential`}
						{@const ctxW = Math.max(150, Math.min(SVG_W - MARGIN_LEFT - 24, ctxText.length * 6.35 + 26))}
						{@const ctxX = Math.max(MARGIN_LEFT + ctxW / 2, Math.min(SVG_W - 16 - ctxW / 2, midPt[0]))}
						{@const ctxY = midPt[1] < MARGIN_TOP + 30 ? midPt[1] + 22 : midPt[1] - 20}
						<g transform="translate({ctxX}, {ctxY})" pointer-events="none">
							<rect x={-ctxW / 2} y="-12" width={ctxW} height="22" rx="4" fill="#ffffff" stroke="#d4d4ce" stroke-width="1" />
							<text
								x="0"
								y="2"
								text-anchor="middle"
								fill="#5c5c58"
								font-size="10"
								font-weight="500"
								font-family="JetBrains Mono, ui-monospace, monospace"
							>
								{ctxText}
							</text>
						</g>
					{/if}
				{/each}
			</g>

			<!-- Commercial 1-Block Stretches -->
			<g class="segments-layer">
				{#each orderedSegments as item (item.seg.id)}
					{@const isActive = activeSeg?.id === item.seg.id}
					{@const isSameStreet = !isActive && activeStreetSlug === item.seg.streetSlug}
					{@const isDimmed = Boolean(activeStreetSlug && !isActive && !isSameStreet)}
					{@const color = isActive && item.seg.rate === 0 ? '#3f3f3c' : segColor(item.seg.rate)}
					{@const sw = segWidth(item.seg.rate, isActive, isSameStreet)}
					<g
						class="seg-group"
						class:is-active={isActive}
						class:is-same={isSameStreet}
						class:is-dimmed={isDimmed}
						role="link"
						tabindex="0"
						aria-label="{item.seg.streetName}, {item.seg.between}, {pct(item.seg.rate, 1)} vacant, {item.seg.vacant} of {item.seg.total} storefronts"
						onmouseenter={() => handleSegEnter(item.seg)}
						onmouseleave={handleSegLeave}
						onfocus={() => handleSegEnter(item.seg)}
						onblur={handleSegLeave}
						onclick={() => openBlock(item.seg)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								openBlock(item.seg);
							}
						}}
					>
						{#if isActive}
							<!-- Rounded architectural focus pill when magnified on hover -->
							<path
								d={item.d}
								fill="none"
								stroke="#111111"
								stroke-width="19"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
							<path
								d={item.d}
								fill="none"
								stroke="#ffffff"
								stroke-width="16"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
							<path
								d={item.d}
								fill="none"
								stroke={color}
								stroke-width={sw}
								stroke-linecap="round"
								stroke-linejoin="round"
								class="seg-fill"
							/>
						{:else}
							<!-- Seamless full-length CAD stroke (fills every intersection cleanly in the hotter street's color) -->
							<path
								d={item.d}
								fill="none"
								stroke={color}
								stroke-width={sw}
								stroke-linecap="round"
								stroke-linejoin="round"
								class="seg-fill"
							/>
						{/if}

						<!-- Generous invisible hit area for smooth scrubbing -->
						<path
							d={item.d}
							fill="none"
							stroke="transparent"
							stroke-width="22"
							stroke-linecap="round"
						/>
					</g>
				{/each}
			</g>

			<!-- Clickable Neighbor Territory Pills (painted ABOVE street context lines so stubs never slice through pill text) -->
			<g class="neighbor-pills-layer" clip-path="url(#map-frame-clip)">
				{#each blueprint.neighbors as item (item.nb.id)}
					{@const isNbHot = activeNeighborId === item.nb.id}
					{#if item.showAtRest || isNbHot}
						{@const txt = isNbHot
							? `${item.label} · ${pct(item.nb.vacancy_rate, 1)} (${item.diffText}) ↗`
							: `${item.label} · ${item.rateText} ↗`}
						{@const restW = Math.max(item.pillW + 12, txt.length * 6.2 + 20)}
						{@const w = isNbHot ? Math.max(restW, Math.min(FRAME_R - FRAME_L - 20, txt.length * 6.3 + 26)) : restW}
						{@const px = Math.max(FRAME_L + w / 2 + 8, Math.min(FRAME_R - w / 2 - 8, item.lx))}
						{@const py = Math.max(FRAME_T + 16, Math.min(FRAME_B - 16, item.ly))}
						<g
							transform="translate({px}, {py})"
							class="nb-pill"
							role="link"
							tabindex="-1"
							aria-label="Open {item.nb.name}"
							onmouseenter={() => {
								hoveredNeighborId = item.nb.id;
								onHoverNeighbor(item.nb.id);
							}}
							onmouseleave={() => {
								hoveredNeighborId = null;
								onHoverNeighbor(null);
							}}
							onclick={() => goto(`/cluster/${item.nb.id}`)}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									goto(`/cluster/${item.nb.id}`);
								}
							}}
						>
							<rect
								x={-w / 2}
								y="-11"
								width={w}
								height="22"
								rx="4"
								fill={isNbHot ? '#111111' : 'rgba(255,255,255,0.94)'}
								stroke={isNbHot ? '#111111' : '#cfcfc9'}
								stroke-width="1"
							/>
							<text
								x="0"
								y="3"
								text-anchor="middle"
								fill={isNbHot ? '#ffffff' : '#5e5e59'}
								font-size="10"
								font-weight={isNbHot ? '600' : '500'}
								font-family="JetBrains Mono, ui-monospace, monospace"
							>
								{txt}
							</text>
						</g>
					{/if}
				{/each}
			</g>

			<!-- Top-most Active Block Hover Pill (always sits above neighbor pills & streets) -->
			<g class="active-tooltip-layer" pointer-events="none">
				{#each orderedSegments as item (item.seg.id)}
					{#if activeSeg?.id === item.seg.id}
						{@const deltaTag =
							item.seg.vacantDelta !== null && item.seg.vacantDelta !== undefined && item.seg.vacantDelta !== 0
								? ` · ${item.seg.vacantDelta > 0 ? `+${item.seg.vacantDelta}` : item.seg.vacantDelta} vs '24`
								: ''}
						{@const pillText = `${item.seg.streetName} (${item.seg.between}) · ${item.seg.vacant}/${item.seg.total} empty (${pct(item.seg.rate, 1)})${deltaTag} →`}
						{@const pillW = Math.max(170, Math.min(SVG_W - MARGIN_LEFT - 24, pillText.length * 6.6 + 28))}
						{@const pillX = Math.max(MARGIN_LEFT + pillW / 2, Math.min(SVG_W - 16 - pillW / 2, item.mid[0]))}
						{@const pillY = item.mid[1] < MARGIN_TOP + 34 ? item.mid[1] + 24 : item.mid[1] - 24}
						<g transform="translate({pillX}, {pillY})">
							<rect
								x={-pillW / 2}
								y="-13"
								width={pillW}
								height="24"
								rx="5"
								fill="#111111"
							/>
							<text
								x="0"
								y="2.5"
								text-anchor="middle"
								fill="#ffffff"
								font-size="10.5"
								font-weight="500"
								font-family="JetBrains Mono, ui-monospace, monospace"
							>
								{pillText}
							</text>
						</g>
					{/if}
				{/each}
			</g>

			<!-- LEFT MARGIN: Horizontal Street Labels (quiet bold + hairline accent on hover, no heavy black boxes) -->
			<g class="horiz-labels">
				{#each blueprint.horizLabels as lbl (lbl.name)}
					{@const obscuredByExtra = Boolean(extraActiveHoriz && Math.abs(lbl.pos - extraActiveHoriz.pos) < 17)}
					{#if !obscuredByExtra}
						{@const isHot =
							activeStreetSlug === lbl.slug || activeCrossNames.has(lbl.name.toLowerCase())}
						{@const isDim = Boolean(activeStreetSlug && !isHot)}
						<g
							transform="translate({MARGIN_LEFT - 14}, {lbl.pos})"
							class="margin-lbl"
							class:dimmed={isDim}
							role="button"
							tabindex="0"
							aria-label="Inspect {lbl.name}"
							onclick={() => {
								const seg = shard.segments.find((s) => s.streetSlug === lbl.slug);
								if (seg) openBlock(seg);
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									const seg = shard.segments.find((s) => s.streetSlug === lbl.slug);
									if (seg) openBlock(seg);
								}
							}}
							onmouseenter={() => onHoverStreet(lbl.slug)}
							onmouseleave={() => onHoverStreet(null)}
						>
							{#if isHot}
								<circle cx="2" cy="0" r="2.2" fill="#ff4200" />
							{/if}
							<text
								x="-6"
								y="3.5"
								text-anchor="end"
								fill={isHot ? '#111111' : lbl.hasCommercial ? '#2e2e2c' : '#969690'}
								font-size="11"
								font-weight={isHot ? '700' : lbl.hasCommercial ? '500' : '400'}
								font-family="Inter, -apple-system, sans-serif"
							>
								{lbl.name}
							</text>
						</g>
					{/if}
				{/each}

				{#if extraActiveHoriz}
					<g
						transform="translate({MARGIN_LEFT - 14}, {extraActiveHoriz.pos})"
						class="margin-lbl"
						pointer-events="none"
					>
						<circle cx="2" cy="0" r="2.2" fill="#ff4200" />
						<text
							x="-6"
							y="3.5"
							text-anchor="end"
							fill="#111111"
							font-size="11"
							font-weight="700"
							font-family="Inter, -apple-system, sans-serif"
						>
							{extraActiveHoriz.name}
						</text>
					</g>
				{/if}
			</g>

			<!-- TOP MARGIN: Vertical Avenue Labels -->
			<g class="vert-labels">
				{#each blueprint.vertLabels as lbl (lbl.name)}
					{@const obscuredByExtra = Boolean(extraActiveVert && Math.abs(lbl.pos - extraActiveVert.pos) < 58)}
					{#if !obscuredByExtra}
						{@const isHot =
							activeStreetSlug === lbl.slug || activeCrossNames.has(lbl.name.toLowerCase())}
						{@const isDim = Boolean(activeStreetSlug && !isHot)}
						<g
							transform="translate({lbl.pos}, {MARGIN_TOP - 16})"
							class="margin-lbl"
							class:dimmed={isDim}
							role="button"
							tabindex="0"
							aria-label="Inspect {lbl.name}"
							onclick={() => {
								const seg = shard.segments.find((s) => s.streetSlug === lbl.slug);
								if (seg) openBlock(seg);
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									const seg = shard.segments.find((s) => s.streetSlug === lbl.slug);
									if (seg) openBlock(seg);
								}
							}}
							onmouseenter={() => onHoverStreet(lbl.slug)}
							onmouseleave={() => onHoverStreet(null)}
						>
							{#if isHot}
								<circle cx="0" cy="4" r="2.2" fill="#ff4200" />
							{/if}
							<text
								x="0"
								y="-4"
								text-anchor="middle"
								fill={isHot ? '#111111' : lbl.hasCommercial ? '#2e2e2c' : '#969690'}
								font-size="11"
								font-weight={isHot ? '700' : lbl.hasCommercial ? '500' : '400'}
								font-family="Inter, -apple-system, sans-serif"
							>
								{lbl.name}
							</text>
						</g>
					{/if}
				{/each}

				{#if extraActiveVert}
					<g
						transform="translate({extraActiveVert.pos}, {MARGIN_TOP - 16})"
						class="margin-lbl"
						pointer-events="none"
					>
						<circle cx="0" cy="4" r="2.2" fill="#ff4200" />
						<text
							x="0"
							y="-4"
							text-anchor="middle"
							fill="#111111"
							font-size="11"
							font-weight="700"
							font-family="Inter, -apple-system, sans-serif"
						>
							{extraActiveVert.name}
						</text>
					</g>
				{/if}
			</g>

			<!-- Minimal Compass Indicator -->
			<g transform="translate(68, 38)" pointer-events="none">
				<circle cx="0" cy="0" r="18" fill="#ffffff" stroke="#e2e2dd" stroke-width="1" />
				<g transform="rotate({-shard.gridAngleDeg})">
					<polygon points="0,-12 3.2,-1.5 -3.2,-1.5" fill="#ff4200" />
					<polygon points="0,12 3.2,1.5 -3.2,1.5" fill="#c8c8c0" />
					<circle cx="0" cy="0" r="1.5" fill="#111111" />
				</g>
				<text x="0" y="29" text-anchor="middle" font-size="8.5" font-weight="600" fill="#8c8c86" font-family="JetBrains Mono, ui-monospace, monospace">
					TRUE N
				</text>
			</g>
		</svg>
	</div>
</div>

<style>
	.blueprint-wrap {
		display: flex;
		flex-direction: column;
		height: 100%;
		width: 100%;
		background: #fafaf9;
		position: relative;
		overflow: hidden;
	}

	.bp-bar {
		flex: none;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 16px;
		padding: 9px 18px;
		background: var(--panel);
		border-bottom: 1px solid var(--rule);
		font-size: 12px;
	}

	.bp-bar-left {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.bp-meta {
		font-family: var(--font-mono);
		font-size: 10.5px;
		font-weight: 500;
		letter-spacing: 0.06em;
		color: var(--ink);
		background: var(--quiet);
		padding: 2px 8px;
		border-radius: 4px;
	}

	.bp-legend {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--muted);
	}

	.lg-item {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.lg-item i {
		width: 10px;
		height: 4px;
		border-radius: 2px;
		display: inline-block;
	}

	.svg-stage {
		flex: 1;
		min-height: 0;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 8px;
	}

	.grid-svg {
		width: 100%;
		height: 100%;
		max-height: 100%;
		display: block;
		user-select: none;
	}

	.nb-poly-group,
	.nb-pill {
		cursor: pointer;
		outline: none;
	}

	.nb-poly-path {
		transition: fill 0.14s ease, stroke 0.14s ease;
	}

	.ctx-stroke {
		transition: stroke 0.14s ease, stroke-width 0.14s ease;
	}

	.seg-group {
		cursor: pointer;
		outline: none;
		transition: opacity 0.14s ease;
	}

	.seg-group.is-dimmed {
		opacity: 0.38;
	}

	.seg-fill {
		transition: stroke-width 0.15s cubic-bezier(0.2, 0.9, 0.25, 1);
	}

	.margin-lbl {
		cursor: pointer;
		transition: opacity 0.14s ease;
		font-variant-numeric: tabular-nums;
	}

	.margin-lbl.dimmed {
		opacity: 0.34;
	}
</style>
