#!/usr/bin/env python3
"""Aligne versionName / versionCode (android/app/build.gradle) et APP_VERSION
(www/app.js) sur www/version.json, seule source de vérité."""
import json, re

meta = json.load(open('www/version.json'))
ver = meta['version']
# versionCode = major*10000 + minor*100 + patch (monotone tant que minor/patch < 100)
parts = [int(x) for x in (ver.split('.') + ['0', '0'])[:3]]
code = parts[0] * 10000 + parts[1] * 100 + parts[2]

P = 'android/app/build.gradle'
s = open(P).read()
s = re.sub(r'versionName\s+"[^"]*"', 'versionName "%s"' % ver, s, count=1)
s = re.sub(r'versionCode\s+\d+', 'versionCode %d' % code, s, count=1)
open(P, 'w').write(s)
print('versionName ->', ver, '| versionCode ->', code)

# APP_VERSION alimente le bandeau « v… » et surtout la comparaison de
# update-check.js : s'il reste en retard, l'app se croit périmée et propose
# indéfiniment une mise à jour déjà installée.
A = 'www/app.js'
a = open(A).read()
patched, n = re.subn(r"(var APP_VERSION\s*=\s*)'[^']*'", r"\1'%s'" % ver, a, count=1)
if not n:
    raise SystemExit("ERREUR : APP_VERSION introuvable dans " + A)
open(A, 'w').write(patched)
print('APP_VERSION ->', ver)
