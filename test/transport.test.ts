// Self-check for the cursor-following pagination in `nodes/Bluesky/transport.ts` —
// the one loop in this package that can over-fetch, under-fetch or never end.
// Run with `npm test`; silence means success. Imports the built module for the
// reason given at the top of helpers.test.ts.
import { blueskyApiRequestAllItems } from '../dist/nodes/Bluesky/transport.js';
import { check, checkThrows } from './check.ts';

interface Page {
	items?: unknown[];
	cursor?: string;
}

/**
 * The slice of `IExecuteFunctions` the transport actually uses: a credential
 * holding the PDS URL, and an HTTP helper. Hands out `pages` in order and
 * records the query string of every request so the page sizes and cursors
 * asked for can be asserted, not just the items returned.
 */
function fakeContext(pages: Page[], pdsServer = 'https://pds.test/') {
	const sent: Array<Record<string, unknown>> = [];
	const remaining = [...pages];

	const context = {
		sent,
		getNode: () => ({ name: 'Bluesky', type: 'bluesky', typeVersion: 1, position: [0, 0] }),
		getCredentials: async () => ({ pdsServer }),
		helpers: {
			httpRequestWithAuthentication: async (
				_credential: string,
				options: { url: string; qs: Record<string, unknown> },
			) => {
				sent.push({ url: options.url, ...options.qs });
				return remaining.shift() ?? {};
			},
		},
	};

	return context;
}

function page(size: number, cursor?: string): Page {
	return { items: Array.from({ length: size }, (_, index) => ({ index })), cursor };
}

const call = async (context: unknown, returnAll: boolean, limit: number) =>
	await blueskyApiRequestAllItems.call(
		context as never,
		'app.bsky.feed.getTimeline',
		'items',
		{ actor: 'alice.test' },
		returnAll,
		limit,
	);

// A single over-long page is cut back to the limit, and the query the PDS saw
// asked for exactly that many
const single = fakeContext([page(10, 'c1')]);
check('an over-long page is sliced to the limit', (await call(single, false, 5)).length, 5);
check('the request asks for the limit as its page size', single.sent, [
	{ url: 'https://pds.test/xrpc/app.bsky.feed.getTimeline', actor: 'alice.test', limit: 5 },
]);

// Short pages are followed until the limit is met, each request asking only for
// what is still missing — never re-requesting a full page and discarding it
const paged = fakeContext([page(3, 'c1'), page(3, 'c2'), page(3, 'c3')]);
check('short pages are followed until the limit is met', (await call(paged, false, 7)).length, 7);
check(
	'each page asks only for the remainder',
	paged.sent.map((request) => request.limit),
	[7, 4, 1],
);
check(
	'the cursor of the previous page is sent on',
	paged.sent.map((request) => request.cursor),
	[undefined, 'c1', 'c2'],
);

// returnAll ignores the limit and follows the cursor to the end, at the API's
// 100-item maximum page size
const all = fakeContext([page(2, 'c1'), page(2, 'c2'), page(2)]);
check('returnAll follows the cursor to the last page', (await call(all, true, 1)).length, 6);
check(
	'returnAll asks for full pages',
	all.sent.map((request) => request.limit),
	[100, 100, 100],
);

// Some feeds keep handing out a cursor after they have run out of items; without
// the empty-page guard this is an infinite loop
const endless = fakeContext([page(2, 'c1'), page(0, 'c2'), page(2, 'c3')]);
check('an empty page ends the walk even with a cursor', (await call(endless, true, 1)).length, 2);

// A limit that arrived as 0 or NaN from an expression must not make the loop's
// exit condition unreachable
check(
	'a zero limit fetches one item, not none',
	(await call(fakeContext([page(5, 'c1')]), false, 0)).length,
	1,
);
check(
	'a NaN limit falls back to 50',
	(await call(fakeContext([page(80, 'c1')]), false, Number.NaN)).length,
	50,
);

// A blank PDS URL would otherwise build a relative "/xrpc/..." request
const blank = fakeContext([page(1)], '   ');
await checkThrows(
	'a blank PDS URL fails before the request',
	async () => await call(blank, false, 1),
	'No PDS server URL is set',
);
check('nothing was sent for a blank PDS URL', blank.sent.length, 0);
// Trailing slashes are stripped rather than doubled into "//xrpc"
const slashes = fakeContext([page(1)], 'https://pds.test///');
await call(slashes, false, 1);
check(
	'trailing slashes are stripped from the PDS URL',
	slashes.sent[0].url,
	'https://pds.test/xrpc/app.bsky.feed.getTimeline',
);
