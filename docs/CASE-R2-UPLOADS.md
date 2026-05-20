# Case presentation uploads (Cloudflare R2)

Large doctor submissions (PDF, PPT, video) upload **directly to R2** from the browser. The Vercel app only issues presigned URLs and stores metadata in the database.

## Limits

| Setting | Value |
|--------|--------|
| Default per file | 100 MB |
| Max per file (admin program setting) | 250 MB |
| Hard reject | Files over 1 GB |
| Allowed types | PDF, PPT, PPTX, ZIP, DOCX, images, video |

Without R2 env vars, the app falls back to ~4 MB server uploads on Vercel.

## Vercel environment variables

Set these on the **seminar** Vercel project (Production + Preview):

```
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=seminar-case-files
```

Create an R2 API token with **Object Read & Write** on that bucket.

## Cloudflare R2 bucket CORS

Allow your site origin(s) for `PUT` and `GET`:

```json
[
  {
    "AllowedOrigins": ["https://seminar.vaidyagogate.org", "https://admin.vaidyagogate.org", "http://localhost:3000"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## Judge review

Judges receive **signed URLs** (1–2 hour TTL) for preview and download. Scoring and remarks are unchanged; previews use iframe/video/img where supported.

## Doctor flow

1. Select files → progress bar uploads to R2 (multipart for files ≥ 10 MB).
2. Submit application with `uploadedFileIds` (no file bytes through Vercel).
