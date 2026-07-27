/**
 * Shared identifiers, hosts and AT Protocol method IDs (NSIDs), pulled out so
 * `nodes/Bluesky/*.ts` and `credentials/BlueskyApi.credentials.ts` — two
 * independent top-level directories compiled by the same `tsconfig.json` —
 * reference one source of truth instead of duplicating literals (which is how
 * `transport.ts` and `BlueskyApi.credentials.ts` previously drifted: the
 * credential's `pdsServer` field was being read back as `credentials.serviceUrl`,
 * a typo that made every authenticated request fail).
 *
 * Two categories of value are deliberately NOT here despite being "hardcoded":
 * - Node/credential `icon` paths (`Bluesky.node.ts`, `BlueskyApi.credentials.ts`):
 *   n8n's lint statically requires `icon` to be a literal `file:...` string; a
 *   value built from an imported constant fails with "Icon path must use
 *   file: protocol and be a string". They also differ in relative depth
 *   per file (`../../icons/...` vs `../icons/...`), so there's nothing to
 *   deduplicate anyway.
 * - The three `app.bsky.richtext.facet#*` `$type` strings in `richtext.ts`:
 *   that module is run directly by Node (no bundler) for `npm test` and must
 *   stay import-free — see the comment at the top of `richtext.ts`.
 */

/** The credential type's `name`, used both by the node's `credentials` array and by transport.ts */
export const CREDENTIAL_NAME = 'blueskyApi';

/** The node type's internal `name` (used in workflow JSON, expressions, etc.) */
export const NODE_NAME = 'bluesky';
/** The node's human-facing `displayName`, reused as the default node title (`defaults.name`) */
export const NODE_DISPLAY_NAME = 'Bluesky';

/** Default value of the `pdsServer` credential field: the flagship, most common AT Protocol PDS */
export const DEFAULT_PDS_SERVER = 'https://bsky.social';
/** Bluesky's web app, used to build/parse `https://bsky.app/profile/...` links (not an API host) */
export const BSKY_APP_URL = 'https://bsky.app';
/** Credential `documentationUrl`; also the closest still-existing docs.bsky.app page on auth/app passwords */
export const DOCS_URL = 'https://docs.bsky.app/docs/get-started';

/**
 * Applied to every outgoing request (session login/refresh, XRPC calls, blob
 * uploads). `IHttpRequestOptions.timeout` is passed straight through to axios,
 * whose own default is `0` — no timeout, wait forever — so a stalled connection
 * to the PDS would otherwise hang the request (and the node execution) indefinitely.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * AT Protocol XRPC method IDs (NSIDs), grouped by namespace to mirror how the
 * protocol itself groups them (`com.atproto.*` core repo/identity/session
 * operations vs. `app.bsky.*` application-layer ones). Each group name matches
 * the second NSID segment, e.g. `NSID.feed.getTimeline` is `app.bsky.feed.getTimeline`.
 */
export const NSID = {
	/** Session lifecycle: login, refresh, and reading the current session (used by credentials.ts) */
	server: {
		createSession: 'com.atproto.server.createSession',
		refreshSession: 'com.atproto.server.refreshSession',
		getSession: 'com.atproto.server.getSession',
	},
	/** Generic repo record operations, shared by every "create a record" write (post, like, follow, ...) */
	repo: {
		createRecord: 'com.atproto.repo.createRecord',
		deleteRecord: 'com.atproto.repo.deleteRecord',
		uploadBlob: 'com.atproto.repo.uploadBlob',
	},
	identity: {
		/** Handle → DID lookup; DIDs never need resolving, only bare handles do */
		resolveHandle: 'com.atproto.identity.resolveHandle',
	},
	label: {
		/** Self-applied content-warning labels (`$type` of a post record's `labels` field) */
		selfLabels: 'com.atproto.label.defs#selfLabels',
	},
	/** Post/feed reads and writes, and the record `$type` for like/repost (reused as both) */
	feed: {
		post: 'app.bsky.feed.post',
		like: 'app.bsky.feed.like',
		repost: 'app.bsky.feed.repost',
		getTimeline: 'app.bsky.feed.getTimeline',
		getAuthorFeed: 'app.bsky.feed.getAuthorFeed',
		getFeed: 'app.bsky.feed.getFeed',
		getPostThread: 'app.bsky.feed.getPostThread',
		getLikes: 'app.bsky.feed.getLikes',
		getRepostedBy: 'app.bsky.feed.getRepostedBy',
		searchPosts: 'app.bsky.feed.searchPosts',
	},
	actor: {
		getProfile: 'app.bsky.actor.getProfile',
		searchActors: 'app.bsky.actor.searchActors',
	},
	/** Social graph: follows, blocks, mutes, and the record `$type` for follow/block (reused as both) */
	graph: {
		follow: 'app.bsky.graph.follow',
		block: 'app.bsky.graph.block',
		getFollowers: 'app.bsky.graph.getFollowers',
		getFollows: 'app.bsky.graph.getFollows',
		muteActor: 'app.bsky.graph.muteActor',
		unmuteActor: 'app.bsky.graph.unmuteActor',
	},
	notification: {
		listNotifications: 'app.bsky.notification.listNotifications',
		getUnreadCount: 'app.bsky.notification.getUnreadCount',
		updateSeen: 'app.bsky.notification.updateSeen',
	},
	/** Post embed `$type`s: an image gallery, a link card, a quoted post, or a quote + image/link card together */
	embed: {
		images: 'app.bsky.embed.images',
		external: 'app.bsky.embed.external',
		record: 'app.bsky.embed.record',
		recordWithMedia: 'app.bsky.embed.recordWithMedia',
	},
} as const;
