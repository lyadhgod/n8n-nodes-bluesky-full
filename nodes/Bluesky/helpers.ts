import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { BSKY_APP_URL, NSID } from '../../constants';
import { asBoolean, asNumber, asObject, asString } from '../../sanitize';
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

// ============================================================
//                    Node parameter readers
// ============================================================
//
// `getNodeParameter` is typed `NodeParameterValueType` and can hold whatever an
// expression evaluated to, so every read goes through one of these instead of an
// `as string`/`as number` cast. Required fields are checked for emptiness here,
// at the trust boundary, rather than reaching the API as `""` and coming back as
// an opaque 400.

/** Read a string parameter, trimmed; `''` when unset, blank or not a string */
export function stringParam(context: IExecuteFunctions, name: string, itemIndex: number): string {
	return asString(context.getNodeParameter(name, itemIndex, '')).trim();
}

/** Read a string parameter that the operation cannot run without */
export function requiredParam(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): string {
	const value = stringParam(context, name, itemIndex);
	if (!value) {
		throw new NodeOperationError(context.getNode(), `The "${label}" field is empty`, {
			itemIndex,
			description: 'Fill it in, or check the expression feeding it for this item',
		});
	}

	return value;
}

/** Read a boolean parameter, so that a string `'false'` from an expression stays false */
export function booleanParam(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	fallback = false,
): boolean {
	return asBoolean(context.getNodeParameter(name, itemIndex, fallback), fallback);
}

/** Read a `collection`/`fixedCollection` parameter as an object, `{}` when unset */
export function objectParam(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): IDataObject {
	return asObject(context.getNodeParameter(name, itemIndex, {}));
}

/** Read the shared "Return All" / "Limit" pair, with a limit usable as a page size */
export function paginationParams(
	context: IExecuteFunctions,
	itemIndex: number,
): { returnAll: boolean; limit: number } {
	return {
		returnAll: booleanParam(context, 'returnAll', itemIndex),
		limit: Math.max(1, Math.floor(asNumber(context.getNodeParameter('limit', itemIndex, 50), 50))),
	};
}

// ============================================================
//                    AT URIs, handles, DIDs
// ============================================================

/** Split an AT URI into its parts, or throw a user-facing `NodeOperationError` */
export function parseAtUri(
	context: IExecuteFunctions,
	uri: unknown,
	itemIndex: number,
): AtUriParts {
	const match = AT_URI.exec(asString(uri).trim());
	if (!match) {
		throw new NodeOperationError(context.getNode(), `"${asString(uri)}" is not a valid AT URI`, {
			itemIndex,
			description: 'Expected the form at://did:plc:.../app.bsky.feed.post/3k...',
		});
	}

	const [, repo, collection, rkey] = match;
	return { repo, collection, rkey };
}

/** Accepts a handle, a DID or a bsky.app profile link */
export function normalizeActor(actor: unknown): string {
	const trimmed = asString(actor).trim();
	return PROFILE_URL.exec(trimmed)?.[1] ?? trimmed;
}

/**
 * Resolve a handle, DID or bsky.app profile link to a DID. DIDs are returned
 * as-is (no network call); handles are resolved via `com.atproto.identity.resolveHandle`
 * since record subjects (follows, blocks, mentions) must always be DIDs, not handles.
 */
export async function resolveDid(this: BlueskyContext, actor: unknown): Promise<string> {
	const identifier = normalizeActor(actor);
	if (identifier.startsWith('did:')) return identifier;

	if (!identifier) {
		throw new NodeOperationError(this.getNode(), 'No account handle or DID was given');
	}

	const response = await blueskyApiRequest.call(
		this,
		'GET',
		NSID.identity.resolveHandle,
		{},
		{ handle: identifier },
	);

	// A resolved DID ends up as the `subject` of follow/block records and inside
	// `at://` URIs, so an absent one has to fail here rather than be written out
	const did = asString(response.did);
	if (!did.startsWith('did:')) {
		throw new NodeOperationError(this.getNode(), `Could not resolve "${identifier}" to a DID`, {
			description: 'The handle may be misspelled, or the account may no longer exist',
		});
	}

	return did;
}

/** Accepts an AT URI or a bsky.app post link and always returns an AT URI */
export async function resolvePostUri(this: BlueskyContext, uri: unknown): Promise<string> {
	const trimmed = asString(uri).trim();
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

	const post = asObject(asObject(response.thread).post);

	if (!asString(post.uri)) {
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
	const handle = asString(asObject(post.author).handle);
	const rkey = asString(post.uri).split('/').pop() ?? '';
	if (!handle || !rkey) return undefined;

	return `${BSKY_APP_URL}/profile/${handle}/post/${rkey}`;
}

/**
 * Flatten a post response down to the fields most workflows need, dropping
 * facets, embeds and viewer state. Accepts either a `feedViewPost`
 * (`{ post, reply, reason }`, as returned by feed/timeline endpoints) or a bare
 * `postView` (as returned by getPostThread) — both wrap the same inner shape.
 */
export function simplifyPost(input: unknown): IDataObject {
	const wrapper = asObject(input);
	const post = asObject(wrapper.post ?? wrapper);
	const author = asObject(post.author);
	const record = asObject(post.record);

	return {
		uri: asString(post.uri),
		cid: asString(post.cid),
		url: postWebUrl(post),
		text: asString(record.text),
		createdAt: record.createdAt,
		indexedAt: post.indexedAt,
		author: {
			did: asString(author.did),
			handle: asString(author.handle),
			displayName: asString(author.displayName),
		},
		replyCount: asNumber(post.replyCount, 0),
		repostCount: asNumber(post.repostCount, 0),
		likeCount: asNumber(post.likeCount, 0),
		quoteCount: asNumber(post.quoteCount, 0),
	};
}

/** Flatten a profile view down to the fields most workflows need, dropping viewer state */
export function simplifyProfile(input: unknown): IDataObject {
	const profile = asObject(input);
	const handle = asString(profile.handle);

	return {
		did: asString(profile.did),
		handle,
		displayName: asString(profile.displayName),
		description: asString(profile.description),
		avatar: asString(profile.avatar),
		followersCount: asNumber(profile.followersCount, 0),
		followsCount: asNumber(profile.followsCount, 0),
		postsCount: asNumber(profile.postsCount, 0),
		url: handle ? `${BSKY_APP_URL}/profile/${handle}` : undefined,
	};
}
