# Getting the app onto an iPhone without opening Xcode

`.github/workflows/testflight.yml` archives, signs and uploads the app to TestFlight on every push to
`main` (and on demand from the Actions tab). Once it runs green, the app installs on any iPhone through
the TestFlight app, and every later push replaces the build. Nobody needs Xcode; the macOS runner has it.

It needs four repository secrets. Everything below happens on the Apple Developer and App Store Connect
websites, except one `openssl` command, and takes about twenty minutes the first time.

## Prerequisites

* An Apple Developer Program membership (the paid one; TestFlight needs it).
* The bundle identifier `com.technichrome.camera` registered as an App ID (Certificates, Identifiers &
  Profiles → Identifiers → +, App IDs, explicit bundle ID). Change it in `Technichrome.xcodeproj` and in the
  workflow's export plist if you register a different one.
* An app record in App Store Connect (My Apps → +, iOS, that bundle ID). TestFlight uploads land there.

## 1. Distribution certificate (`APPLE_CERTIFICATE_P12_BASE64`, `APPLE_CERTIFICATE_PASSWORD`)

On any machine with `openssl`:

```
openssl genrsa -out technichrome.key 2048
openssl req -new -key technichrome.key -out technichrome.csr -subj "/emailAddress=you@example.com/CN=Technichrome/C=US"
```

Certificates → + → *Apple Distribution* → upload `technichrome.csr` → download `distribution.cer`. Then:

```
openssl x509 -in distribution.cer -inform DER -out distribution.pem
openssl pkcs12 -export -inkey technichrome.key -in distribution.pem -out distribution.p12 -legacy
base64 -i distribution.p12 | pbcopy        # macOS; on Linux: base64 -w0 distribution.p12
```

Secret `APPLE_CERTIFICATE_P12_BASE64` = the pasted text; `APPLE_CERTIFICATE_PASSWORD` = the password you
gave `pkcs12 -export`. (`-legacy` keeps the file readable by macOS's `security import`; drop it if your
OpenSSL is older than 3.)

## 2. Provisioning profile (`APPLE_PROVISIONING_PROFILE_BASE64`)

Profiles → + → *App Store Connect* distribution → the App ID above → the certificate above → name it,
download `Technichrome_AppStore.mobileprovision`, and store `base64` of the file as the secret. The
workflow reads the profile's name and team from the file itself.

## 3. App Store Connect API key (`APP_STORE_CONNECT_API_KEY_JSON`)

App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → +, role
*App Manager*. Note the **Issuer ID** and the **Key ID**, download the `.p8` once. Store this JSON as
the secret (the key is the whole `.p8` file, newlines kept):

```
{"key_id": "ABC123DEF4", "issuer_id": "11111111-2222-3333-4444-555555555555", "key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"}
```

## 4. Run it

Push to `main`, or run *TestFlight* from the Actions tab. The first upload takes ten to twenty minutes
to appear in App Store Connect → TestFlight; add yourself as an internal tester and install from the
TestFlight app. Each run uses the GitHub run number as the build number, so builds are always newer than
the last.

Export compliance: `ITSAppUsesNonExemptEncryption` is `NO` in `Config/Info.plist`, so TestFlight does not
ask the encryption question for each build.

## When it fails

The archive and export logs are attached to the run. The usual causes: the bundle ID in the profile does
not match the project; the certificate's private key is not the one that made the CSR; the API key's
role is too low; or the app record does not exist yet in App Store Connect.
