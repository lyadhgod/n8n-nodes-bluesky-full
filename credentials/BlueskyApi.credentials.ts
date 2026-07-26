import type {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	IHttpRequestHelper,
	INodeProperties,
} from 'n8n-workflow';

import { CREDENTIAL_NAME, DEFAULT_PDS_SERVER, DOCS_URL, NSID } from '../constants';

/** Reads the `exp` claim (ms) out of a JWT without verifying its signature */
function decodeJwtExpiry(jwt: string): number {
	const payload = jwt.split('.')[1] ?? '';
	const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
	return JSON.parse(json).exp * 1000;
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
	];

	// Bluesky issues short-lived session JWTs, so the app password is exchanged for one
	// before each request cycle. n8n caches the result (including refreshJwt) and
	// re-runs this on a 401, at which point the long-lived refresh token is used instead
	// of the app password to avoid createSession's stricter rate limit.
	async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
		const pdsServer = String(credentials.pdsServer).replace(/\/+$/, '');
		const identifier = String(credentials.identifier).replace(/\s+/g, '');
		const password = String(credentials.password).replace(/\s+/g, '');
		const refreshJwt = String(credentials.refreshJwt).replace(/\s+/g, '');
		const accessJwt = String(credentials.accessJwt).replace(/\s+/g, '');

		const now = Date.now();
		let accessExpiry = 0;
		try {
			accessExpiry = decodeJwtExpiry(accessJwt);
		} catch {
			// Defaulting to start of time
		}
		let refreshExpiry = 0;
		try {
			refreshExpiry = decodeJwtExpiry(refreshJwt);
		} catch {
			// Defaulting to start of time
		}

		// Access jwt is still valid
		if (now < accessExpiry) {
			return { accessJwt, refreshJwt };
		}
		
		if (now < refreshExpiry) {
			try {
				const { accessJwt, refreshJwt: newRefreshJwt } = (await this.helpers.httpRequest({
					method: 'POST',
					url: `${pdsServer}/xrpc/${NSID.server.refreshSession}`,
					headers: { Authorization: `Bearer ${refreshJwt}` },
					json: true,
				})) as { accessJwt: string; refreshJwt: string };

				return { accessJwt, refreshJwt: newRefreshJwt };
			} catch {
				// Refresh token expired or revoked; fall back to a fresh login below.
			}
		}

		const { accessJwt: newAccessJwt, refreshJwt: newRefreshJwt } = (await this.helpers.httpRequest({
			method: 'POST',
			url: `${pdsServer}/xrpc/${NSID.server.createSession}`,
			body: { identifier, password },
			json: true,
		})) as { accessJwt: string; refreshJwt: string };

		return { accessJwt: newAccessJwt, refreshJwt: newRefreshJwt };
	}

	/** Attaches the session JWT `preAuthentication` produced/cached to every outgoing request */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{ String($credentials.accessJwt).replace(/\\s+/g, "") }}',
			},
		},
	};

	/** Powers the "Test" button in the credential UI: a raw login attempt, bypassing preAuthentication's caching */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ String($credentials.pdsServer).replace(/\\/+$/, "") }}',
			url: `/xrpc/${NSID.server.createSession}`,
			method: 'POST',
			body: {
				identifier: '={{ String($credentials.identifier).replace(/\\s+/g, "") }}',
				password: '={{ String($credentials.password).replace(/\\s+/g, "") }}',
			},
		},
	};
}
