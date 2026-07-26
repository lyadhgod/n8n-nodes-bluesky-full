import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';

import { CREDENTIAL_NAME, NSID } from '../../constants';

/**
 * Either function context the transport helpers can be bound to: `IExecuteFunctions`
 * for node execution, `ILoadOptionsFunctions` for resource-locator search (listSearch) calls.
 * Both expose `getCredentials`/`helpers.httpRequestWithAuthentication`, which is all this file needs.
 */
export type BlueskyContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * The user's Personal Data Server base URL (the `pdsServer` credential field,
 * e.g. `https://bsky.social`), trailing slashes stripped so it can be concatenated
 * with `/xrpc/<nsid>` unconditionally.
 */
async function serviceUrl(context: BlueskyContext): Promise<string> {
	const credentials = await context.getCredentials(CREDENTIAL_NAME);
	return String(credentials.pdsServer).replace(/\/+$/, '');
}

/**
 * Call an XRPC method, e.g. `app.bsky.feed.getTimeline` (see {@link NSID}).
 * Authentication (attaching the session JWT, refreshing it on expiry) is handled
 * by n8n via `httpRequestWithAuthentication` and the credential's `authenticate`/
 * `preAuthentication` hooks in `BlueskyApi.credentials.ts` — this function only
 * shapes the request itself.
 */
export async function blueskyApiRequest(
	this: BlueskyContext,
	method: IHttpRequestMethods,
	nsid: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await serviceUrl(this)}/xrpc/${nsid}`,
		qs,
		// XRPC expects repeated keys for array parameters, e.g. `reasons=like&reasons=reply`
		arrayFormat: 'repeat',
		json: true,
	};

	if (method !== 'GET') {
		options.body = body;
	}

	return (await this.helpers.httpRequestWithAuthentication.call(
		this,
		CREDENTIAL_NAME,
		options,
	)) as IDataObject;
}

/**
 * Upload binary data via `com.atproto.repo.uploadBlob` and return the resulting
 * blob reference, which is embedded (not the raw bytes) in the record that references it,
 * e.g. a post's `embed.images[].image`.
 */
export async function uploadBlob(
	this: IExecuteFunctions,
	data: Buffer,
	mimeType: string,
): Promise<IDataObject> {
	// `json: false` keeps n8n from re-encoding the raw bytes as a JSON body
	const response = await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, {
		method: 'POST',
		url: `${await serviceUrl(this)}/xrpc/${NSID.repo.uploadBlob}`,
		body: data,
		headers: { 'Content-Type': mimeType },
		json: false,
	});

	const parsed = (typeof response === 'string' ? JSON.parse(response) : response) as {
		blob: IDataObject;
	};

	return parsed.blob;
}

/**
 * Follow the `cursor` of a paginated XRPC method until `limit` items are
 * collected, or until the API runs out of pages when `returnAll` is set.
 *
 * @param dataKey the response field holding the page's array, e.g. `'feed'` for
 *   `getTimeline`, `'notifications'` for `listNotifications` — every paginated
 *   XRPC method wraps its items under a different key.
 */
export async function blueskyApiRequestAllItems(
	this: BlueskyContext,
	nsid: string,
	dataKey: string,
	qs: IDataObject,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const items: IDataObject[] = [];
	let cursor: string | undefined;

	do {
		const pageSize = returnAll ? 100 : Math.min(limit - items.length, 100);
		const response = await blueskyApiRequest.call(
			this,
			'GET',
			nsid,
			{},
			{ ...qs, limit: pageSize, ...(cursor ? { cursor } : {}) },
		);

		const page = (response[dataKey] ?? []) as IDataObject[];
		items.push(...page);

		// Stop on an empty page too: some feeds keep handing out a cursor forever
		cursor = page.length ? (response.cursor as string | undefined) : undefined;
	} while (cursor && (returnAll || items.length < limit));

	return returnAll ? items : items.slice(0, limit);
}

/** The DID of the authenticated account, needed as the `repo` for record writes */
export async function getOwnDid(this: BlueskyContext): Promise<string> {
	const session = await blueskyApiRequest.call(this, 'GET', NSID.server.getSession);
	return session.did as string;
}
