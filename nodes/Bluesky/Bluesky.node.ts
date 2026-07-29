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
	asArray,
	asBoolean,
	asNumber,
	asObject,
	asString,
	asStringArray,
	splitList,
} from '../../sanitize';
import {
	booleanParam,
	getPostView,
	normalizeActor,
	objectParam,
	paginationParams,
	parseAtUri,
	requiredParam,
	resolveDid,
	resolvePostUri,
	simplifyPost,
	simplifyProfile,
	stringParam,
} from './helpers';
import { detectFacets, toFacet, type Facet } from './richtext';
import { feedDescription } from './resources/feed';
import { notificationDescription } from './resources/notification';
import { postDescription } from './resources/post';
import { userDescription } from './resources/user';
import { blueskyApiRequest, blueskyApiRequestAllItems, getOwnDid, uploadBlob } from './transport';

/**
 * Blob ceilings come from the lexicon that *references* the blob, not from
 * `com.atproto.repo.uploadBlob` itself, which accepts any encoding and defers all
 * limits to record creation: `app.bsky.embed.images` allows 2MB per image, while an
 * `app.bsky.embed.external` thumbnail is still capped at 1MB. Enforced
 * client-side to fail fast with a clear message instead of a raw API error.
 */
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_THUMBNAIL_BYTES = 1_000_000;

/** One image of the `images.image` fixedCollection, after checking what the parameter actually held */
interface ImageInput {
	/** Name of the input binary field holding the image data */
	binaryPropertyName: string;
	/** Alt text for screen readers; Bluesky allows an empty string but not omitting it */
	alt: string;
}

/** The DID resolver memoized once per execution in {@link Bluesky.execute}, threaded into every operation that writes a record */
type RepoResolver = () => Promise<string>;

/**
 * Read the Images fixedCollection into validated entries. Each row's binary field
 * name is user-supplied and is what `assertBinaryData` is keyed on, so a blank one
 * is rejected here instead of surfacing as a confusing "no binary data" error.
 */
function readImageInputs(
	context: IExecuteFunctions,
	itemIndex: number,
	raw: unknown,
): ImageInput[] {
	return asArray<unknown>(raw).map((entry, index) => {
		const image = asObject(entry);
		const binaryPropertyName = asString(image.binaryPropertyName).trim();

		if (!binaryPropertyName) {
			throw new NodeOperationError(
				context.getNode(),
				`Image ${index + 1} has no input binary field name`,
				{ itemIndex, description: 'Name the binary field holding the image, e.g. "data"' },
			);
		}

		return { binaryPropertyName, alt: asString(image.alt) };
	});
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
	uri: unknown,
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
	const text = asString(this.getNodeParameter('text', itemIndex, ''));
	const options = objectParam(this, 'additionalFields', itemIndex);
	const images = readImageInputs(
		this,
		itemIndex,
		this.getNodeParameter('images.image', itemIndex, []),
	);

	const record: IDataObject = {
		$type: NSID.feed.post,
		text,
		createdAt: new Date().toISOString(),
	};

	if (asBoolean(options.detectFacets, true)) {
		const facets = await buildFacets.call(this, text);
		if (facets.length) record.facets = facets;
	}

	const langs = splitList(options.langs).slice(0, 3);
	if (langs.length) record.langs = langs;

	const tags = splitList(options.tags).slice(0, 8);
	if (tags.length) record.tags = tags;

	const labels = asStringArray(options.labels);
	if (labels.length) {
		record.labels = {
			$type: NSID.label.selfLabels,
			values: labels.map((val) => ({ val })),
		};
	}

	const replyUri = asString(options.replyUri).trim();
	if (replyUri) {
		const parent = await getPostView.call(this, await resolvePostUri.call(this, replyUri));
		const parentRef = { uri: parent.uri, cid: parent.cid };
		const parentReply = asObject(asObject(parent.record).reply);

		record.reply = {
			root: asObject(parentReply.root).uri ? parentReply.root : parentRef,
			parent: parentRef,
		};
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
					alt: image.alt,
					image: await uploadBinaryImage.call(
						this,
						itemIndex,
						image.binaryPropertyName,
						MAX_IMAGE_BYTES,
					),
				})),
			),
		};
	} else if (asString(options.externalUri).trim()) {
		const external: IDataObject = {
			uri: asString(options.externalUri).trim(),
			title: asString(options.externalTitle),
			description: asString(options.externalDescription),
		};

		const thumbnailField = asString(options.externalThumbnail).trim();
		if (thumbnailField) {
			external.thumb = await uploadBinaryImage.call(
				this,
				itemIndex,
				thumbnailField,
				MAX_THUMBNAIL_BYTES,
			);
		}

		media = { $type: NSID.embed.external, external };
	}

	let quoteRef: IDataObject | undefined;
	const quoteUri = asString(options.quoteUri).trim();
	if (quoteUri) {
		const quoted = await getPostView.call(this, await resolvePostUri.call(this, quoteUri));
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
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
	await deleteRecordByUri.call(this, uri, itemIndex);
	return { success: true, uri };
}

async function getPost(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
	const post = await getPostView.call(this, uri);
	return booleanParam(this, 'simplify', itemIndex) ? simplifyPost(post) : post;
}

async function getPostThreadOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
	const options = objectParam(this, 'options', itemIndex);

	// Both are clamped to the range app.bsky.feed.getPostThread accepts, so an
	// out-of-range expression result is corrected rather than rejected by the API
	const clamp = (value: unknown, fallback: number) =>
		Math.min(1000, Math.max(0, Math.floor(asNumber(value, fallback))));

	const response = await blueskyApiRequest.call(
		this,
		'GET',
		NSID.feed.getPostThread,
		{},
		{
			uri,
			depth: clamp(options.depth, 6),
			parentHeight: clamp(options.parentHeight, 80),
		},
	);
	return asObject(response.thread);
}

async function searchPosts(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const filters = objectParam(this, 'filters', itemIndex);
	const qs: IDataObject = { q: requiredParam(this, 'query', itemIndex, 'Query'), ...filters };
	if (filters.author) qs.author = normalizeActor(filters.author);
	if (filters.mentions) qs.mentions = normalizeActor(filters.mentions);

	const { returnAll, limit } = paginationParams(this, itemIndex);
	const posts = await blueskyApiRequestAllItems.call(
		this,
		NSID.feed.searchPosts,
		'posts',
		qs,
		returnAll,
		limit,
	);

	return booleanParam(this, 'simplify', itemIndex) ? posts.map(simplifyPost) : posts;
}

async function likeOrRepostPost(
	this: IExecuteFunctions,
	operation: 'like' | 'repost',
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject> {
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
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
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
	const post = await getPostView.call(this, uri);
	const viewer = asObject(post.viewer);
	const recordUri = asString(operation === 'unlike' ? viewer.like : viewer.repost);

	if (recordUri) await deleteRecordByUri.call(this, recordUri, itemIndex);
	return { success: true, uri, changed: Boolean(recordUri) };
}

async function getPostLikes(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
	const { returnAll, limit } = paginationParams(this, itemIndex);
	const likes = await blueskyApiRequestAllItems.call(
		this,
		NSID.feed.getLikes,
		'likes',
		{ uri },
		returnAll,
		limit,
	);

	return booleanParam(this, 'simplify', itemIndex)
		? likes.map((like) => ({
				...simplifyProfile(like.actor),
				likedAt: like.createdAt,
			}))
		: likes;
}

async function getPostReposts(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const uri = await resolvePostUri.call(this, requiredParam(this, 'uri', itemIndex, 'Post'));
	const { returnAll, limit } = paginationParams(this, itemIndex);
	const profiles = await blueskyApiRequestAllItems.call(
		this,
		NSID.feed.getRepostedBy,
		'repostedBy',
		{ uri },
		returnAll,
		limit,
	);

	return booleanParam(this, 'simplify', itemIndex) ? profiles.map(simplifyProfile) : profiles;
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
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the post resource`,
				{ itemIndex },
			);
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
	const { returnAll, limit } = paginationParams(this, itemIndex);
	const feed = await blueskyApiRequestAllItems.call(this, nsid, 'feed', qs, returnAll, limit);

	return booleanParam(this, 'simplify', itemIndex) ? feed.map(simplifyPost) : feed;
}

async function getTimelineOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	return fetchFeed.call(this, itemIndex, NSID.feed.getTimeline, {});
}

async function getAuthorFeedOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const qs: IDataObject = {
		actor: normalizeActor(requiredParam(this, 'actor', itemIndex, 'Account')),
		...objectParam(this, 'options', itemIndex),
	};
	return fetchFeed.call(this, itemIndex, NSID.feed.getAuthorFeed, qs);
}

async function getCustomFeedOp(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const qs: IDataObject = { feed: requiredParam(this, 'feedUri', itemIndex, 'Feed') };
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
			return getTimelineOp.call(this, itemIndex);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the feed resource`,
				{ itemIndex },
			);
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
		{ actor: normalizeActor(requiredParam(this, 'actor', itemIndex, 'Account')) },
	);
	return booleanParam(this, 'simplify', itemIndex) ? simplifyProfile(profile) : profile;
}

async function searchUsers(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const { returnAll, limit } = paginationParams(this, itemIndex);
	const actors = await blueskyApiRequestAllItems.call(
		this,
		NSID.actor.searchActors,
		'actors',
		{ q: requiredParam(this, 'query', itemIndex, 'Query') },
		returnAll,
		limit,
	);
	return booleanParam(this, 'simplify', itemIndex) ? actors.map(simplifyProfile) : actors;
}

async function getFollowersOrFollowing(
	this: IExecuteFunctions,
	operation: 'getFollowers' | 'getFollowing',
	itemIndex: number,
): Promise<IDataObject[]> {
	const isFollowers = operation === 'getFollowers';
	const { returnAll, limit } = paginationParams(this, itemIndex);
	const profiles = await blueskyApiRequestAllItems.call(
		this,
		isFollowers ? NSID.graph.getFollowers : NSID.graph.getFollows,
		isFollowers ? 'followers' : 'follows',
		{ actor: normalizeActor(requiredParam(this, 'actor', itemIndex, 'Account')) },
		returnAll,
		limit,
	);
	return booleanParam(this, 'simplify', itemIndex) ? profiles.map(simplifyProfile) : profiles;
}

async function followOrBlock(
	this: IExecuteFunctions,
	operation: 'follow' | 'block',
	itemIndex: number,
	repo: RepoResolver,
): Promise<IDataObject> {
	const did = await resolveDid.call(this, requiredParam(this, 'actor', itemIndex, 'Account'));
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
	const actor = normalizeActor(requiredParam(this, 'actor', itemIndex, 'Account'));
	const profile = await blueskyApiRequest.call(this, 'GET', NSID.actor.getProfile, {}, { actor });
	// Same idempotent-delete pattern as unlike/unrepost above, but keyed off the
	// profile viewer's `following`/`blocking` record URI instead of a post's.
	const viewer = asObject(profile.viewer);
	const recordUri = asString(operation === 'unfollow' ? viewer.following : viewer.blocking);

	if (recordUri) await deleteRecordByUri.call(this, recordUri, itemIndex);
	return { success: true, actor, changed: Boolean(recordUri) };
}

async function muteOrUnmute(
	this: IExecuteFunctions,
	operation: 'mute' | 'unmute',
	itemIndex: number,
): Promise<IDataObject> {
	const actor = normalizeActor(requiredParam(this, 'actor', itemIndex, 'Account'));
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
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the user resource`,
				{ itemIndex },
			);
	}
}

// ============================================================
//                       Notification
// ============================================================

async function getAllNotifications(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const filters = objectParam(this, 'filters', itemIndex);
	const reasons = asStringArray(filters.reasons);

	const { returnAll, limit } = paginationParams(this, itemIndex);
	let notifications = await blueskyApiRequestAllItems.call(
		this,
		NSID.notification.listNotifications,
		'notifications',
		reasons.length ? { reasons } : {},
		returnAll,
		limit,
	);

	if (asBoolean(filters.onlyUnread)) {
		notifications = notifications.filter((entry) => !asBoolean(entry.isRead));
	}

	return booleanParam(this, 'simplify', itemIndex)
		? notifications.map((entry) => {
				const author = asObject(entry.author);
				const record = asObject(entry.record);

				return {
					uri: asString(entry.uri),
					cid: asString(entry.cid),
					reason: asString(entry.reason),
					reasonSubject: asString(entry.reasonSubject),
					isRead: asBoolean(entry.isRead),
					indexedAt: entry.indexedAt,
					text: asString(record.text),
					author: {
						did: asString(author.did),
						handle: asString(author.handle),
						displayName: asString(author.displayName),
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
	const input = stringParam(this, 'seenAt', itemIndex);
	const parsed = input ? new Date(input) : new Date();

	// `toISOString()` throws a raw RangeError on an unparseable date, which would
	// surface as an opaque node crash rather than a fixable parameter problem
	if (Number.isNaN(parsed.getTime())) {
		throw new NodeOperationError(this.getNode(), `"${input}" is not a valid date`, {
			itemIndex,
			description: 'Leave "Seen At" empty to mark everything up to now as read',
		});
	}

	const seenAt = parsed.toISOString();
	await blueskyApiRequest.call(this, 'POST', NSID.notification.updateSeen, { seenAt });
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
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the notification resource`,
				{ itemIndex },
			);
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

		const resource = asString(this.getNodeParameter('resource', 0, ''));
		const operation = asString(this.getNodeParameter('operation', 0, ''));

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
						throw new NodeOperationError(
							this.getNode(),
							`The resource "${resource}" is not supported`,
							{ itemIndex: i },
						);
				}

				returnData.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(responseData), {
						itemData: { item: i },
					}),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: String(error) },
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
