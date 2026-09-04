# Wishlist board

A public board where anyone can pin a wish. No accounts. Name defaults to `anon`.

Each wish can carry text, links, uploaded images, video and audio. Links to
YouTube, TikTok, Vimeo, Spotify, SoundCloud and direct media files are embedded
automatically. Files can be added with the button, pasted from the clipboard,
or dragged onto the note.

## Run

Requires Node 22.13 or newer (uses the built-in `node:sqlite`, no dependencies).

```sh
npm start
```

Open http://localhost:3000.

## Configuration

| Variable        | Default          | Meaning                                              |
| --------------- | ---------------- | ---------------------------------------------------- |
| `PORT`          | `3000`           | Port to listen on                                    |
| `HOST`          | all interfaces   | Bind address (IPv4 and IPv6 by default)              |
| `DATA_DIR`      | `./data`         | Holds `wishlist.db` and `uploads/`. Back this up.    |
| `DB_PATH`       | `$DATA_DIR/wishlist.db` | SQLite file                                   |
| `MAX_UPLOAD_MB` | `25`             | Per-file upload limit                                |
| `TRUST_PROXY`   | unset            | Set to `1` behind nginx/caddy so rate limits use the real client IP |
| `ADMIN_TOKEN`   | unset            | When set, enables `DELETE /api/wishes/:id` for moderation |

## Moderation

```sh
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://your.site/api/wishes/123
```

Deleting a wish also removes its uploaded files.

## Deploy (systemd example)

```ini
[Unit]
Description=wishlist board
After=network.target

[Service]
WorkingDirectory=/srv/wishlist
Environment=PORT=3000
Environment=TRUST_PROXY=1
Environment=DATA_DIR=/srv/wishlist/data
Environment=ADMIN_TOKEN=change-me
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Put nginx or caddy in front for TLS. Raise the proxy body limit to match
`MAX_UPLOAD_MB` (nginx: `client_max_body_size 25m;`).

## API

- `GET /api/wishes?before=<id>` newest first, 40 per page
- `POST /api/wishes` JSON `{ name, text, media: [uploadId] }`
- `POST /api/upload` raw file body, `Content-Type` = file mime, optional `X-File-Name`
- `DELETE /api/wishes/:id` with bearer `ADMIN_TOKEN`

## History

`backup/` holds the original static shelf site and a JSON export of its content.
