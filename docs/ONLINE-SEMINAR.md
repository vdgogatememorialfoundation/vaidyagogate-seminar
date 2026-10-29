# Online seminars

Each seminar is either **at the venue** or **online**. Online events use one platform:

| Platform | What the office connects |
| --- | --- |
| VGMF Hall | Nothing. The webinar runs on the seminar server. |
| Zoom | Server-to-server OAuth account ID, client ID, and client secret. |
| Google Meet | Google Calendar OAuth client, then Connect Google. |
| Zoho Webinar | OAuth client, organization id (zsoid), then Connect Zoho Webinar. |
| Zoho Backstage | OAuth client, portal id, then Connect Zoho Backstage. |

The connection form is on **Seminar Management → Online seminar connections**. Secrets are saved in the seminar database and are not shown again after saving.

Register this redirect URL on the Google and Zoho apps:

```
https://seminar.vaidyagogate.org/api/public/online-seminar/oauth/callback
```

Suggested scopes:

- Google: `https://www.googleapis.com/auth/calendar.events`
- Zoho Webinar: `ZohoWebinar.webinar.CREATE`, `ZohoWebinar.webinar.UPDATE`, `ZohoWebinar.webinar.READ`
- Zoho Backstage: `ZohoBackstage.event.CREATE`, `ZohoBackstage.event.UPDATE`, `ZohoBackstage.portal.READ`
- Zoom: meeting write and meeting update on a server-to-server OAuth app

## Who can join

Doctors with an issued ticket, approved volunteers, and the office. A passcode, when set, is required for doctors. The public seminar list shows only that the event is online and which platform it uses. It does not include the join link, host link, or passcode.

VGMF Hall opens about 30 minutes before the start. The office can open the host hall at any time. Video and chat stay on this server. The host can lock the hall, use a waiting room, admit people, put a doctor on stage, or remove someone.

Zoom, Meet, Backstage, and Zoho Webinar are created when the seminar is saved, after that account is connected. Until then, paste the attendee link on the seminar.

## Hall address

```
https://seminar.vaidyagogate.org/hall/{seminarId}
```

Doctors should use **Join online seminar** in the doctor portal so the ticket is checked first.
