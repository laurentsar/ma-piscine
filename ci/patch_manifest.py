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

# --- HTTP en clair vers Home Assistant (réseaux locaux seulement) ---
import os as _os
_xmldir = 'android/app/src/main/res/xml'
_os.makedirs(_xmldir, exist_ok=True)
open(_xmldir + '/network_security_config.xml', 'w').write('''<?xml version="1.0" encoding="utf-8"?>
<!-- HTTP en clair autorisé (Home Assistant est servi en http:// en local). -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true"/>
</network-security-config>
''')
_mf = 'android/app/src/main/AndroidManifest.xml'
_s = open(_mf).read()
if 'networkSecurityConfig' not in _s:
    import re as _re
    _s = _re.sub(r'(<application\\b)', r'\\1\\n        android:networkSecurityConfig="@xml/network_security_config"', _s, count=1)
    open(_mf, 'w').write(_s)
    print('cleartext local autorisé')
