# 01 — HTTP Basics

## What is HTTP?

HTTP (HyperText Transfer Protocol) is the request/response protocol the web runs on. Your browser, curl, Postman, or a frontend app all speak it the same way: send a **request**, get back a **response**.

Think of it like mailing a letter:
- The **address on the envelope** is the URL.
- The **stuff written on the envelope itself** (fragile, return address, priority) is the headers.
- The **letter inside** is the body.

## Anatomy of a request

Every HTTP request has four parts:

```
POST /api/datasets HTTP/1.1          <- method + path + protocol version
Host: localhost:8000                 <- part of the URL
Authorization: Bearer test-token     <- headers
X-Organization-ID: org-42            <- headers
Content-Type: application/json       <- headers

{"title": "New Dataset", ...}        <- body
```

- **Method** — the verb: `GET` (read), `POST` (create), `PUT` (replace/update), `DELETE` (remove). This project uses all four.
- **URL** — where the request goes, made of a **path** (`/api/datasets/1`) and optionally a **query string** (`?year=2023`).
- **Headers** — metadata about the request itself: who's asking, what format the body is in, what format you'd like back. Not the actual data being operated on.
- **Body** — the payload, present on `POST`/`PUT` and absent on `GET`/`DELETE` in this project.

## A response looks similar

```
HTTP/1.1 200 OK
Content-Type: application/json

{"id": 1, "title": "Guangdong Coastal Zone Sentinel-1 SAR Mosaic 2023", ...}
```

- **Status code** — `200` (OK), `201` (created), `404` (not found), `401` (unauthorized), `422` (validation error). You'll see all of these while working through this lab.
- **Headers** — metadata about the response.
- **Body** — the actual data, usually JSON for a REST API.

## Try it yourself

With the lab running (see the main `README.md` for setup), run:

```bash
curl -i http://localhost:8000/api/datasets/1
```

The `-i` flag prints the response headers and status line along with the body, so you can see all three parts (status, headers, body) in one shot. Compare that to what happens when you request an id that doesn't exist:

```bash
curl -i http://localhost:8000/api/datasets/99999
```

Same shape, different status code and body — that's the whole story of HTTP.

Next: [02-request-components.md](./02-request-components.md) — where each of these pieces (header, path, query, body) is used for.
