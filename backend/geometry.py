"""Transformations géométriques pures utilisées par le backend Smart Optica."""

from typing import Iterable, Mapping

import numpy as np


def reproject_points(points: Iterable[Mapping[str, float]], inverse_affine) -> list[dict]:
    """Reprojette des points d'une image transformée vers l'image originale."""
    points = list(points)
    if inverse_affine is None:
        return [dict(point) for point in points]
    matrix = np.asarray(inverse_affine, dtype=np.float64)
    if matrix.shape != (2, 3):
        raise ValueError("La matrice affine inverse doit avoir la forme 2x3")
    restored = []
    for point in points:
        x, y = matrix @ np.array([float(point["x"]), float(point["y"]), 1.0])
        restored.append({"x": float(x), "y": float(y)})
    return restored
