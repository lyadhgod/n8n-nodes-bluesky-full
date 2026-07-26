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
		if (credentials.refreshJwt) {
			try {
				const { accessJwt, refreshJwt } = (await this.helpers.httpRequest({
					method: 'POST',
					url: `${credentials.pdsServer}/xrpc/${NSID.server.refreshSession}`,
					headers: { Authorization: `Bearer ${credentials.refreshJwt}` },
					json: true,
				})) as { accessJwt: string; refreshJwt: string };

				return { accessJwt, refreshJwt };
			} catch {
				// Refresh token expired or revoked; fall back to a fresh login below.
			}
		}

		const { accessJwt, refreshJwt } = (await this.helpers.httpRequest({
			method: 'POST',
			url: `${credentials.pdsServer}/xrpc/${NSID.server.createSession}`,
			body: {
				identifier: credentials.identifier,
				password: credentials.password,
			},
			json: true,
		})) as { accessJwt: string; refreshJwt: string };

		return { accessJwt, refreshJwt };
	}

	/** Attaches the session JWT `preAuthentication` produced/cached to every outgoing request */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessJwt}}',
			},
		},
	};

	/** Powers the "Test" button in the credential UI: a raw login attempt, bypassing preAuthentication's caching */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.pdsServer}}',
			url: `/xrpc/${NSID.server.createSession}`,
			method: 'POST',
			body: {
				identifier: '={{$credentials.identifier}}',
				password: '={{$credentials.password}}',
			},
		},
	};
}
