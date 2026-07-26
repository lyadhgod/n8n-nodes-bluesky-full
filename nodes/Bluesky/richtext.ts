/**
 * Detection of rich-text facets (mentions, links, hashtags) in post text.
 *
 * AT Protocol facet indices are byte offsets into the UTF-8 encoding of the
 * text, not JavaScript string indices, so every offset is converted explicitly.
 * See https://docs.bsky.app/docs/advanced-guides/post-richtext
 *
 * This module is deliberately dependency-free (no imports, including from the
 * shared `constants.ts`, so its three `app.bsky.richtext.facet#*` `$type`
 * strings are inlined rather than imported): `test/richtext.test.ts` runs it
 * directly via `node test/richtext.test.ts`, using Node's native TypeScript
 * type-stripping rather than a bundler or `tsc`. That loader resolves relative
 * imports like a plain ESM host — it requires an explicit file extension
 * (`../../constants.ts`) — but this project's actual build (`n8n-node build`,
 * a raw `tsc` invocation) rejects `.ts` extensions in import specifiers unless
 * `allowImportingTsExtensions` is set, which in turn requires `noEmit`, and
 * `tsc` here does emit. The two resolution rules can't both be satisfied, so
 * this file just avoids importing anything.
 */

export type DetectedFacetType = 'mention' | 'link' | 'tag';

/** A rich-text token found in post text, not yet resolved into an AT Protocol facet */
export interface DetectedFacet {
	type: DetectedFacetType;
	/** Handle without `@`, the URL, or the tag without `#` */
	value: string;
	/** UTF-8 byte offset of the first byte of the token (inclusive) */
	byteStart: number;
	/** UTF-8 byte offset one past the last byte of the token (exclusive) */
	byteEnd: number;
}

/** An AT Protocol rich-text facet, as embedded in a post record's `facets` array */
export interface Facet {
	index: { byteStart: number; byteEnd: number };
	features: Array<{ $type: string; did?: string; uri?: string; tag?: string }>;
}

const encoder = new TextEncoder();

/** Byte length of a string's UTF-8 encoding, since facet offsets are byte-, not char-, based */
const byteLength = (text: string): number => encoder.encode(text).length;

// One pass per facet type rather than a single combined regex: each type has its
// own token shape and validation rules (see `isValid`), and running them as separate
// matchAll passes keeps that logic readable instead of one alternation with shared capture groups.
const PATTERNS: Array<{ type: DetectedFacetType; regex: RegExp }> = [
	{ type: 'link', regex: /(^|[\s(])(https?:\/\/[^\s)]+)/g },
	{ type: 'mention', regex: /(^|[\s(])(@[a-zA-Z0-9][a-zA-Z0-9.-]*)/g },
	{ type: 'tag', regex: /(^|[\s(])(#\S+)/g },
];

/** Punctuation that is almost never part of the token it trails */
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/;

/** Reject tokens that matched the pattern but aren't valid AT Protocol facets */
function isValid(type: DetectedFacetType, value: string): boolean {
	// A mention must contain a dot to look like a handle (`alice.bsky.social`),
	// otherwise `@` is likely an email/username mention unrelated to Bluesky
	if (type === 'mention') return value.includes('.');
	// A tag must have at least one non-digit character (bare numbers like `#1`
	// are almost always rankings/counts, not hashtags) and fit the 640-byte tag limit
	if (type === 'tag') return /[^\d]/.test(value) && byteLength(value) <= 640;
	return value.length > 0;
}

/** Scan text for links, @mentions and #hashtags, returning them in text order */
export function detectFacets(text: string): DetectedFacet[] {
	const facets: DetectedFacet[] = [];

	for (const { type, regex } of PATTERNS) {
		for (const match of text.matchAll(regex)) {
			const prefix = match[1];
			const token = match[2].replace(TRAILING_PUNCTUATION, '');
			if (token.length <= (type === 'link' ? 0 : 1)) continue;

			const value = type === 'link' ? token : token.slice(1);
			if (!isValid(type, value)) continue;

			const start = (match.index ?? 0) + prefix.length;
			facets.push({
				type,
				value,
				byteStart: byteLength(text.slice(0, start)),
				byteEnd: byteLength(text.slice(0, start + token.length)),
			});
		}
	}

	return facets.sort((a, b) => a.byteStart - b.byteStart);
}

/**
 * Convert a detected token into an AT Protocol facet. A mention needs its
 * handle already resolved to a DID by the caller — if `did` is missing (the
 * handle didn't resolve), the mention is dropped and the text stays plain, since
 * an unresolvable `@handle` is far more often a typo or a non-Bluesky mention
 * than a real account.
 */
export function toFacet(detected: DetectedFacet, did?: string): Facet | undefined {
	const { type, value, byteStart, byteEnd } = detected;

	if (type === 'mention') {
		if (!did) return undefined;
		return {
			index: { byteStart, byteEnd },
			features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
		};
	}

	const feature =
		type === 'link'
			? { $type: 'app.bsky.richtext.facet#link', uri: value }
			: { $type: 'app.bsky.richtext.facet#tag', tag: value };

	return { index: { byteStart, byteEnd }, features: [feature] };
}
