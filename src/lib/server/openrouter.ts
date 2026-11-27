import { env } from '$env/dynamic/private';

export interface OpenRouterCitation {
	title: string;
	url: string;
}

export interface OpenRouterResult {
	text: string;
	citations: OpenRouterCitation[];
	model: string;
}

export function getOpenRouterKey(platform?: App.Platform): string {
	return (
		env.OPENROUTER_API_KEY ||
		(platform?.env as Record<string, string> | undefined)?.OPENROUTER_API_KEY ||
		''
	).trim();
}

export function getDefaultModel(platform?: App.Platform, online = false): string {
	const custom = (
		env.OPENROUTER_MODEL ||
		(platform?.env as Record<string, string> | undefined)?.OPENROUTER_MODEL ||
		''
	).trim();
	const base = custom || 'google/gemini-2.5-flash';
	if (online && !base.endsWith(':online')) return `${base}:online`;
	return base;
}

export function getModelList(platform?: App.Platform, online = false): string[] {
	const custom = (
		env.OPENROUTER_MODEL ||
		(platform?.env as Record<string, string> | undefined)?.OPENROUTER_MODEL ||
		''
	).trim();
	const bases = custom
		? [custom, 'openai/gpt-4o-mini', 'google/gemini-2.5-flash']
		: ['google/gemini-2.5-flash', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku'];
	const uniq = [...new Set(bases)];
	return online ? uniq.map((m) => (m.endsWith(':online') ? m : `${m}:online`)) : uniq;
}

export async function callOpenRouter(opts: {
	apiKey: string;
	model: string;
	fallbackModels?: string[];
	system: string;
	user: string;
	imageDataUrl?: string;
	temperature?: number;
	maxTokens?: number;
	jsonMode?: boolean;
	timeoutMs?: number;
}): Promise<OpenRouterResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 16000);

	try {
		const isOnline = opts.model.endsWith(':online');
		const fallbacks =
			opts.fallbackModels ??
			(isOnline
				? ['openai/gpt-4o-mini:online', 'anthropic/claude-3.5-haiku:online']
				: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku']);
		const models = [...new Set([opts.model, ...fallbacks])];

		const userContent = opts.imageDataUrl
			? [
					{ type: 'text', text: opts.user },
					{ type: 'image_url', image_url: { url: opts.imageDataUrl } }
				]
			: opts.user;

		const body: Record<string, unknown> = {
			model: models[0],
			models,
			messages: [
				{ role: 'system', content: opts.system },
				{ role: 'user', content: userContent }
			],
			temperature: opts.temperature ?? 0.2,
			max_tokens: opts.maxTokens ?? 550
		};
		if (opts.jsonMode) {
			body.response_format = { type: 'json_object' };
		}

		const res = await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://nycstorefront.com',
				'X-Title': 'NYC Storefront Vacancy'
			},
			body: JSON.stringify(body)
		});

		clearTimeout(timer);

		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 180)}`);
		}

		const data = (await res.json()) as {
			model?: string;
			choices?: Array<{
				message?: {
					content?: string;
					annotations?: Array<{
						type?: string;
						url_citation?: { url?: string; title?: string };
					}>;
				};
			}>;
		};

		const msg = data.choices?.[0]?.message;
		const text = (msg?.content || '').trim();
		const citations: OpenRouterCitation[] = [];
		const seenUrls = new Set<string>();

		for (const ann of msg?.annotations ?? []) {
			const url = ann.url_citation?.url?.trim();
			if (!url || seenUrls.has(url)) continue;
			seenUrls.add(url);
			let title = ann.url_citation?.title?.trim() || '';
			if (!title) {
				try {
					title = new URL(url).hostname.replace(/^www\./, '');
				} catch {
					title = url;
				}
			}
			citations.push({ title, url });
		}

		return {
			text,
			citations: citations.slice(0, 5),
			model: data.model || opts.model
		};
	} catch (e) {
		clearTimeout(timer);
		throw e;
	}
}

export function extractJsonObject<T>(raw: string): T | null {
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(cleaned.slice(start, end + 1)) as T;
	} catch {
		return null;
	}
}
