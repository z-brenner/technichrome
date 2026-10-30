"""Derive the three-strip separation matrix from the assumed taking-filter sensitivities and print it in
the form used by tcengine.EngineParams.separation_matrix and EngineParameters.swift. Run this after
changing SeparationSensitivities; paste the rounded rows into both places (they are frozen constants so
that the prototype and the app agree exactly on every machine)."""
import numpy as np
import tcengine as T

if __name__ == '__main__':
    sens = T.SeparationSensitivities()
    M, _ = T.derive_separation_matrix(sens, verbose=True)
    M = np.round(M, 4)
    M[:, 2] = 1.0 - M[:, 0] - M[:, 1]   # keep rows summing to exactly 1 after rounding
    print("separation_matrix = (")
    for r in M:
        print(f"    ({r[0]:.4f}, {r[1]:.4f}, {r[2]:.4f}),")
    print(")")
