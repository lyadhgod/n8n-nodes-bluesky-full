import type {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IDataObject,
	Icon,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';

import { CREDENTIAL_NAME, DEFAULT_PDS_SERVER, DOCS_URL, NSID } from '../constants';
import { asNumber, asObject, asString } from '../sanitize';

/**
 * The `exp` claim of a JWT in milliseconds, without verifying the signature, or
 * `0` for anything that isn't a JWT carrying a numeric `exp` — an empty string,
 * a truncated token, or a payload that isn't JSON. `0` reads as "expired at the
 * start of time", so every failure mode falls through to a fresh login.
 */
function decodeJwtExpiry(jwt: string): number {
	const payload = jwt.split('.')[1];
	if (!payload) return 0;

	try {
		const json = Buffer.from(
			payload.replace(/-/g, '+').replace(/_/g, '/'),
			'base64'
		).toString('utf8');
		return asNumber(asObject(JSON.parse(json)).exp, 0) * 1000;
	} catch {
		return 0;
	}
}

/**
 * Pull the token pair out of a `createSession`/`refreshSession` response. Both
 * tokens are checked for being non-empty strings here because this is the point
 * where a malformed response stops being visible: an absent `accessJwt` would be
 * cached by n8n and sent as the header `Authorization: Bearer undefined` on
 * every subsequent request, which the PDS rejects as a plain auth failure.
 */
function readSessionTokens(response: unknown, source: string): SessionTokens {
	const body = asObject(response);
	const accessJwt = asString(body.accessJwt).trim();
	const refreshJwt = asString(body.refreshJwt).trim();

	if (!accessJwt || !refreshJwt) {
		throw new Error(`${source} did not return a usable session token pair`);
	}

	return { accessJwt, refreshJwt };
}

/**
 * The short-lived access token and the long-lived refresh token of an AT Protocol
 * session. Extends `IDataObject` because n8n stores whatever `preAuthentication`
 * returns back onto the credential, and types that slot as one.
 */
interface SessionTokens extends IDataObject {
	accessJwt: string;
	refreshJwt: string;
}

/**
 * AT Protocol app-password credential. There is no OAuth flow here: the user
 * supplies their PDS URL plus an identifier/app-password pair, and
 * `preAuthentication` exchanges those for a short-lived session JWT that n8n
 * attaches via `authenticate` (see below) — mirroring how `com.atproto.server.*`
 * session auth works for every AT Protocol client, not just this node.
 */
export class BlueskyApi implements ICredentialType {
	name = CREDENTIAL_NAME;

	displayName = 'Bluesky API';

	icon: Icon = { light: 'file:../icons/bluesky.svg', dark: 'file:../icons/bluesky.dark.svg' };

	documentationUrl = DOCS_URL;

	properties: INodeProperties[] = [
		{
			displayName: 'PDS server URL',
			name: 'pdsServer',
			type: 'string',
			default: DEFAULT_PDS_SERVER,
			required: true,
			description: 'The AT Protocol PDS hosting the account',
		},
		{
			displayName: 'Identifier',
			name: 'identifier',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'e.g. example@email.com',
			description: 'Handle or other identifier supported by the server for the authenticating user',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Account password',
		},
		{
			displayName: 'Access JWT',
			name: 'accessJwt',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Refresh JWT',
			name: 'refreshJwt',
			type: 'hidden',
			default: '',
		},
	];

	// Bluesky issues short-lived session JWTs, so the app password is exchanged for one
	// before each request cycle. n8n caches the result (including refreshJwt) and
	// re-runs this on a 401, at which point the long-lived refresh token is used instead
	// of the app password to avoid createSession's stricter rate limit.
	async preAuthentication(
		this: IHttpRequestHelper,
		credentials: ICredentialDataDecryptedObject,
	): Promise<SessionTokens> {
		// Every field is read through `asString`: the decrypted credential object is
		// untyped, and `accessJwt`/`refreshJwt` in particular are absent on the first
		// run, before this method has ever stored them.
		const pdsServer = asString(credentials.pdsServer).trim().replace(/\/+$/, '');
		const identifier = asString(credentials.identifier).replace(/\s+/g, '');
		const password = asString(credentials.password).replace(/\s+/g, '');
		const refreshJwt = asString(credentials.refreshJwt).replace(/\s+/g, '');
		const accessJwt = asString(credentials.accessJwt).replace(/\s+/g, '');

		if (!pdsServer) throw new Error('No PDS server URL is set on this credential');
		if (!identifier || !password) {
			throw new Error('Both an identifier and a password are required to sign in');
		}

		const now = Date.now();

		// Access jwt is still valid
		if (accessJwt && now < decodeJwtExpiry(accessJwt)) {
			return { accessJwt, refreshJwt };
		}

		if (refreshJwt && now < decodeJwtExpiry(refreshJwt)) {
			try {
				return readSessionTokens(
					await this.helpers.httpRequest({
						method: 'POST',
						url: `${pdsServer}/xrpc/${NSID.server.refreshSession}`,
						headers: { Authorization: `Bearer ${refreshJwt}` },
						json: true,
					}),
					NSID.server.refreshSession,
				);
			} catch {
				// Refresh token expired or revoked; fall back to a fresh login below.
			}
		}

		return readSessionTokens(
			await this.helpers.httpRequest({
				method: 'POST',
				url: `${pdsServer}/xrpc/${NSID.server.createSession}`,
				body: { identifier, password },
				json: true,
			}),
			NSID.server.createSession,
		);
	}

	/**
	 * Attaches the session JWT `preAuthentication` produced/cached to every outgoing
	 * request. Each expression coerces via `String(value ?? '')` rather than
	 * `String(value)` — the latter renders a missing field as the literal
	 * `"undefined"` and sends it as if it were a real token — and rather than
	 * `value?.replace(...)`, which still throws if the field somehow isn't a string.
	 */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{ (typeof $credentials.accessJwt === "string" ? $credentials.accessJwt : "").replace(/\\s+/g, "") }}',
			},
		},
	}; 

	/** Powers the "Test" button in the credential UI: a raw login attempt, bypassing preAuthentication's caching */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ (typeof $credentials.pdsServer === "string" ? $credentials.pdsServer : "").trim().replace(/\\/+$/, "") }}',
			url: `/xrpc/${NSID.server.createSession}`,
			method: 'POST',
			body: {
				identifier: '={{ (typeof $credentials.identifier === "string" ? $credentials.identifier : "").replace(/\\s+/g, "") }}',
				password: '={{ (typeof $credentials.password === "string" ? $credentials.password : "").replace(/\\s+/g, "") }}',
			},
		},
	};
}
