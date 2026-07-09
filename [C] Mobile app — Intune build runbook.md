# Lumen MSP mobile app — build & deploy via Intune

The mobile app is the PWA at **portal.lumenmsp.co.uk/m** wrapped as a **Trusted Web Activity (TWA)** —
a signed Android APK that opens the site full-screen, no address bar. We publish it through
**Intune** (Line-of-Business app), not Google Play.

## One-time: tools (on your Windows machine)
- Node 18+ (you have it)
- JDK 17 — `winget install Microsoft.OpenJDK.17`
- Bubblewrap CLI — `npm install -g @bubblewrap/cli`
  (first run downloads the Android SDK build-tools automatically)

## 1. Initialise the project (once)
```
mkdir lumen-twa && cd lumen-twa
bubblewrap init --manifest https://portal.lumenmsp.co.uk/manifest.webmanifest
```
Answer the prompts:
- Application ID / package: **uk.co.lumenmsp.portal**
- App name: **Lumen MSP**
- Display mode: standalone, Orientation: portrait
- Signing key: let it **create a new keystore** → it makes `android.keystore` and asks for
  a keystore password + key password. **SAVE BOTH** (store in the portal vault). You need the
  same keystore for every future update.

### Enable the in-app camera (optional but recommended)
The receipt screen falls back to the OS camera without this, but for the live in-app shutter,
edit `app/src/main/AndroidManifest.xml` and add inside `<manifest>`:
```
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

## 2. Build the signed APK
```
bubblewrap build
```
Produces `app-release-signed.apk` (this is what Intune needs).

## 3. Get the signing fingerprint → verify the domain
```
bubblewrap fingerprint list
```
Copy the **SHA-256** (colon-separated). Then on the server set it and restart:
```
# in /srv/apps/lumenmsp-portal/.env
TWA_SHA256=AA:BB:CC:...:FF
TWA_PACKAGE=uk.co.lumenmsp.portal
# then:
pm2 restart lumenmsp-portal
```
Check it serves: `https://portal.lumenmsp.co.uk/.well-known/assetlinks.json` should now list your
fingerprint. (Without this the app still runs but shows a browser address bar.)

## 4. Upload to Intune
Intune admin centre → **Apps → All apps → Add → Android line-of-business app** →
upload `app-release-signed.apk` → assign to your user/device group (start with a test group).

## 5. App Protection Policy (BYOD / camera)
If you apply an Intune **App Protection Policy** (MAM) to the app or to Edge, make sure it does
**not** block the camera or file transfer, or the receipt photo button won't work:
- "Send org data to other apps" / "Receive data from other apps" — allow (or set to managed apps)
- Don't disable device camera in the policy.

## Updating later
Change code on the portal → it's live instantly (the app just loads the site). Only rebuild +
re-upload the APK if the shell/version changes — use the **same keystore** from step 1.
