# n8n-nodes-bluesky-full

This is an n8n community node. It lets you use the [Bluesky](https://bsky.app) AT Protocol API in your n8n workflows.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Operations

- **Post**
    - Create a post, reply or quote post, with images or a link card
    - Delete a post
    - Get a post
    - Get a post thread
    - Get the likes of a post
    - Get the reposts of a post
    - Like / Unlike a post
    - Repost / Unrepost a post
    - Search posts
- **Feed**
    - Get the home timeline
    - Get the feed of an account
    - Get a custom feed
- **User**
    - Get a profile
    - Search accounts
    - Get followers / following
    - Follow / Unfollow
    - Block / Unblock
    - Mute / Unmute
- **Notification**
    - Get many notifications
    - Get the unread count
    - Mark notifications as read

## Credentials

The node authenticates with an **app password**, not your account password.

1. In Bluesky go to **Settings → Privacy and Security → App Passwords** and create one.
2. In n8n create a **Bluesky API** credential and fill in:
    - **PDS Server URL** — leave at `https://bsky.social` unless your account lives on another PDS.
    - **Identifier** — your handle (`alice.bsky.social`), DID or email.
    - **App Password** — the password generated in step 1.

The credential exchanges those for a short-lived session token via `com.atproto.server.createSession`. The token will be cached and transparently re-authenticates when it expires until permitted by atproto.

## Compatibility

Requires n8n 1.x with community nodes enabled. Tested against n8n node API version 1.

## Usage

**Post URIs.** Anywhere the node asks for a post you can paste either an AT URI (`at://did:plc:…/app.bsky.feed.post/3k…`) or the bsky.app link from your browser. The same applies to accounts: a handle, a DID or a `https://bsky.app/profile/…` link all work.

**Rich text.** When creating a post, links, `@mentions` and `#hashtags` in the text are turned into clickable facets automatically. Mentions are resolved to DIDs; an unresolvable handle stays plain text. Turn this off with **Additional Fields → Detect Rich Text**.

**Images.** Attach up to four images from input binary fields. Bluesky rejects blobs over 1 MB, so resize beforehand — the node fails with a clear message rather than a raw API error. Always fill in the alt text.

**Threads.** To post a thread, chain several *Create* operations and feed the `uri` returned by one into **Reply To** of the next. The node resolves the thread root for you.

**Simplify.** Read operations return a flattened shape (uri, text, author, counts, web URL) by default. Switch **Simplify** off to get the raw AT Protocol response.

**Idempotency.** *Unlike*, *Unrepost*, *Unfollow* and *Unblock* do not fail when there is nothing to remove; they return `changed: false`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Bluesky HTTP API reference](https://docs.bsky.app/docs/category/http-reference)
- [Bluesky get started (auth)](https://docs.bsky.app/docs/get-started)
- [Post rich text (facets)](https://docs.bsky.app/docs/advanced-guides/post-richtext)
