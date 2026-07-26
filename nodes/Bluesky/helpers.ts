import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { BSKY_APP_URL, NSID } from '../../constants';
import { blueskyApiRequest, type BlueskyContext } from './transport';

/** The three components of an `at://repo/collection/rkey` URI, e.g. from a record reference */
export interface AtUriParts {
	/** The DID (or, less commonly, handle) owning the record */
	repo: string;
	/** The record's NSID, e.g. `app.bsky.feed.post` (see {@link NSID}) */
	collection: string;
	/** The record key, the final path segment identifying it within its collection */
	rkey: string;
}

// Derived from BSKY_APP_URL (rather than a separate literal) so the bsky.app-link
// regexes below can't silently drift from the host used to build the same links.
const BSKY_APP_HOST = new URL(BSKY_APP_URL).host.replace(/\./g, '\\.');

const AT_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
const POST_URL = new RegExp(`^https?://${BSKY_APP_HOST}/profile/([^/]+)/post/([^/?#]+)`);
const PROFILE_URL = new RegExp(`^https?://${BSKY_APP_HOST}/profile/([^/?#]+)`);

/** Split an AT URI into its parts, or throw a user-facing `NodeOperationError` */
export function parseAtUri(context: IExecuteFunctions, uri: string, itemIndex: number): AtUriParts {
	const match = AT_URI.exec(uri);
	if (!match) {
		throw new NodeOperationError(context.getNode(), `"${uri}" is not a valid AT URI`, {
			itemIndex,
			description: 'Expected the form at://did:plc:.../app.bsky.feed.post/3k...',
		});
	}

	const [, repo, collection, rkey] = match;
	return { repo, collection, rkey };
}

/** Accepts a handle, a DID or a bsky.app profile link */
export function normalizeActor(actor: string): string {
	return PROFILE_URL.exec(actor.trim())?.[1] ?? actor.trim();
}

/**
 * Resolve a handle, DID or bsky.app profile link to a DID. DIDs are returned
 * as-is (no network call); handles are resolved via `com.atproto.identity.resolveHandle`
 * since record subjects (follows, blocks, mentions) must always be DIDs, not handles.
 */
export async function resolveDid(this: BlueskyContext, actor: string): Promise<string> {
	const identifier = normalizeActor(actor);
	if (identifier.startsWith('did:')) return identifier;

	const response = await blueskyApiRequest.call(
		this,
		'GET',
		NSID.identity.resolveHandle,
		{},
		{ handle: identifier },
	);

	return response.did as string;
}

/** Accepts an AT URI or a bsky.app post link and always returns an AT URI */
export async function resolvePostUri(this: BlueskyContext, uri: string): Promise<string> {
	const trimmed = uri.trim();
	const match = POST_URL.exec(trimmed);
	if (!match) return trimmed;

	const did = await resolveDid.call(this, match[1]);
	return `at://${did}/${NSID.feed.post}/${match[2]}`;
}

/**
 * Fetch a single post view, which carries the `cid` and the viewer's like/repost
 * records. There is no single-post XRPC endpoint, so this goes through
 * `getPostThread` with `depth: 0, parentHeight: 0` to fetch just the post itself.
 */
export async function getPostView(this: BlueskyContext, uri: string): Promise<IDataObject> {
	const response = await blueskyApiRequest.call(
		this,
		'GET',
		NSID.feed.getPostThread,
		{},
		{ uri, depth: 0, parentHeight: 0 },
	);

	const thread = response.thread as IDataObject;
	const post = thread?.post as IDataObject | undefined;

	if (!post?.uri) {
		// Blocked, deleted or never existed: the thread carries a #notFoundPost view
		throw new NodeOperationError(this.getNode(), `No post found at "${uri}"`, {
			description: 'It may have been deleted, or the author may have blocked this account',
		});
	}

	return post;
}

/**
 * Build the human-facing bsky.app link for a post view, or `undefined` if it's
 * missing the author handle or URI needed to construct one (e.g. a stripped-down view).
 * The `rkey` is recovered from the AT URI's last path segment, since post views
 * carry the record's `uri`/`cid` but not a ready-made web link.
 */
export function postWebUrl(post: IDataObject): string | undefined {
	const author = (post.author ?? {}) as IDataObject;
	const rkey = String(post.uri ?? '').split('/').pop();
	if (!author.handle || !rkey) return undefined;

	return `${BSKY_APP_URL}/profile/${String(author.handle)}/post/${rkey}`;
}

/**
 * Flatten a post response down to the fields most workflows need, dropping
 * facets, embeds and viewer state. Accepts either a `feedViewPost`
 * (`{ post, reply, reason }`, as returned by feed/timeline endpoints) or a bare
 * `postView` (as returned by getPostThread) — both wrap the same inner shape.
 */
export function simplifyPost(input: IDataObject): IDataObject {
	const post = (input.post ?? input) as IDataObject;
	const author = (post.author ?? {}) as IDataObject;
	const record = (post.record ?? {}) as IDataObject;

	return {
		uri: post.uri,
		cid: post.cid,
		url: postWebUrl(post),
		text: record.text ?? '',
		createdAt: record.createdAt,
		indexedAt: post.indexedAt,
		author: {
			did: author.did,
			handle: author.handle,
			displayName: author.displayName,
		},
		replyCount: post.replyCount ?? 0,
		repostCount: post.repostCount ?? 0,
		likeCount: post.likeCount ?? 0,
		quoteCount: post.quoteCount ?? 0,
	};
}

/** Flatten a profile view down to the fields most workflows need, dropping viewer state */
export function simplifyProfile(profile: IDataObject): IDataObject {
	return {
		did: profile.did,
		handle: profile.handle,
		displayName: profile.displayName,
		description: profile.description,
		avatar: profile.avatar,
		followersCount: profile.followersCount,
		followsCount: profile.followsCount,
		postsCount: profile.postsCount,
		url: profile.handle ? `${BSKY_APP_URL}/profile/${String(profile.handle)}` : undefined,
	};
}
