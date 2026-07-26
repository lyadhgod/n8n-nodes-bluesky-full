import {
	NodeApiError,
	NodeConnectionTypes,
	NodeError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import { CREDENTIAL_NAME, NODE_DISPLAY_NAME, NODE_NAME, NSID } from '../../constants';
import {
	getPostView,
	normalizeActor,
	parseAtUri,
	resolveDid,
	resolvePostUri,
	simplifyPost,
	simplifyProfile,
} from './helpers';
import { detectFacets, toFacet, type Facet } from './richtext';
import { feedDescription } from './resources/feed';
import { notificationDescription } from './resources/notification';
import { postDescription } from './resources/post';
import { userDescription } from './resources/user';
import {
	blueskyApiRequest,
	blueskyApiRequestAllItems,
	getOwnDid,
	uploadBlob,
} from './transport';

/**
 * Blob ceilings come from the lexicon that *references* the blob, not from
 * `com.atproto.repo.uploadBlob` itself, which accepts any encoding and defers all
 * limits to record creation: `app.bsky.embed.images` allows 2MB per image, while an
 * `app.bsky.embed.external` thumbnail is still capped at 1MB. Enforced
 * client-side to fail fast with a clear message instead of a raw API error.
 */
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_THUMBNAIL_BYTES = 1_000_000;

/** One entry of the `images.image` fixedCollection parameter on the Create Post operation */
interface ImageInput {
	/** Name of the input binary field holding the image data */
	binaryPropertyName: string;
	/** Alt text for screen readers; Bluesky allows an empty string but not omitting it */
	alt?: string;
}

/** The DID resolver memoized once per execution in {@link Bluesky.execute}, threaded into every operation that writes a record */
type RepoResolver = () => Promise<string>;

/** Parse a comma-separated node parameter (e.g. Languages, Tags) into a trimmed, non-empty list */
function splitList(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Turn links, @mentions and #hashtags in the text into AT Protocol facets */
async function buildFacets(this: IExecuteFunctions, text: string): Promise<Facet[]> {
	const facets: Facet[] = [];

	for (const detected of detectFacets(text)) {
		let did: string | undefined;

		if (detected.type === 'mention') {
			try {
				did = await resolveDid.call(this, detected.value);
			} catch {
				// An unresolvable handle is plain text, not a mention
				continue;
			}
		}

		const facet = toFacet(detected, did);
		if (facet) facets.push(facet);
	}

	return facets;
}

/**
 * Read an input binary field, enforce the caller's blob limit, and upload it via
 * `com.atproto.repo.uploadBlob`. Used for both post images and link-card thumbnails,
 * which have different ceilings — see {@link MAX_IMAGE_BYTES}/{@link MAX_THUMBNAIL_BYTES}.
 */
async function uploadBinaryImage(
	this: IExecuteFunctions,
	itemIndex: number,
	binaryPropertyName: string,
	maxBytes: number,
): Promise<IDataObject> {
	const binary = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);

	if (buffer.length > maxBytes) {
		throw new NodeOperationError(
			this.getNode(),
			`Image "${binaryPropertyName}" is ${buffer.length} bytes, over the ${maxBytes / 1_000_000}MB limit of Bluesky`,
			{ itemIndex, description: 'Resize or re-compress the image before attaching it' },
		);
	}

	return await uploadBlob.call(this, buffer, binary.mimeType || 'application/octet-stream');
}

/** Delete a record referenced by an AT URI, e.g. the like the viewer left on a post */
async function deleteRecordByUri(
	this: IExecuteFunctions,
	uri: string,
	itemIndex: number,
): Promise<void> {
	const { repo, collection, rkey } = parseAtUri(this, uri, itemIndex);
	await blueskyApiRequest.call(this, 'POST', NSID.repo.deleteRecord, {
		repo,
		collection,
		rkey,
	});
}

// ============================================================
//                          Post
// ============================================================

async function createPost(
	this: IExecuteFunctions,
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject> {
	const text = this.getNodeParameter('text', itemIndex) as string;
	const images = this.getNodeParameter('images.image', itemIndex, []) as ImageInput[];
	const options = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;

	const record: IDataObject = {
		$type: NSID.feed.post,
		text,
		createdAt: new Date().toISOString(),
	};

	if (options.detectFacets !== false) {
		const facets = await buildFacets.call(this, text);
		if (facets.length) record.facets = facets;
	}

	if (options.langs) record.langs = splitList(options.langs).slice(0, 3);
	if (options.tags) record.tags = splitList(options.tags).slice(0, 8);

	const labels = (options.labels ?? []) as string[];
	if (labels.length) {
		record.labels = {
			$type: NSID.label.selfLabels,
			values: labels.map((val) => ({ val })),
		};
	}

	if (options.replyUri) {
		const parentUri = await resolvePostUri.call(this, options.replyUri as string);
		const parent = await getPostView.call(this, parentUri);
		const parentRef = { uri: parent.uri, cid: parent.cid };
		const parentReply = (parent.record as IDataObject)?.reply as IDataObject | undefined;

		record.reply = { root: parentReply?.root ?? parentRef, parent: parentRef };
	}

	let media: IDataObject | undefined;

	if (images.length) {
		// Checked before uploading rather than letting createRecord reject the
		// record, which would already have burned an uploadBlob call per image
		if (images.length > 4) {
			throw new NodeOperationError(
				this.getNode(),
				`A post can carry at most 4 images, got ${images.length}`,
				{ itemIndex },
			);
		}

		media = {
			$type: NSID.embed.images,
			images: await Promise.all(
				images.map(async (image) => ({
					alt: image.alt ?? '',
					image: await uploadBinaryImage.call(
						this,
						itemIndex,
						image.binaryPropertyName,
						MAX_IMAGE_BYTES,
					),
				})),
			),
		};
	} else if (options.externalUri) {
		const external: IDataObject = {
			uri: options.externalUri,
			title: options.externalTitle ?? '',
			description: options.externalDescription ?? '',
		};

		if (options.externalThumbnail) {
			external.thumb = await uploadBinaryImage.call(
				this,
				itemIndex,
				options.externalThumbnail as string,
				MAX_THUMBNAIL_BYTES,
			);
		}

		media = { $type: NSID.embed.external, external };
	}

	let quoteRef: IDataObject | undefined;
	if (options.quoteUri) {
		const quoted = await getPostView.call(
			this,
			await resolvePostUri.call(this, options.quoteUri as string),
		);
		quoteRef = { uri: quoted.uri, cid: quoted.cid };
	}

	// A post can carry both a quote and an image/link card at once, which AT
	// Protocol models as a distinct `recordWithMedia` embed type rather than nesting one inside the other
	if (quoteRef && media) {
		record.embed = {
			$type: NSID.embed.recordWithMedia,
			record: { $type: NSID.embed.record, record: quoteRef },
			media,
		};
	} else if (quoteRef) {
		record.embed = { $type: NSID.embed.record, record: quoteRef };
	} else if (media) {
		record.embed = media;
	}

	return await blueskyApiRequest.call(this, 'POST', NSID.repo.createRecord, {
		repo: await repo(),
		collection: NSID.feed.post,
		record,
	});
}

async function deletePost(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	await deleteRecordByUri.call(this, uri, itemIndex);
	return { success: true, uri };
}

async function getPost(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	const post = await getPostView.call(this, uri);
	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? simplifyPost(post) : post;
}

async function getPostThreadOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

	const response = await blueskyApiRequest.call(
		this,
		'GET',
		NSID.feed.getPostThread,
		{},
		{
			uri,
			depth: options.depth ?? 6,
			parentHeight: options.parentHeight ?? 80,
		},
	);
	return response.thread as IDataObject;
}

async function searchPosts(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const qs: IDataObject = { q: this.getNodeParameter('query', itemIndex) as string, ...filters };
	if (filters.author) qs.author = normalizeActor(filters.author as string);
	if (filters.mentions) qs.mentions = normalizeActor(filters.mentions as string);

	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const posts = await blueskyApiRequestAllItems.call(
		this,
		NSID.feed.searchPosts,
		'posts',
		qs,
		returnAll,
		limit,
	);

	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? posts.map(simplifyPost) : posts;
}

async function likeOrRepostPost(
	this: IExecuteFunctions,
	operation: 'like' | 'repost',
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	const post = await getPostView.call(this, uri);
	const collection = operation === 'like' ? NSID.feed.like : NSID.feed.repost;

	return await blueskyApiRequest.call(this, 'POST', NSID.repo.createRecord, {
		repo: await repo(),
		collection,
		record: {
			$type: collection,
			subject: { uri: post.uri, cid: post.cid },
			createdAt: new Date().toISOString(),
		},
	});
}

async function unlikeOrUnrepostPost(
	this: IExecuteFunctions,
	operation: 'unlike' | 'unrepost',
	itemIndex: number,
): Promise<IDataObject> {
	// The post view's `viewer` block carries the AT URI of *this account's own*
	// like/repost record, if any; that's what has to be deleted, not the post itself.
	// Its absence means there was nothing to undo, so this operation is idempotent.
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	const post = await getPostView.call(this, uri);
	const viewer = (post.viewer ?? {}) as IDataObject;
	const recordUri = (operation === 'unlike' ? viewer.like : viewer.repost) as string | undefined;

	if (recordUri) await deleteRecordByUri.call(this, recordUri, itemIndex);
	return { success: true, uri, changed: Boolean(recordUri) };
}

async function getPostLikes(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const likes = await blueskyApiRequestAllItems.call(
		this,
		NSID.feed.getLikes,
		'likes',
		{ uri },
		returnAll,
		limit,
	);

	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify
		? likes.map((like) => ({
				...simplifyProfile((like.actor ?? {}) as IDataObject),
				likedAt: like.createdAt,
			}))
		: likes;
}

async function getPostReposts(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', itemIndex) as string);
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const profiles = await blueskyApiRequestAllItems.call(
		this,
		NSID.feed.getRepostedBy,
		'repostedBy',
		{ uri },
		returnAll,
		limit,
	);

	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? profiles.map(simplifyProfile) : profiles;
}

/** Dispatches a Post-resource operation to its handler */
async function executePostOperation(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject | IDataObject[]> {
	switch (operation) {
		case 'create':
			return createPost.call(this, itemIndex, repo);
		case 'delete':
			return deletePost.call(this, itemIndex);
		case 'get':
			return getPost.call(this, itemIndex);
		case 'getThread':
			return getPostThreadOp.call(this, itemIndex);
		case 'search':
			return searchPosts.call(this, itemIndex);
		case 'like':
		case 'repost':
			return likeOrRepostPost.call(this, operation, itemIndex, repo);
		case 'unlike':
		case 'unrepost':
			return unlikeOrUnrepostPost.call(this, operation, itemIndex);
		case 'getLikes':
			return getPostLikes.call(this, itemIndex);
		case 'getReposts':
			return getPostReposts.call(this, itemIndex);
		default:
			return {};
	}
}

// ============================================================
//                          Feed
// ============================================================

/** Fetch a paginated feed of posts and simplify if requested — shared by all three Feed operations */
async function fetchFeed(
	this: IExecuteFunctions,
	itemIndex: number,
	nsid: string,
	qs: IDataObject,
): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const feed = await blueskyApiRequestAllItems.call(this, nsid, 'feed', qs, returnAll, limit);

	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? feed.map(simplifyPost) : feed;
}

async function getTimelineOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	return fetchFeed.call(this, itemIndex, NSID.feed.getTimeline, {});
}

async function getAuthorFeedOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const qs: IDataObject = {
		actor: normalizeActor(this.getNodeParameter('actor', itemIndex) as string),
		...(this.getNodeParameter('options', itemIndex, {}) as IDataObject),
	};
	return fetchFeed.call(this, itemIndex, NSID.feed.getAuthorFeed, qs);
}

async function getCustomFeedOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const qs: IDataObject = { feed: this.getNodeParameter('feedUri', itemIndex) as string };
	return fetchFeed.call(this, itemIndex, NSID.feed.getFeed, qs);
}

/** Dispatches a Feed-resource operation to its handler */
async function executeFeedOperation(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	switch (operation) {
		case 'getAuthorFeed':
			return getAuthorFeedOp.call(this, itemIndex);
		case 'getFeed':
			return getCustomFeedOp.call(this, itemIndex);
		case 'getTimeline':
		default:
			return getTimelineOp.call(this, itemIndex);
	}
}

// ============================================================
//                          User
// ============================================================

async function getUserProfile(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const profile = await blueskyApiRequest.call(
		this,
		'GET',
		NSID.actor.getProfile,
		{},
		{ actor: normalizeActor(this.getNodeParameter('actor', itemIndex) as string) },
	);
	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? simplifyProfile(profile) : profile;
}

async function searchUsers(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const actors = await blueskyApiRequestAllItems.call(
		this,
		NSID.actor.searchActors,
		'actors',
		{ q: this.getNodeParameter('query', itemIndex) as string },
		returnAll,
		limit,
	);
	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? actors.map(simplifyProfile) : actors;
}

async function getFollowersOrFollowing(
	this: IExecuteFunctions,
	operation: 'getFollowers' | 'getFollowing',
	itemIndex: number,
): Promise<IDataObject[]> {
	const isFollowers = operation === 'getFollowers';
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const profiles = await blueskyApiRequestAllItems.call(
		this,
		isFollowers ? NSID.graph.getFollowers : NSID.graph.getFollows,
		isFollowers ? 'followers' : 'follows',
		{ actor: normalizeActor(this.getNodeParameter('actor', itemIndex) as string) },
		returnAll,
		limit,
	);
	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify ? profiles.map(simplifyProfile) : profiles;
}

async function followOrBlock(
	this: IExecuteFunctions,
	operation: 'follow' | 'block',
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject> {
	const did = await resolveDid.call(this, this.getNodeParameter('actor', itemIndex) as string);
	const collection = operation === 'follow' ? NSID.graph.follow : NSID.graph.block;

	return await blueskyApiRequest.call(this, 'POST', NSID.repo.createRecord, {
		repo: await repo(),
		collection,
		record: { $type: collection, subject: did, createdAt: new Date().toISOString() },
	});
}

async function unfollowOrUnblock(
	this: IExecuteFunctions,
	operation: 'unfollow' | 'unblock',
	itemIndex: number,
): Promise<IDataObject> {
	const actor = normalizeActor(this.getNodeParameter('actor', itemIndex) as string);
	const profile = await blueskyApiRequest.call(this, 'GET', NSID.actor.getProfile, {}, { actor });
	// Same idempotent-delete pattern as unlike/unrepost above, but keyed off the
	// profile viewer's `following`/`blocking` record URI instead of a post's.
	const viewer = (profile.viewer ?? {}) as IDataObject;
	const recordUri = (operation === 'unfollow' ? viewer.following : viewer.blocking) as
		| string
		| undefined;

	if (recordUri) await deleteRecordByUri.call(this, recordUri, itemIndex);
	return { success: true, actor, changed: Boolean(recordUri) };
}

async function muteOrUnmute(
	this: IExecuteFunctions,
	operation: 'mute' | 'unmute',
	itemIndex: number,
): Promise<IDataObject> {
	const actor = normalizeActor(this.getNodeParameter('actor', itemIndex) as string);
	const nsid = operation === 'mute' ? NSID.graph.muteActor : NSID.graph.unmuteActor;
	await blueskyApiRequest.call(this, 'POST', nsid, { actor });
	return { success: true, actor };
}

/** Dispatches a User-resource operation to its handler */
async function executeUserOperation(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject | IDataObject[]> {
	switch (operation) {
		case 'get':
			return getUserProfile.call(this, itemIndex);
		case 'search':
			return searchUsers.call(this, itemIndex);
		case 'getFollowers':
		case 'getFollowing':
			return getFollowersOrFollowing.call(this, operation, itemIndex);
		case 'follow':
		case 'block':
			return followOrBlock.call(this, operation, itemIndex, repo);
		case 'unfollow':
		case 'unblock':
			return unfollowOrUnblock.call(this, operation, itemIndex);
		case 'mute':
		case 'unmute':
			return muteOrUnmute.call(this, operation, itemIndex);
		default:
			return {};
	}
}

// ============================================================
//                       Notification
// ============================================================

async function getAllNotifications(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
	const reasons = (filters.reasons ?? []) as string[];

	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	let notifications = await blueskyApiRequestAllItems.call(
		this,
		NSID.notification.listNotifications,
		'notifications',
		reasons.length ? { reasons } : {},
		returnAll,
		limit,
	);

	if (filters.onlyUnread) {
		notifications = notifications.filter((entry) => !entry.isRead);
	}

	const simplify = this.getNodeParameter('simplify', itemIndex, false) as boolean;
	return simplify
		? notifications.map((entry) => {
				const author = (entry.author ?? {}) as IDataObject;
				const record = (entry.record ?? {}) as IDataObject;

				return {
					uri: entry.uri,
					cid: entry.cid,
					reason: entry.reason,
					reasonSubject: entry.reasonSubject,
					isRead: entry.isRead,
					indexedAt: entry.indexedAt,
					text: record.text,
					author: {
						did: author.did,
						handle: author.handle,
						displayName: author.displayName,
					},
				};
			})
		: notifications;
}

async function getUnreadNotificationCount(this: IExecuteFunctions): Promise<IDataObject> {
	return await blueskyApiRequest.call(this, 'GET', NSID.notification.getUnreadCount);
}

async function markNotificationsRead(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject> {
	const seenAt =
		(this.getNodeParameter('seenAt', itemIndex, '') as string) || new Date().toISOString();
	await blueskyApiRequest.call(this, 'POST', NSID.notification.updateSeen, {
		seenAt: new Date(seenAt).toISOString(),
	});
	return { success: true, seenAt };
}

/** Dispatches a Notification-resource operation to its handler */
async function executeNotificationOperation(
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
): Promise<IDataObject | IDataObject[]> {
	switch (operation) {
		case 'getAll':
			return getAllNotifications.call(this, itemIndex);
		case 'getUnreadCount':
			return getUnreadNotificationCount.call(this);
		case 'markRead':
			return markNotificationsRead.call(this, itemIndex);
		default:
			return {};
	}
}

/**
 * Programmatic-style n8n node exposing the Bluesky AT Protocol API as four
 * resources (Post, Feed, User, Notification). `execute` dispatches on
 * `resource` then `operation` via a switch statement into the per-operation
 * functions above, each a thin, direct mapping onto a single XRPC call.
 */
export class Bluesky implements INodeType {
	description: INodeTypeDescription = {
		displayName: NODE_DISPLAY_NAME,
		name: NODE_NAME,
		icon: { light: 'file:../../icons/bluesky.svg', dark: 'file:../../icons/bluesky.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Consume the Bluesky AT Protocol API',
		defaults: {
			name: NODE_DISPLAY_NAME,
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Feed', value: 'feed' },
					{ name: 'Notification', value: 'notification' },
					{ name: 'Post', value: 'post' },
					{ name: 'User', value: 'user' },
				],
				default: 'post',
			},
			...postDescription,
			...feedDescription,
			...userDescription,
			...notificationDescription,
		],
	};

	/**
	 * Runs once per input item. `resource` and `operation` are read from item 0
	 * only, matching how n8n renders them as single, non-per-item dropdowns; every
	 * other parameter is read per item `i` (inside the dispatched handler) so
	 * expressions can vary across items.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Record writes need the DID of the authenticated account, fetched at most once
		// per execution (not per item) since `repo` is always the same for all items.
		let ownDid: string | undefined;
		const repo: RepoResolver = async () => (ownDid ??= await getOwnDid.call(this));

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject | IDataObject[];

				switch (resource) {
					case 'post':
						responseData = await executePostOperation.call(this, operation, i, repo);
						break;
					case 'feed':
						responseData = await executeFeedOperation.call(this, operation, i);
						break;
					case 'user':
						responseData = await executeUserOperation.call(this, operation, i, repo);
						break;
					case 'notification':
						responseData = await executeNotificationOperation.call(this, operation, i);
						break;
					default:
						responseData = {};
				}

				returnData.push(
					...this.helpers.constructExecutionMetaData(
						this.helpers.returnJsonArray(responseData),
						{ itemData: { item: i } },
					),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}

				// Already a node-level error (bad AT URI, missing post, oversized blob).
				// The rule below exists to stop raw errors leaking out, but re-wrapping one
				// of ours in NodeApiError swaps its message and description for a generic
				// "service was not able to process your request", losing the actual cause.
				// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
				if (error instanceof NodeError) throw error;

				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
