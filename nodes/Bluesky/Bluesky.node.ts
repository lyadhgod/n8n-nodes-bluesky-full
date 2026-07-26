import {
	NodeApiError,
	NodeConnectionTypes,
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
 * Bluesky's `com.atproto.repo.uploadBlob` rejects anything over 1MB, so this is
 * enforced client-side to fail fast with a clear message instead of a raw API error.
 */
const MAX_BLOB_BYTES = 1_000_000;

/** One entry of the `images.image` fixedCollection parameter on the Create Post operation */
interface ImageInput {
	/** Name of the input binary field holding the image data */
	binaryPropertyName: string;
	/** Alt text for screen readers; Bluesky allows an empty string but not omitting it */
	alt?: string;
}

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
 * Read an input binary field, enforce the 1MB blob limit, and upload it via
 * `com.atproto.repo.uploadBlob`. Used for both post images and link-card thumbnails.
 */
async function uploadBinaryImage(
	this: IExecuteFunctions,
	itemIndex: number,
	binaryPropertyName: string,
): Promise<IDataObject> {
	const binary = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);

	if (buffer.length > MAX_BLOB_BYTES) {
		throw new NodeOperationError(
			this.getNode(),
			`Image "${binaryPropertyName}" is ${buffer.length} bytes, over the 1MB limit of Bluesky`,
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

/**
 * Programmatic-style n8n node exposing the Bluesky AT Protocol API as four
 * resources (Post, Feed, User, Notification). Each resource/operation pair is
 * handled inline in {@link execute} rather than split into per-operation
 * modules, since every branch is a thin, direct mapping onto a single XRPC call.
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
	 * other parameter is read per item `i` so expressions can vary across items.
	 */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Record writes need the DID of the authenticated account, fetched at most once
		// per execution (not per item) since `repo` is always the same for all items.
		let ownDid: string | undefined;
		const repo = async () => (ownDid ??= await getOwnDid.call(this));

		for (let i = 0; i < items.length; i++) {
			try {
				const simplify = this.getNodeParameter('simplify', i, false) as boolean;
				const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
				const limit = this.getNodeParameter('limit', i, 50) as number;
				const now = new Date().toISOString();

				let responseData: IDataObject | IDataObject[] = {};

				if (resource === 'post') {
					if (operation === 'create') {
						const text = this.getNodeParameter('text', i) as string;
						const images = this.getNodeParameter('images.image', i, []) as ImageInput[];
						const options = this.getNodeParameter('additionalFields', i, {}) as IDataObject;

						const record: IDataObject = {
							$type: NSID.feed.post,
							text,
							createdAt: now,
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
							media = {
								$type: NSID.embed.images,
								images: await Promise.all(
									images.map(async (image) => ({
										alt: image.alt ?? '',
										image: await uploadBinaryImage.call(this, i, image.binaryPropertyName),
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
									i,
									options.externalThumbnail as string,
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

						responseData = await blueskyApiRequest.call(
							this,
							'POST',
							NSID.repo.createRecord,
							{ repo: await repo(), collection: NSID.feed.post, record },
						);
					} else if (operation === 'delete') {
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						await deleteRecordByUri.call(this, uri, i);
						responseData = { success: true, uri };
					} else if (operation === 'get') {
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						const post = await getPostView.call(this, uri);
						responseData = simplify ? simplifyPost(post) : post;
					} else if (operation === 'getThread') {
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						const options = this.getNodeParameter('options', i, {}) as IDataObject;

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
						responseData = response.thread as IDataObject;
					} else if (operation === 'search') {
						const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
						const qs: IDataObject = { q: this.getNodeParameter('query', i) as string, ...filters };
						if (filters.author) qs.author = normalizeActor(filters.author as string);
						if (filters.mentions) qs.mentions = normalizeActor(filters.mentions as string);

						const posts = await blueskyApiRequestAllItems.call(
							this,
							NSID.feed.searchPosts,
							'posts',
							qs,
							returnAll,
							limit,
						);
						responseData = simplify ? posts.map(simplifyPost) : posts;
					} else if (operation === 'like' || operation === 'repost') {
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						const post = await getPostView.call(this, uri);
						const collection = operation === 'like' ? NSID.feed.like : NSID.feed.repost;

						responseData = await blueskyApiRequest.call(
							this,
							'POST',
							NSID.repo.createRecord,
							{
								repo: await repo(),
								collection,
								record: {
									$type: collection,
									subject: { uri: post.uri, cid: post.cid },
									createdAt: now,
								},
							},
						);
					} else if (operation === 'unlike' || operation === 'unrepost') {
						// The post view's `viewer` block carries the AT URI of *this account's own*
						// like/repost record, if any; that's what has to be deleted, not the post itself.
						// Its absence means there was nothing to undo, so this operation is idempotent.
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						const post = await getPostView.call(this, uri);
						const viewer = (post.viewer ?? {}) as IDataObject;
						const recordUri = (operation === 'unlike' ? viewer.like : viewer.repost) as
							| string
							| undefined;

						if (recordUri) await deleteRecordByUri.call(this, recordUri, i);
						responseData = { success: true, uri, changed: Boolean(recordUri) };
					} else if (operation === 'getLikes') {
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						const likes = await blueskyApiRequestAllItems.call(
							this,
							NSID.feed.getLikes,
							'likes',
							{ uri },
							returnAll,
							limit,
						);

						responseData = simplify
							? likes.map((like) => ({
									...simplifyProfile((like.actor ?? {}) as IDataObject),
									likedAt: like.createdAt,
								}))
							: likes;
					} else if (operation === 'getReposts') {
						const uri = await resolvePostUri.call(this, this.getNodeParameter('uri', i) as string);
						const profiles = await blueskyApiRequestAllItems.call(
							this,
							NSID.feed.getRepostedBy,
							'repostedBy',
							{ uri },
							returnAll,
							limit,
						);
						responseData = simplify ? profiles.map(simplifyProfile) : profiles;
					}
				} else if (resource === 'feed') {
					const qs: IDataObject = {};
					let nsid: string = NSID.feed.getTimeline;

					if (operation === 'getAuthorFeed') {
						nsid = NSID.feed.getAuthorFeed;
						qs.actor = normalizeActor(this.getNodeParameter('actor', i) as string);
						Object.assign(qs, this.getNodeParameter('options', i, {}) as IDataObject);
					} else if (operation === 'getFeed') {
						nsid = NSID.feed.getFeed;
						qs.feed = this.getNodeParameter('feedUri', i) as string;
					}

					const feed = await blueskyApiRequestAllItems.call(
						this,
						nsid,
						'feed',
						qs,
						returnAll,
						limit,
					);
					responseData = simplify ? feed.map(simplifyPost) : feed;
				} else if (resource === 'user') {
					if (operation === 'get') {
						const profile = await blueskyApiRequest.call(
							this,
							'GET',
							NSID.actor.getProfile,
							{},
							{ actor: normalizeActor(this.getNodeParameter('actor', i) as string) },
						);
						responseData = simplify ? simplifyProfile(profile) : profile;
					} else if (operation === 'search') {
						const actors = await blueskyApiRequestAllItems.call(
							this,
							NSID.actor.searchActors,
							'actors',
							{ q: this.getNodeParameter('query', i) as string },
							returnAll,
							limit,
						);
						responseData = simplify ? actors.map(simplifyProfile) : actors;
					} else if (operation === 'getFollowers' || operation === 'getFollowing') {
						const isFollowers = operation === 'getFollowers';
						const profiles = await blueskyApiRequestAllItems.call(
							this,
							isFollowers ? NSID.graph.getFollowers : NSID.graph.getFollows,
							isFollowers ? 'followers' : 'follows',
							{ actor: normalizeActor(this.getNodeParameter('actor', i) as string) },
							returnAll,
							limit,
						);
						responseData = simplify ? profiles.map(simplifyProfile) : profiles;
					} else if (operation === 'follow' || operation === 'block') {
						const did = await resolveDid.call(this, this.getNodeParameter('actor', i) as string);
						const collection = operation === 'follow' ? NSID.graph.follow : NSID.graph.block;

						responseData = await blueskyApiRequest.call(
							this,
							'POST',
							NSID.repo.createRecord,
							{
								repo: await repo(),
								collection,
								record: { $type: collection, subject: did, createdAt: now },
							},
						);
					} else if (operation === 'unfollow' || operation === 'unblock') {
						const actor = normalizeActor(this.getNodeParameter('actor', i) as string);
						const profile = await blueskyApiRequest.call(
							this,
							'GET',
							NSID.actor.getProfile,
							{},
							{ actor },
						);
						// Same idempotent-delete pattern as unlike/unrepost above, but keyed off the
						// profile viewer's `following`/`blocking` record URI instead of a post's.
						const viewer = (profile.viewer ?? {}) as IDataObject;
						const recordUri = (operation === 'unfollow' ? viewer.following : viewer.blocking) as
							| string
							| undefined;

						if (recordUri) await deleteRecordByUri.call(this, recordUri, i);
						responseData = { success: true, actor, changed: Boolean(recordUri) };
					} else if (operation === 'mute' || operation === 'unmute') {
						const actor = normalizeActor(this.getNodeParameter('actor', i) as string);
						const nsid = operation === 'mute' ? NSID.graph.muteActor : NSID.graph.unmuteActor;
						await blueskyApiRequest.call(this, 'POST', nsid, { actor });
						responseData = { success: true, actor };
					}
				} else if (resource === 'notification') {
					if (operation === 'getAll') {
						const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
						const reasons = (filters.reasons ?? []) as string[];

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

						responseData = simplify
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
					} else if (operation === 'getUnreadCount') {
						responseData = await blueskyApiRequest.call(
							this,
							'GET',
							NSID.notification.getUnreadCount,
						);
					} else if (operation === 'markRead') {
						const seenAt = (this.getNodeParameter('seenAt', i, '') as string) || now;
						await blueskyApiRequest.call(this, 'POST', NSID.notification.updateSeen, {
							seenAt: new Date(seenAt).toISOString(),
						});
						responseData = { success: true, seenAt };
					}
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

				// NodeApiError passes existing NodeApiError instances straight through
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
