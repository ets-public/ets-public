"""Runs `fdroid` with one change: it accepts this app's APK signing key rotation.

Written by ets-web/scripts/free-release.mjs: edit it there (free/fdroid/ets_fdroid.py), not here.

The app is signed with Android's key rotation (APK Signature Scheme v3): its v2 signature carries the original
key and its v3 signature the newer release key, plus a signed lineage linking the two. Android accepts that, but
fdroidserver's get_first_signer_certificate() refuses any APK whose v2 and v3 certificates differ.

For an APK carrying exactly the two pinned certificates (and nothing else), this returns the ORIGINAL one: the
F-Droid app compares updates against the oldest signer of the installed app ("always gives us the oldest signer,
even if they rotated certs by now", fdroidclient UpdateChecker.kt), so that's the one the index must list.
Every other APK goes through fdroidserver unchanged, and `fdroid update` still runs apksigner verify on every
APK, which checks the v3 signature and lineage properly.

Usage: python ets_fdroid.py update --verbose   (same arguments as `fdroid`)
Pinned SHA-256 fingerprints come from the environment: ETS_SIGNER_ORIGINAL and ETS_SIGNER_ROTATED.
"""
import hashlib
import logging
import os
import sys

from fdroidserver import common

ORIGINAL = os.environ.get('ETS_SIGNER_ORIGINAL', '').replace(':', '').lower()
ROTATED = os.environ.get('ETS_SIGNER_ROTATED', '').replace(':', '').lower()
_upstream = common.get_first_signer_certificate


def _sha256(der):
    return hashlib.sha256(der).hexdigest()


def get_first_signer_certificate(apkpath):
    if ORIGINAL and ROTATED:
        try:
            apk = common.get_androguard_APK(apkpath, skip_analysis=True)
            v2 = apk.get_certificates_der_v2() or []
            v3 = apk.get_certificates_der_v3() or []
            if (len(v2) == 1 and len(v3) == 1
                    and _sha256(v2[0]) == ORIGINAL and _sha256(v3[0]) == ROTATED):
                logging.info('%s: signed with key rotation (original %s..., rotated to %s...): '
                             'listing the original signer', apkpath, ORIGINAL[:8], ROTATED[:8])
                return v2[0]
        except Exception as e:  # fall back to fdroidserver's own check
            logging.debug('key rotation check failed for %s: %s', apkpath, e)
    return _upstream(apkpath)


common.get_first_signer_certificate = get_first_signer_certificate

if __name__ == '__main__':
    from fdroidserver.__main__ import main
    sys.argv = ['fdroid'] + sys.argv[1:]
    sys.exit(main())
