# Administrator sign-in and recovery

Google and password sign-in open an existing Kuch profile. They never create an administrator or link profiles by matching email addresses. Preserve the current administrator IDs and role configuration when upgrading.

## Deployment configuration

Set `PASSWORD_LOGIN=1` to offer email/password sign-in. Existing passwords, passkeys and unverified login addresses continue to work. An old address must be verified before it can receive recovery mail. Identity and verification fields are additive to existing profile records in both storage backends; back up the database before upgrading and retain the single API process required by the storage ADR.

Set `PUBLIC_BASE_URL` to the exact public web base, with a trailing slash: for example `https://gym.example.com/` or `https://gym.example.com/gym/`. `ORIGIN` remains the origin used by existing passkey/CSRF configuration. Configure a Google web OAuth client and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the API only. Register the exact redirect URI `PUBLIC_BASE_URL` followed by `api/auth/google/callback`. The callback is a server endpoint, never a hash fragment. Register each environment separately. Use HTTPS outside local development.

The existing web proxy must forward the callback like other API requests. For a prefix-preserving proxy configure the existing web `BASE_PATH`; for a prefix-stripping proxy leave the web prefix configuration unchanged and still set the full public base on the API. Verify callbacks and return destinations through the public proxy, not only directly against the API port.

Configure `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM`. STARTTLS is required unless `SMTP_SECURE=true` selects implicit TLS (normally port 465). Do not disable certificate validation. Verification links expire after 24 hours; password recovery links expire after 30 minutes. Requests supersede earlier links of the same kind; successful use consumes the link. Delivery errors do not remove existing credentials. Recovery requests use a generic response to avoid disclosing account eligibility.

Google endpoint and token validation follows [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect); JWT verification uses [jose](https://github.com/panva/jose). Mail transport follows [Nodemailer SMTP configuration](https://nodemailer.com/smtp).

## Operator recovery when every method is lost

This is a privileged offline operation. Stop the API before opening its storage, on either backend. Retain a backup. Set the same storage configuration and `ADMIN_UIDS` as the stopped API, and enable password login for recovery and subsequent sign-in.

Run `node scripts/recover-admin.mjs PROFILE_ID` from the API directory with the new password on standard input, followed by EOF. Supply it through a private input mechanism; do not put the password in command arguments, shell history, screenshots or issue comments. The script rejects a non-administrator or disabled profile and never creates a new profile or grants a role. A conflicting password sign-in name must be resolved separately. It preserves profile ID, data, passkeys, Google identity and verified email, replaces the password, clears pending recovery/verification/device links and revokes all old browser and paired-mobile sessions.

For containers, stop the API service first, then use a one-off container with the same data volume/environment and `node scripts/recover-admin.mjs PROFILE_ID` as its command. Restart the API afterward, sign in as the same profile, establish a backup method and confirm old browser/mobile sessions fail. Rehearse this procedure on disposable test data before relying on it operationally.

## Required delivery evidence

Record the reviewed commit and successful Tests workflow run, with all five required jobs. Separately record real Google sign-in/linking/cancellation, public root/subpath callbacks, mail verification/reset delivery, mobile pairing and revocation, migration checks and the operator-recovery rehearsal. Never include credentials or active links. Missing provider/mail credentials leave that verification pending; fixture-based CI is not a substitute. No deployment or publishing workflow is authorized by this document.
