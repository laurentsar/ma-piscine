#!/usr/bin/env python3
"""Injecte la config de signature release dans android/app/build.gradle (idempotent)."""
import re

P = 'android/app/build.gradle'
s = open(P).read()

if 'piscine.p12' in s:
    print('signing déjà configuré')
    raise SystemExit(0)

signing = """    signingConfigs {
        release {
            storeFile file('piscine.p12')
            storePassword 'piscine'
            keyAlias 'piscine'
            keyPassword 'piscine'
            storeType 'PKCS12'
        }
    }
"""

s = s.replace('    buildTypes {', signing + '    buildTypes {', 1)
s = re.sub(r'(buildTypes\s*\{\s*release\s*\{)',
           r'\1\n            signingConfig signingConfigs.release', s, count=1)
open(P, 'w').write(s)
print('signing configuré')
