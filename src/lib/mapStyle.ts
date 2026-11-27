import type maplibregl from 'maplibre-gl';

export const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

/**
 * Single-hue Swiss vermilion/crimson scale for elevated vacancy (>= 10%).
 * Healthy clusters (< 10%) stay clear (0 fill opacity) and use a subtle graphite tint on hover.
 */
export const VACANCY_COLOR_EXPR: maplibregl.ExpressionSpecification = [
	'step',
	['coalesce', ['get', 'vacancy_rate'], ['get', 'rate'], 0],
	'#111111', // < 10% (shown at 0 opacity resting, 0.06 on hover)
	0.10,
	'#eb6b49', // 10–15%
	0.15,
	'#e04826', // 15–20%
	0.20,
	'#c4281c', // 20–28%
	0.28,
	'#8c1420' // 28%+
];

export const VACANCY_OPACITY_EXPR: maplibregl.ExpressionSpecification = [
	'step',
	['coalesce', ['get', 'vacancy_rate'], ['get', 'rate'], 0],
	0.0, // < 10% healthy turnover = clean map
	0.10,
	0.16,
	0.15,
	0.27,
	0.20,
	0.39,
	0.28,
	0.52
];

export type MapColorMode = 'vacancy' | 'trend';

export const TREND_COLOR_EXPR: maplibregl.ExpressionSpecification = [
	'step',
	['coalesce', ['get', 'yoy_change'], 0],
	'#0e6e48', // <= -4 pts (strongly improving)
	-0.04,
	'#1f8a5b', // -4 to -1.5 pts (improving)
	-0.015,
	'#111111', // -1.5 to +1.5 pts (flat / clean map)
	0.015,
	'#e04826', // +1.5 to +4 pts (worsening)
	0.04,
	'#9b1c24' // >= +4 pts (sharply worsening)
];

export const TREND_OPACITY_EXPR: maplibregl.ExpressionSpecification = [
	'step',
	['coalesce', ['get', 'yoy_change'], 0],
	0.44, // <= -4 pts
	-0.04,
	0.25, // -4 to -1.5 pts
	-0.015,
	0.0, // flat = clean map
	0.015,
	0.26, // +1.5 to +4 pts
	0.04,
	0.46 // >= +4 pts
];

export function spotlightOpacityExpr(
	activeId: string,
	mode: MapColorMode = 'vacancy'
): maplibregl.ExpressionSpecification {
	if (mode === 'trend') {
		return [
			'case',
			['==', ['get', 'id'], activeId],
			[
				'step',
				['coalesce', ['get', 'yoy_change'], 0],
				0.54,
				-0.04,
				0.34,
				-0.015,
				0.07,
				0.015,
				0.35,
				0.04,
				0.56
			],
			[
				'step',
				['coalesce', ['get', 'yoy_change'], 0],
				0.18,
				-0.04,
				0.10,
				-0.015,
				0.0,
				0.015,
				0.10,
				0.04,
				0.18
			]
		];
	}
	return [
		'case',
		['==', ['get', 'id'], activeId],
		[
			'step',
			['coalesce', ['get', 'vacancy_rate'], 0],
			0.06, // subtle neutral tint when hovering a healthy (<10%) cluster
			0.10,
			0.22,
			0.15,
			0.34,
			0.20,
			0.46,
			0.28,
			0.58
		],
		// Softly dim all other clusters while hovering one
		[
			'step',
			['coalesce', ['get', 'vacancy_rate'], 0],
			0.0,
			0.10,
			0.06,
			0.15,
			0.10,
			0.20,
			0.15,
			0.28,
			0.20
		]
	];
}

/**
 * Upgrades OpenFreeMap Positron for clean NYC street navigation:
 *  - Lowers minzoom on `highway-name-minor` (15 -> 12.6) so cross-streets appear early.
 *  - Uses crisp dark-slate labels with subtle white halos so the underlying grid stays legible.
 */
export function prepareStreetGridBasemap(map: maplibregl.Map): {
	underRoadsId?: string;
	underLabelsId?: string;
} {
	const styleLayers = map.getStyle().layers || [];
	const underRoadsId =
		styleLayers.find((l) => l.id === 'highway_minor' || l.id === 'highway_path')?.id ||
		styleLayers.find((l) => /highway|road/i.test(l.id) && l.type === 'line')?.id ||
		styleLayers.find((l) => l.type === 'symbol')?.id;
	const underLabelsId =
		styleLayers.find((l) => l.id === 'highway-name-path' || l.id === 'highway-name-minor')?.id ||
		styleLayers.find((l) => l.type === 'symbol')?.id;

	if (map.getLayer('highway_minor')) {
		map.setPaintProperty('highway_minor', 'line-color', 'rgba(255, 255, 255, 0.94)');
		map.setPaintProperty('highway_minor', 'line-width', [
			'interpolate',
			['linear'],
			['zoom'],
			11,
			0.75,
			13,
			1.6,
			15,
			4.2,
			17,
			8.5
		]);
	}

	if (map.getLayer('highway_major_casing')) {
		map.setPaintProperty('highway_major_casing', 'line-color', 'rgba(17, 17, 17, 0.28)');
	}

	if (map.getLayer('highway_major_inner')) {
		map.setPaintProperty('highway_major_inner', 'line-color', '#ffffff');
	}

	if (map.getLayer('highway-name-minor')) {
		map.setLayerZoomRange('highway-name-minor', 12.6, 24);
		map.setLayoutProperty('highway-name-minor', 'text-font', ['Noto Sans Bold']);
		map.setLayoutProperty('highway-name-minor', 'symbol-spacing', 220);
		map.setLayoutProperty('highway-name-minor', 'text-padding', 3);
		map.setLayoutProperty('highway-name-minor', 'text-size', [
			'interpolate',
			['linear'],
			['zoom'],
			12.6,
			10,
			14,
			11.5,
			16,
			13
		]);
		map.setPaintProperty('highway-name-minor', 'text-color', '#262624');
		map.setPaintProperty('highway-name-minor', 'text-halo-color', 'rgba(255, 255, 255, 0.96)');
		map.setPaintProperty('highway-name-minor', 'text-halo-width', 2);
		map.setPaintProperty('highway-name-minor', 'text-halo-blur', 0.4);
	}

	if (map.getLayer('highway-name-major')) {
		map.setLayerZoomRange('highway-name-major', 11.2, 24);
		map.setLayoutProperty('highway-name-major', 'text-font', ['Noto Sans Bold']);
		map.setLayoutProperty('highway-name-major', 'symbol-spacing', 190);
		map.setLayoutProperty('highway-name-major', 'text-size', [
			'interpolate',
			['linear'],
			['zoom'],
			11.5,
			11,
			13.5,
			12.5,
			16,
			14.5
		]);
		map.setPaintProperty('highway-name-major', 'text-color', '#111111');
		map.setPaintProperty('highway-name-major', 'text-halo-color', '#ffffff');
		map.setPaintProperty('highway-name-major', 'text-halo-width', 2.4);
		map.setPaintProperty('highway-name-major', 'text-halo-blur', 0.3);
	}

	for (const id of ['label_other', 'label_village', 'label_town']) {
		if (map.getLayer(id)) {
			map.setPaintProperty(id, 'text-color', '#4a4a46');
			map.setPaintProperty(id, 'text-halo-color', 'rgba(255, 255, 255, 0.92)');
			map.setPaintProperty(id, 'text-halo-width', 1.8);
		}
	}

	return { underRoadsId, underLabelsId };
}
