# MovieResolver API

Render-ready API.

## Endpoint

```txt
GET /movie/{number}
```

Example:

```txt
/movie/1726
```

Force a fresh scan instead of cached result:

```txt
/movie/1726?refresh=1
```

## Speed changes

- Chromium warms up on server start.
- Results are cached for 6 hours.
- Duplicate requests for the same movie share one scan.
- Images, fonts, stylesheets, and media downloads are blocked.
- The scan returns as soon as the first `/proxy/video?url=` link is found.
- Wait times are shorter for Render free tier.

## Render

Use Docker.

```txt
Dockerfile Path: ./Dockerfile
Docker Build Context Directory: .
Health Check Path: /healthz
```
