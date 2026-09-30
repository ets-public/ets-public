# Enhanced Training Studio · free edition

Version **1.0.4** · 1 Oct 2026

A free Android app for your injection protocol. Everything stays on your phone.

- **Schedules and cycles:** every few days, set weekdays, or a cycle that stops after 6 or 12 weeks
- **Reminders:** morning and night, with Log and Snooze buttons on the notification
- **Logging:** the draw on the syringe, site rotation, vial stock and low-stock warnings
- **Estimated levels:** from your logged doses and each compound's half-life
- **Doctor report:** a PDF of your regimen, adherence, levels and injection log
- **Backups:** to your phone, or your own Google Drive, with an optional password; app lock

## Free edition and licence

This free edition is the injection tracker. A licence adds **training** (workouts, records, GPS runs), **blood tests** (PDF import, markers over time, on the levels chart) and **health** (Health Connect, readiness, live heart rate). It's a one-off payment in bitcoin: https://enhancedtraining.app/pricing/

Both editions get every fix, including security fixes, at the same time.

## Install

Download `ETS-free-1.0.4.apk` from this repository's **Releases** page and open it on your phone. Android asks once to allow installs from your browser.

**Upgrading to a licence:** install the licensed app over the top. Your data stays.

## Get it with F-Droid

Add the app's F-Droid repository and updates arrive in F-Droid: open https://ets-public.github.io/ets-public/ on your phone and tap **Add to F-Droid**. It carries the full app, the same one as on https://enhancedtraining.app: everything in this free edition, plus training, blood tests and health, which unlock with a licence key. The licensed parts aren't open source, so that build isn't made from this code alone. It's signed with the same key as the APK on the Releases page, so it installs over it and keeps your data.

## Build it yourself

You need Windows, Android Studio (for the Android SDK) and Node.js. Double-click `BUILD-APK.bat`. The script fetches a private copy of Node 22 and Java 21 if needed and builds `ETS-free-1.0.4.apk`. It's signed with your own Android debug key, so it installs as a separate copy, not as an update to the release APK.

## Licence

[Functional Source License 1.1, MIT Future License](LICENSE.md). You can use, change and share this code for your own use and for non-commercial teaching or research. You can't use it to offer a competing commercial product or service. Each version becomes available under the MIT licence two years after it was released.

The name "Enhanced Training Studio" and its logo aren't covered by the licence.
