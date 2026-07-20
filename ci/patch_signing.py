#!/usr/bin/env python3
"""Injecte la config de signature release dans android/app/build.gradle (idempotent)."""
import re

P = 'android/app/build.gradle'
s = open(P).read()

if 'signing.p12' in s:
    print('signing déjà configuré')
    raise SystemExit(0)

signing = """    signingConfigs {
        release {
            storeFile file('signing.p12')
            storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            keyAlias 'app'
            keyPassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
            storeType 'PKCS12'
        }
    }
"""

s = s.replace('    buildTypes {', signing + '    buildTypes {', 1)
s = re.sub(r'(buildTypes\s*\{\s*release\s*\{)',
           r'\1\n            signingConfig signingConfigs.release', s, count=1)
open(P, 'w').write(s)
print('signing configuré')
