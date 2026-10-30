"""Regenerate the `technichromeV1` preset in Technichrome/Engine/Core/EngineParameters.swift from the
Python engine defaults, so the shipped Swift numbers always equal the prototype's."""
import re, sys
import tcengine as T
from export_fixtures import swift_literal

path = '../../Technichrome/Engine/Core/EngineParameters.swift'
src = open(path).read()
eng = T.Engine(lut_size=5)
p = eng.p
body = swift_literal(eng)
block = f'''    public static let technichromeV1 = EngineParameters(
        exposureEV: {p.exposure_ev},
{body}
        misregistrationAt4K: 0.0,
        bloomAmount: {p.bloom_amount}, bloomThreshold: {p.bloom_threshold}, bloomRadiusPercent: {p.bloom_radius_pct},
        name: "Technichrome v1"
    )
'''
start = src.index('    public static let technichromeV1 = EngineParameters(')
end = src.index('    public static let `default` = technichromeV1')
src = src[:start] + block + '\n' + src[end:]
open(path, 'w').write(src)
print(block)
