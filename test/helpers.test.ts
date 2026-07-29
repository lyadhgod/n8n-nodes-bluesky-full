// Self-check for the URI/link parsing and response flattening in
// `nodes/Bluesky/helpers.ts`. Run with `npm test`; silence means success.
//
// Imports the *built* module rather than the source: `helpers.ts` imports
// `../../constants` and `n8n-workflow` without file extensions, which Node's
// ESM resolver cannot follow in a `.ts` file. `npm test` builds first (see the
// `pretest` script), so `dist/` is always current.
import {
	normalizeActor,
	parseAtUri,
	postWebUrl,
	simplifyPost,
	simplifyProfile,
} from '../dist/nodes/Bluesky/helpers.js';
import { check, checkThrows } from './check.ts';

// Only `getNode()` is reached on the error paths below — enough of an
// `IExecuteFunctions` for these helpers, which never touch the network
const context = {
	getNode: () => ({ name: 'Bluesky', type: 'bluesky', typeVersion: 1, position: [0, 0] }),
} as never;

check(
	'an at:// URI splits into repo, collection and rkey',
	parseAtUri(context, 'at://did:plc:abc/app.bsky.feed.post/3k', 0),
	{
		repo: 'did:plc:abc',
		collection: 'app.bsky.feed.post',
		rkey: '3k',
	},
);
check('surrounding whitespace is ignored', parseAtUri(context, ' at://a/b/c ', 0).rkey, 'c');
await checkThrows(
	'a bsky.app link is not an AT URI',
	() => parseAtUri(context, 'https://bsky.app/profile/a.test/post/3k', 0),
	'not a valid AT URI',
);
await checkThrows(
	'a missing URI fails at the boundary',
	() => parseAtUri(context, undefined, 0),
	'not a valid AT URI',
);

check(
	'a profile link yields the handle',
	normalizeActor('https://bsky.app/profile/alice.test'),
	'alice.test',
);
check(
	'a profile link with a trailing path is truncated',
	normalizeActor('https://bsky.app/profile/alice.test/follows'),
	'alice.test',
);
check('a bare handle passes through', normalizeActor(' alice.test '), 'alice.test');
check('a DID passes through', normalizeActor('did:plc:abc'), 'did:plc:abc');
// Only bsky.app links are unwrapped; anything else is the identifier itself
check(
	'a foreign profile link is left alone',
	normalizeActor('https://example.com/profile/alice.test'),
	'https://example.com/profile/alice.test',
);

check(
	'a post view becomes a bsky.app link',
	postWebUrl({ author: { handle: 'alice.test' }, uri: 'at://did:plc:abc/app.bsky.feed.post/3k' }),
	'https://bsky.app/profile/alice.test/post/3k',
);
check(
	'a view without an author handle has no link',
	postWebUrl({ uri: 'at://did:plc:abc/app.bsky.feed.post/3k' }),
	undefined,
);
check(
	'a view without a URI has no link',
	postWebUrl({ author: { handle: 'alice.test' } }),
	undefined,
);

// Feed endpoints return `{ post, reply, reason }`; getPostThread returns the
// post view directly. Both have to flatten to the same shape.
const postView = {
	uri: 'at://did:plc:abc/app.bsky.feed.post/3k',
	cid: 'bafy',
	indexedAt: '2026-01-01T00:00:00Z',
	author: { did: 'did:plc:abc', handle: 'alice.test', displayName: 'Alice' },
	record: { text: 'hello', createdAt: '2026-01-01T00:00:00Z' },
	replyCount: 2,
	likeCount: 3,
};
const flattened = {
	uri: 'at://did:plc:abc/app.bsky.feed.post/3k',
	cid: 'bafy',
	url: 'https://bsky.app/profile/alice.test/post/3k',
	text: 'hello',
	createdAt: '2026-01-01T00:00:00Z',
	indexedAt: '2026-01-01T00:00:00Z',
	author: { did: 'did:plc:abc', handle: 'alice.test', displayName: 'Alice' },
	replyCount: 2,
	repostCount: 0,
	likeCount: 3,
	quoteCount: 0,
};

check('a bare post view flattens', simplifyPost(postView), flattened);
check(
	'a feed view post flattens identically',
	simplifyPost({ post: postView, reason: {} }),
	flattened,
);
check('missing counts become 0, not undefined', simplifyPost({}).likeCount, 0);

check(
	'a profile flattens and gains a web link',
	simplifyProfile({ did: 'did:plc:abc', handle: 'alice.test', followersCount: 7 }),
	{
		did: 'did:plc:abc',
		handle: 'alice.test',
		displayName: '',
		description: '',
		avatar: '',
		followersCount: 7,
		followsCount: 0,
		postsCount: 0,
		url: 'https://bsky.app/profile/alice.test',
	},
);
check(
	'a profile without a handle has no link',
	simplifyProfile({ did: 'did:plc:abc' }).url,
	undefined,
);
