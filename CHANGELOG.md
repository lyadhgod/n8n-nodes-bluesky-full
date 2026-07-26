# Changelog

## 0.1.0

Initial release: a Bluesky node for the AT Protocol API.

- **Credentials** — `Bluesky API`, authenticating with an app password that is exchanged for a session token on demand.
- **Post** — create (with replies, quotes, images, link cards, self labels and automatic rich-text facets), delete, get, get thread, search, like, unlike, repost, unrepost, get likes, get reposts.
- **Feed** — home timeline, author feed, custom feed generators.
- **User** — get profile, search, followers, following, follow, unfollow, block, unblock, mute, unmute.
- **Notification** — get many, unread count, mark as read.
- Post and account inputs accept AT URIs, handles, DIDs or bsky.app links.
- Cursor pagination via `Return All` / `Limit`, and an optional `Simplify` output on read operations.
