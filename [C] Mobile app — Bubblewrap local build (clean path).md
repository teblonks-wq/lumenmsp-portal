# Build the Lumen MSP APK locally with Bubblewrap (clean-path method)

PWABuilder's cloud build kept failing/timeouts. This builds the signed APK on your machine.
The trick: install the JDK and Android SDK to paths with **no apostrophe** (your profile is
`C:\Users\TerryO'Kelly\…` — the apostrophe breaks the Android toolchain), then point Bubblewrap
at them. Run everything in **PowerShell**.

## 1. JDK 17 → C:\Java
- Download: https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip
- Extract it to `C:\Java\` so you end up with e.g. `C:\Java\jdk-17.0.13+11\` (note the exact folder name it creates — you'll use it below).

## 2. Android command-line tools → C:\Android
- Download "Command line tools only" (Windows) from https://developer.android.com/studio#command-tools
- Create `C:\Android\cmdline-tools\latest\` and extract so the `bin` folder is at
  `C:\Android\cmdline-tools\latest\bin\`.
- Install the SDK pieces + accept licences:
```
$env:ANDROID_HOME = "C:\Android"
C:\Android\cmdline-tools\latest\bin\sdkmanager.bat "platform-tools" "build-tools;34.0.0" "platforms;android-34"
C:\Android\cmdline-tools\latest\bin\sdkmanager.bat --licenses
```
(press `y` to each licence)

## 3. Point Bubblewrap at those paths
```
bubblewrap updateConfig --jdkPath "C:\Java\jdk-17.0.13+11" --androidSdkPath "C:\Android"
```
(use the exact JDK folder name from step 1)

## 4. Init the project
```
cd D:\LITS\lumen-twa
bubblewrap init --manifest https://portal.lumenmsp.co.uk/manifest.webmanifest
```
Answers:
- Package ID: `uk.co.lumenmsp.portal`
- App name: `Lumen MSP` · standalone · portrait
- Signing key: **create new** → SAVE the keystore + both passwords (vault).

(Optional, for the in-app live camera: edit `app/src/main/AndroidManifest.xml`, add
`<uses-permission android:name="android.permission.CAMERA" />` inside `<manifest>`.)

## 5. Build the APK
```
bubblewrap build
```
→ produces `app-release-signed.apk` (this is the file for Intune).

## 6. Fingerprint → server
```
bubblewrap fingerprint list
```
Copy the SHA-256, then on the server:
```
# /srv/apps/lumenmsp-portal/.env
TWA_SHA256=AA:BB:...:FF
TWA_PACKAGE=uk.co.lumenmsp.portal
# then
pm2 restart lumenmsp-portal
```
Verify https://portal.lumenmsp.co.uk/.well-known/assetlinks.json now lists the fingerprint.

## 7. Intune
Apps → Add → Android line-of-business app → upload `app-release-signed.apk` → assign to a test group.
