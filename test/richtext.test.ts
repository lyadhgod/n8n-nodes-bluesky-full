// Self-check for the facet detector. Run with `npm test`; silence means success.
// Deliberately free of imports, `console` and `process`: the n8n community-node
// lint rules apply to every file in the package, test files included.
import { detectFacets, toFacet } from '../nodes/Bluesky/richtext.ts';

function check(label: string, actual: unknown, expected: unknown): void {
	const got = JSON.stringify(actual);
	const want = JSON.stringify(expected);

	if (got !== want) {
		throw new Error(`${label}\n  expected: ${want}\n  actual:   ${got}`);
	}
}

check(
	'detects mentions, links and tags in text order',
	detectFacets('Hi @alice.bsky.social, see https://example.com/a #n8n').map((f) => [f.type, f.value]),
	[
		['mention', 'alice.bsky.social'],
		['link', 'https://example.com/a'],
		['tag', 'n8n'],
	],
);

// The butterfly is 4 UTF-8 bytes and the space 1, so `#sky` starts at byte 5,
// not at string index 3 the way JavaScript would count it
const [emojiTag] = detectFacets('🦋 #sky');
check('indices are UTF-8 byte offsets', [emojiTag.byteStart, emojiTag.byteEnd], [5, 9]);

check(
	'drops trailing punctuation from links',
	detectFacets('read https://example.com/a.').map((f) => f.value),
	['https://example.com/a'],
);

// The facet range has to include the sigil, here the "@" at string index 1
const [parenthesised] = detectFacets('(@bob.test) hi');
check(
	'facet range covers the sigil',
	[parenthesised.value, parenthesised.byteStart],
	['bob.test', 1],
);

check('ignores an @ in the middle of a token', detectFacets('mail bob@example.com'), []);
check('ignores handles without a dot', detectFacets('@nodots hello'), []);
check('ignores purely numeric tags', detectFacets('rank #1'), []);
check(
	'ignores a # inside a link',
	detectFacets('https://x.test/#anchor').map((f) => f.type),
	['link'],
);

const [mention] = detectFacets('hi @alice.test');
check('a mention without a resolved DID yields no facet', toFacet(mention), undefined);
check('a resolved mention becomes a mention feature', toFacet(mention, 'did:plc:abc')?.features, [
	{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:abc' },
]);
check('a tag becomes a tag feature', toFacet(detectFacets('a #tag')[0])?.features, [
	{ $type: 'app.bsky.richtext.facet#tag', tag: 'tag' },
]);
