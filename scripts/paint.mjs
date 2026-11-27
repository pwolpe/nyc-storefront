#!/usr/bin/env node
/**
 * Gates Down NYC — Repeatable Nano Banana / OpenRouter Claymation Generator
 *
 * Generates additional stop-motion claymation scenes in the exact house style
 * and converts them to lightweight WebP files in static/art/.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node scripts/paint.mjs [scene-id]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const STYLE_BIBLE =
	'Stop-motion Aardman Animations / Wes Anderson miniature polymer claymation style, visible matte hand-sculpted texture with subtle thumbprints, warm golden NYC afternoon studio light, shallow depth of field, cozy editorial civic-journalism wit.';

const SCENES = {
	'bodega-thriving': {
		aspect: '16:9',
		prompt: `${STYLE_BIBLE} A bustling miniature clay New York City corner bodega with striped green awning, glowing neon OPEN sign, fresh fruit crates outside, and a plump orange clay bodega cat perched happily in the sunlit window.`
	},
	'corridor-8th-ave': {
		aspect: '16:9',
		prompt: `${STYLE_BIBLE} A miniature claymation sidewalk along 8th Avenue in Chelsea Manhattan: a vibrant clay bagel shop next to two dark shuttered storefronts with corrugated steel roll-down gates and fluttering yellow FOR LEASE signs, tiny pigeon inspector walking by with a clipboard.`
	},
	'politician-receipt': {
		aspect: '16:9',
		prompt: `${STYLE_BIBLE} A determined little claymation NYC pigeon in a navy inspector cap handing a long crisp white printed storefront receipt to a miniature clay City Hall mailbox with a tiny brass flag raised.`
	}
};

async function generateScene(id) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) {
		console.error('Set OPENROUTER_API_KEY=sk-or-... to generate new claymation scenes via Nano Banana / Gemini on OpenRouter.');
		process.exit(1);
	}
	const scene = SCENES[id];
	if (!scene) {
		console.error(`Unknown scene "${id}". Available: ${Object.keys(SCENES).join(', ')}`);
		process.exit(1);
	}
	console.log(`Painting "${id}" via OpenRouter (google/gemini-2.5-flash-image-preview)...`);
	const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': 'https://wolpe.co',
			'X-Title': 'Gates Down NYC'
		},
		body: JSON.stringify({
			model: process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image-preview',
			modalities: ['image', 'text'],
			messages: [{ role: 'user', content: scene.prompt }]
		})
	});
	if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
	const json = await res.json();
	const imgUrl = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
	if (!imgUrl) throw new Error('No image returned from OpenRouter');
	const base64 = imgUrl.replace(/^data:image\/\w+;base64,/, '');
	const rawPath = path.join('/tmp', `${id}.png`);
	const outPath = path.resolve(import.meta.dirname, '..', 'static', 'art', `${id}.webp`);
	fs.writeFileSync(rawPath, Buffer.from(base64, 'base64'));
	execSync(`cwebp -q 82 -resize 1200 0 "${rawPath}" -o "${outPath}"`);
	console.log(`Saved optimized claymation WebP → ${outPath}`);
}

const target = process.argv[2];
if (!target) {
	console.log('Available scenes:', Object.keys(SCENES).join(', '));
	console.log('Run: OPENROUTER_API_KEY=... npm run paint -- <scene-id>');
	process.exit(0);
}
generateScene(target).catch((e) => {
	console.error(e);
	process.exit(1);
});
