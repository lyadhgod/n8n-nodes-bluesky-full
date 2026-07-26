import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
} from 'n8n-workflow';

import { CREDENTIAL_NAME, DEFAULT_PDS_SERVER, NSID } from '../../constants';
import { asArray, asNumber, asObject, asString } from '../../sanitize';

/**
 * Either function context the transport helpers can be bound to: `IExecuteFunctions`
 * for node execution, `ILoadOptionsFunctions` for resource-locator search (listSearch) calls.
 * Both expose `getCredentials`/`helpers.httpRequestWithAuthentication`, which is all this file needs.
 */
export type BlueskyContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * The user's Personal Data Server base URL (the `pdsServer` credential field,
 * e.g. `https://bsky.social`), trailing slashes stripped so it can be concatenated
 * with `/xrpc/<nsid>` unconditionally. Rejected when blank rather than left to
 * produce a relative `"/xrpc/..."` URL and an unrelated-looking request error.
 */
async function serviceUrl(context: BlueskyContext): Promise<string> {
	const credentials = await context.getCredentials(CREDENTIAL_NAME);
	const url = asString(credentials.pdsServer).trim().replace(/\/+$/, '');

	if (!url) {
		throw new NodeOperationError(
			context.getNode(),
			'No PDS server URL is set on the Bluesky credential',
			{ description: `Set it to ${DEFAULT_PDS_SERVER} unless the account is hosted elsewhere` },
		);
	}

	return url;
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

	this.logger.error('GOD', {method, nsid, qs, body, thisi: this})
	// Every XRPC method answers with a JSON object; `asObject` keeps a body that
	// isn't one (an error page, an empty 200) from being read as if it were.
	return asObject(
		await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, options),
	);
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

	let parsed: IDataObject = {};
	try {
		parsed = asObject(typeof response === 'string' ? JSON.parse(response) : response);
	} catch {
		// Not JSON at all; handled by the empty-blob check below
	}

	const blob = asObject(parsed.blob);
	if (!blob.ref) {
		throw new NodeOperationError(this.getNode(), 'The upload did not return a blob reference', {
			description:
				'The PDS accepted the request but its response had no usable `blob`, so there is nothing to attach to the record',
		});
	}

	return blob;
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
	// A limit that arrived as NaN or 0 (from an expression) would otherwise ask the
	// API for `limit=NaN` and, worse, make the loop's exit condition never true
	const target = Math.max(1, Math.floor(asNumber(limit, 50)));

	do {
		const pageSize = returnAll ? 100 : Math.min(target - items.length, 100);
		const response = await blueskyApiRequest.call(
			this,
			'GET',
			nsid,
			{},
			{ ...qs, limit: pageSize, ...(cursor ? { cursor } : {}) },
		);

		const page = asArray<unknown>(response[dataKey]).map(asObject);
		items.push(...page);

		// Stop on an empty page too: some feeds keep handing out a cursor forever
		cursor = page.length ? asString(response.cursor) || undefined : undefined;
	} while (cursor && (returnAll || items.length < target));

	return returnAll ? items : items.slice(0, target);
}

/**
 * The DID of the authenticated account, needed as the `repo` for record writes.
 * Validated here rather than at the call sites: an absent `did` would otherwise be
 * written into every created record as `repo: undefined`.
 */
export async function getOwnDid(this: BlueskyContext): Promise<string> {
	const session = await blueskyApiRequest.call(this, 'GET', NSID.server.getSession);
	const did = asString(session.did);

	if (!did.startsWith('did:')) {
		throw new NodeOperationError(
			this.getNode(),
			'Could not determine the DID of the authenticated account',
			{ description: `${NSID.server.getSession} responded without a valid "did"` },
		);
	}

	return did;
}
