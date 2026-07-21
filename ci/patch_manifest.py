#!/usr/bin/env python3
"""Ajoute les permissions caméra + notifications au manifeste Android (idempotent)."""
import os
import re

P = 'android/app/src/main/AndroidManifest.xml'

PERMS = [
    '<uses-permission android:name="android.permission.CAMERA" />',
    '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
    '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />',
    '<uses-feature android:name="android.hardware.camera" android:required="false" />',
]

s = open(P).read()
add = [p for p in PERMS if p.split('name="')[1].split('"')[0] not in s]
if add:
    s = s.replace('</manifest>', '\n    ' + '\n    '.join(add) + '\n</manifest>')
    open(P, 'w').write(s)
    print('permissions ajoutées :', len(add))
else:
    print('permissions déjà présentes')

# --- HTTP en clair vers Home Assistant (réseaux locaux seulement) ---
# Ce bloc suit les permissions sans dépendre d'elles : une sortie anticipée
# ci-dessus laisserait le manifeste sans networkSecurityConfig, donc Android
# bloquerait la sauvegarde vers HA (servi en http:// sur le LAN).
xmldir = 'android/app/src/main/res/xml'
os.makedirs(xmldir, exist_ok=True)
open(xmldir + '/network_security_config.xml', 'w').write('''<?xml version="1.0" encoding="utf-8"?>
<!-- HTTP en clair autorisé (Home Assistant est servi en http:// en local). -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true"/>
</network-security-config>
''')

s = open(P).read()
if 'networkSecurityConfig' in s:
    print('networkSecurityConfig déjà présent')
else:
    patched = re.sub(
        r'(<application\b)',
        r'\1\n        android:networkSecurityConfig="@xml/network_security_config"',
        s, count=1)
    # Sans cette vérification, une regex qui ne matche pas passe inaperçue :
    # le build reste vert et l'APK sort sans l'attribut.
    if patched == s:
        raise SystemExit('ERREUR : balise <application> introuvable dans ' + P)
    open(P, 'w').write(patched)
    print('cleartext local autorisé')
