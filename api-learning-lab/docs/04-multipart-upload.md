# 04 — Multipart Upload

## Why can't JSON just carry the file?

JSON is a **text** format. Every JSON value — string, number, object — has to be representable as Unicode text. A file (an image, a `.tif` raster, a zipped archive) is **arbitrary binary data**: any byte value, in any order, with no guarantee it's valid text at all.

You *can* cram binary data into JSON by Base64-encoding it into a string, but that costs you:
- ~33% larger payload (Base64 expands 3 bytes into 4 characters)
- The whole file has to be loaded into memory and encoded before you can even start sending it — no streaming
- You still need a separate mechanism to say "this string is a file, and here's its filename/content-type", because JSON strings don't carry that metadata

For anything beyond trivial file sizes, this is wasteful and awkward. HTTP already has a mechanism designed exactly for this: **`multipart/form-data`**.

## What multipart/form-data actually is

A multipart request splits the body into named **parts**, separated by a boundary marker, and — critically — each part can independently declare its own content type. One part can be plain text, the next can be raw binary, in the same request.

A real request to this lab's upload endpoint looks like this on the wire:

```
POST /api/datasets/2/files HTTP/1.1
Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryXYZ

------WebKitFormBoundaryXYZ
Content-Disposition: form-data; name="file"; filename="scan.tif"
Content-Type: image/tiff

<raw binary bytes of scan.tif, unmodified, unencoded>
------WebKitFormBoundaryXYZ
Content-Disposition: form-data; name="fileType"

image/tiff
------WebKitFormBoundaryXYZ--
```

Two parts in one request: `file` (binary, streamed as-is, no encoding overhead) and `fileType` (plain text form field). That's the "mixed form data" multipart is for — see `backend/app/controller/upload_controller.py`'s `upload_file()`, which reads exactly these two parts via FastAPI's `File(...)` and `Form(...)`.

## Try it yourself

```bash
echo "sample content" > /tmp/test.csv
curl -s -X POST http://localhost:8000/api/datasets/2/files \
  -F "file=@/tmp/test.csv" \
  -F "fileType=text/csv" | python -m json.tool
```

The `-F` flag is curl's shorthand for building a multipart request — compare it to `-d` (used for JSON bodies elsewhere in this lab), and notice curl automatically sets `Content-Type: multipart/form-data` with a boundary when you use `-F`, versus you setting `Content-Type: application/json` by hand for JSON requests.

Then confirm it landed in the database, not just on disk:

```bash
curl -s http://localhost:8000/api/datasets/2/files | python -m json.tool
```

You should see your uploaded file's metadata (`fileName`, `filePath`, `fileType`, `fileSize`) alongside the one that was already seeded for that dataset.

Next: [05-learning-plan.md](./05-learning-plan.md) — the 90-minute schedule for working through all of this.
