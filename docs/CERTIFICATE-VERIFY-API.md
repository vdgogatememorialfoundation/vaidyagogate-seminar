# Certificate verification API

Use this when the foundation's main website needs to check a certificate. Every issued participant or volunteer certificate has its own **12-digit certificate id**. That number is printed on the certificate. The main site sends the number here and shows the result.

Base URL:

```
https://seminar.vaidyagogate.org
```

The same notes are published at [https://seminar.vaidyagogate.org/developers/certificate-api](https://seminar.vaidyagogate.org/developers/certificate-api).

No API key, login, or email code is required. The response never includes the holder's email or phone.

## Check a certificate

```
GET /api/public/certificates/verify/{certificateId}
GET /api/public/certificates/verify?id={certificateId}
```

`certificateId` is the 12 digits from the certificate. Spaces and dashes are ignored. Anything that is not exactly 12 digits is rejected.

```bash
curl -sS "https://seminar.vaidyagogate.org/api/public/certificates/verify/433495146392"
```

A valid certificate returns HTTP 200:

```json
{
  "ok": true,
  "valid": true,
  "status": "valid",
  "certificateId": "433495146392",
  "kind": "participant",
  "holderName": "Dr Asha Gogate",
  "prn": "PRN2600000001",
  "applicationNo": "SEM-2026-0015",
  "event": {
    "id": 9,
    "title": "Manas Rog 3",
    "date": "2026-02-04"
  },
  "issuedAt": "2026-02-05T10:00:00.000Z",
  "message": "This certificate is authentic and was issued by the Vaidya Gogate Memorial Foundation."
}
```

`kind` is `participant` or `volunteer`. `event.date` is the seminar date stored for that event. `issuedAt` is when the certificate was sent, when that time is on record.

## Other results

| HTTP | status | Meaning |
| --- | --- | --- |
| 200 | `valid` | The certificate was issued and is active. |
| 200 | `not_found` | No certificate uses this id. |
| 200 | `not_issued` | The id exists, but the certificate is not active. The holder's name is not returned. |
| 400 | `invalid_id` | The value is not 12 digits. |
| 429 | `rate_limited` | More than 60 lookups from the same address in one minute. |
| 500 | — | The seminar portal could not complete the lookup. |

Unknown and inactive ids still return HTTP 200 so the main site can read `valid` and `message` without treating them as a network failure.

```json
{
  "ok": true,
  "valid": false,
  "status": "not_found",
  "certificateId": "000000000000",
  "message": "No certificate was found for this id."
}
```

## Browser example

The seminar portal allows cross-origin requests, so the main site can call this from the visitor's browser.

```javascript
async function verifyCertificate(certificateId) {
  const id = String(certificateId || '').replace(/\D/g, '');
  const res = await fetch(
    'https://seminar.vaidyagogate.org/api/public/certificates/verify/' + encodeURIComponent(id)
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'Certificate lookup failed');
  return body;
}
```

Show `holderName`, `event.title`, `applicationNo`, and `prn` only when `body.valid` is true. For every other status, show `body.message` or `body.error`.

## When an id exists

The portal assigns the 12-digit id when the certificate is issued and the holder is notified. The same id is printed on the PDF. Creating an event does not by itself create certificate ids. Ids are created per issued certificate, including a later event's certificates.

Do not build the check from the application number or PRN alone. Those can repeat across records. The certificate id is the value this API accepts.
