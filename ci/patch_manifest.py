#!/usr/bin/env python3
"""Ajoute les permissions caméra + notifications au manifeste Android (idempotent)."""
P = 'android/app/src/main/AndroidManifest.xml'
s = open(P).read()

PERMS = [
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />',
]
add = [p for p in PERMS if p.split('name="')[1].split('"')[0] not in s]
if not add:
    print('permissions déjà présentes')
    raise SystemExit(0)

s = s.replace('</manifest>', '\n    ' + '\n    '.join(add) + '\n</manifest>')
open(P, 'w').write(s)
print('permissions ajoutées :', len(add))
