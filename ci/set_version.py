#!/usr/bin/env python3
"""Aligne versionName / versionCode (android/app/build.gradle) sur www/version.json."""
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
