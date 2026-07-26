import type { INodeProperties } from 'n8n-workflow';

import { paginationFields, postUriField, simplifyField } from './shared';

/** Shorthand for `displayOptions` scoped to the Post resource and a set of operations */
const showFor = (operations: string[]) => ({
	show: { resource: ['post'], operation: operations },
});

/**
 * Properties for the Post resource: Create, Delete, Get, Get Thread, Search,
 * Like/Unlike, Repost/Unrepost, Get Likes, Get Reposts.
 */
export const postDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['post'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Publish a new post, reply or quote post',
				action: 'Create a post',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Delete one of your own posts',
				action: 'Delete a post',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Retrieve a single post',
				action: 'Get a post',
			},
			{
				name: 'Get Likes',
				value: 'getLikes',
				description: 'Retrieve the accounts that liked a post',
				action: 'Get the likes of a post',
			},
			{
				name: 'Get Reposts',
				value: 'getReposts',
				description: 'Retrieve the accounts that reposted a post',
				action: 'Get the reposts of a post',
			},
			{
				name: 'Get Thread',
				value: 'getThread',
				description: 'Retrieve a post together with its parents and replies',
				action: 'Get a post thread',
			},
			{
				name: 'Like',
				value: 'like',
				description: 'Like a post',
				action: 'Like a post',
			},
			{
				name: 'Repost',
				value: 'repost',
				description: 'Repost a post',
				action: 'Repost a post',
			},
			{
				name: 'Search',
				value: 'search',
				description: 'Search posts across the network',
				action: 'Search posts',
			},
			{
				name: 'Unlike',
				value: 'unlike',
				description: 'Remove your like from a post',
				action: 'Unlike a post',
			},
			{
				name: 'Unrepost',
				value: 'unrepost',
				description: 'Remove your repost of a post',
				action: 'Unrepost a post',
			},
		],
		default: 'create',
	},

	// ----------------------------------
	//             create
	// ----------------------------------
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		description: 'The text of the post, up to 300 graphemes. May be empty when an image is attached.',
		displayOptions: showFor(['create']),
	},
	{
		displayName: 'Images',
		name: 'images',
		placeholder: 'Add Image',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, maxValue: 4 },
		default: {},
		description: 'Up to four images to attach to the post',
		displayOptions: showFor(['create']),
		options: [
			{
				displayName: 'Image',
				name: 'image',
				values: [
					{
						displayName: 'Input Binary Field',
						name: 'binaryPropertyName',
						type: 'string',
						default: 'data',
						required: true,
						hint: 'The name of the input binary field containing the image',
					},
					{
						displayName: 'Alt Text',
						name: 'alt',
						type: 'string',
						default: '',
						description: 'Description of the image for people using screen readers',
					},
				],
			},
		],
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: showFor(['create']),
		options: [
			{
				displayName: 'Content Warnings',
				name: 'labels',
				type: 'multiOptions',
				default: [],
				description: 'Self-applied labels that hide the post behind a warning',
				options: [
					{ name: 'Graphic Media', value: 'graphic-media' },
					{ name: 'Nudity', value: 'nudity' },
					{ name: 'Porn', value: 'porn' },
					{ name: 'Sexual', value: 'sexual' },
				],
			},
			{
				displayName: 'Detect Rich Text',
				name: 'detectFacets',
				type: 'boolean',
				default: true,
				description:
					'Whether to turn links, @mentions and #hashtags in the text into clickable facets',
			},
			{
				displayName: 'Languages',
				name: 'langs',
				type: 'string',
				default: '',
				placeholder: 'e.g. en, de',
				description: 'Comma-separated list of language codes of the post text, up to three',
			},
			{
				displayName: 'Link Card Description',
				name: 'externalDescription',
				type: 'string',
				default: '',
				description: 'Description shown on the link card',
			},
			{
				displayName: 'Link Card Thumbnail Field',
				name: 'externalThumbnail',
				type: 'string',
				default: '',
				placeholder: 'e.g. data',
				description: 'Name of the input binary field holding the link card thumbnail image',
			},
			{
				displayName: 'Link Card Title',
				name: 'externalTitle',
				type: 'string',
				default: '',
				description: 'Title shown on the link card',
			},
			{
				displayName: 'Link Card URL',
				name: 'externalUri',
				type: 'string',
				default: '',
				placeholder: 'e.g. https://example.com/article',
				description: 'Attach a website preview card pointing at this URL',
			},
			{
				displayName: 'Quote Post',
				name: 'quoteUri',
				type: 'string',
				default: '',
				description: 'The AT URI or bsky.app link of the post to quote',
			},
			{
				displayName: 'Reply To',
				name: 'replyUri',
				type: 'string',
				default: '',
				description: 'The AT URI or bsky.app link of the post to reply to',
			},
			{
				displayName: 'Tags',
				name: 'tags',
				type: 'string',
				default: '',
				placeholder: 'e.g. n8n, automation',
				description: 'Comma-separated hashtags to attach without showing them in the text',
			},
		],
	},

	// ----------------------------------
	//         single post targets
	// ----------------------------------
	postUriField([
		'delete',
		'get',
		'getLikes',
		'getReposts',
		'getThread',
		'like',
		'repost',
		'unlike',
		'unrepost',
	]),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['getThread']),
		options: [
			{
				displayName: 'Depth',
				name: 'depth',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1000 },
				default: 6,
				description: 'How many levels of replies to include',
			},
			{
				displayName: 'Parent Height',
				name: 'parentHeight',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1000 },
				default: 80,
				description: 'How many levels of parent posts to include',
			},
		],
	},

	// ----------------------------------
	//             search
	// ----------------------------------
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. n8n automation',
		description: 'The search query. Lucene syntax is supported.',
		displayOptions: showFor(['search']),
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: showFor(['search']),
		options: [
			{
				displayName: 'Author',
				name: 'author',
				type: 'string',
				default: '',
				placeholder: 'e.g. alice.bsky.social',
				description: 'Only return posts by this handle or DID',
			},
			{
				displayName: 'Domain',
				name: 'domain',
				type: 'string',
				default: '',
				placeholder: 'e.g. example.com',
				description: 'Only return posts linking to this domain',
			},
			{
				displayName: 'Language',
				name: 'lang',
				type: 'string',
				default: '',
				placeholder: 'e.g. en',
				description: 'Only return posts in this language',
			},
			{
				displayName: 'Mentions',
				name: 'mentions',
				type: 'string',
				default: '',
				placeholder: 'e.g. alice.bsky.social',
				description: 'Only return posts mentioning this handle or DID',
			},
			{
				displayName: 'Since',
				name: 'since',
				type: 'dateTime',
				default: '',
				description: 'Only return posts created after this date',
			},
			{
				displayName: 'Sort By',
				name: 'sort',
				type: 'options',
				default: 'latest',
				description: 'Ranking of the returned posts',
				options: [
					{ name: 'Latest', value: 'latest' },
					{ name: 'Top', value: 'top' },
				],
			},
			{
				displayName: 'Tag',
				name: 'tag',
				type: 'string',
				default: '',
				placeholder: 'e.g. automation',
				description: 'Only return posts carrying this hashtag, without the leading #',
			},
			{
				displayName: 'Until',
				name: 'until',
				type: 'dateTime',
				default: '',
				description: 'Only return posts created before this date',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				description: 'Only return posts linking to this URL',
			},
		],
	},

	...paginationFields('post', ['getLikes', 'getReposts', 'search']),
	simplifyField('post', ['get', 'getLikes', 'getReposts', 'search']),
];
