"""
Détection des mires latérales du clip — **VARIANTE ArUco 4×4** (clip v16).

Pourquoi ArUco plutôt que damier
--------------------------------
Un damier n'est qu'un **motif** : il faut le chercher par corrélation, et un
score de damier forme un plateau (centre imprécis). Un marqueur ArUco est un
**code** :

  · il porte un **identifiant** → aucune ambiguïté, pas de faux positif ;
  · ses **4 coins** sont détectés et raffinés en **sub-pixel** → précision bien
    meilleure que le plateau du damier ;
  · il est **invariant en rotation** (90°/180° décodent le même ID).

⚠️ Il est en revanche **chiral** : un marqueur **mirroité ne décode pas**. C'est
pourquoi le clip v16 place les marqueurs par **ROTATION** (`rotate([0, ±90, 0])`)
et jamais par `mirror()` — vérifié : les deux faces décodent les ID 0/1/2.

Identifiants du clip v16
------------------------
    0 = mire proche   ·   1 = mire éloignée   ·   2 = mire surélevée

La paire MÉTROLOGIQUE est (0, 1) : ce sont les 2 mires principales, à 25 mm.

Interface publique identique aux autres variantes :
    detect_lateral_markers(image, landmarker=None, known_scale=None,
                           marker_spacing_mm=None)
        → ([(x1,y1),(x2,y2)], LateralDiagnostics)
"""

import logging
import math
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from lateral import (
    LATERAL_MARKER_SPACING_MM,
    LATERAL_MARKER_SPACING_MM_NEW,
    LateralDiagnostics,
    _derive_spacing_mm,
    _progressive_rois,
    field_width_mm,
    pair_is_plausible,
    spacing_px_bounds,
)

log = logging.getLogger("smart-optica")

# ── Marqueurs du clip v16 ───────────────────────────────────────────────────
ARUCO_DICTIONARY = cv2.aruco.DICT_4X4_50
LATERAL_ARUCO_IDS = (0, 1, 2)          # IDs présents sur le clip
LATERAL_ARUCO_PAIR = (0, 1)            # paire métrologique (25 mm)
LATERAL_ARUCO_MARKER_MM = 7.0          # côté du marqueur imprimé

Point = Tuple[int, int]


def _build_detector():
    """Détecteur ArUco avec raffinement de coins en sub-pixel."""
    dictionary = cv2.aruco.getPredefinedDictionary(ARUCO_DICTIONARY)
    params = cv2.aruco.DetectorParameters()
    # Raffinement des coins : c'est LUI qui donne la précision (vs le damier).
    method = getattr(cv2.aruco, "CORNER_REFINE_SUBPIX", None)
    if method is not None:
        try:
            params.cornerRefinementMethod = method
        except Exception:                                  # pragma: no cover
            log.warning("  [lateral·aruco] raffinement sub-pixel indisponible")
    try:
        params.cornerRefinementWinSize = 5
        params.cornerRefinementMaxIterations = 50
        params.cornerRefinementMinAccuracy = 0.01
    except Exception:                                      # pragma: no cover
        pass
    return cv2.aruco.ArucoDetector(dictionary, params)


_DETECTOR = _build_detector()


def _marker_centers(gray: np.ndarray) -> Dict[int, np.ndarray]:
    """Centres (sub-pixel, float) des marqueurs ArUco du clip, par ID."""
    corners, ids, _ = _DETECTOR.detectMarkers(gray)
    if ids is None or len(ids) == 0:
        return {}
    out: Dict[int, np.ndarray] = {}
    for c, i in zip(corners, ids.ravel()):
        mid = int(i)
        if mid in LATERAL_ARUCO_IDS and mid not in out:
            out[mid] = np.asarray(c, dtype=np.float64).reshape(4, 2).mean(axis=0)
    return out


def _pick_pair(centers: Dict[int, np.ndarray]) -> Tuple[np.ndarray, np.ndarray, str]:
    """Paire de mires : les IDs 0/1 (métrologie) ; sinon les 2 plus proches."""
    a, b = LATERAL_ARUCO_PAIR
    if a in centers and b in centers:
        return centers[a], centers[b], "aruco_4x4"
    keys = list(centers)
    pairs = [(keys[i], keys[j]) for i in range(len(keys)) for j in range(i + 1, len(keys))]
    best = min(pairs, key=lambda kj: float(np.hypot(*(centers[kj[0]] - centers[kj[1]]))))
    return centers[best[0]], centers[best[1]], "aruco_4x4_fallback"


def detect_lateral_markers(image: np.ndarray, landmarker=None,
                           known_scale: Optional[float] = None,
                           marker_spacing_mm: Optional[float] = None,
                           ) -> Tuple[List[Point], LateralDiagnostics]:
    """Détecte les 2 mires latérales du clip v16 (marqueurs ArUco 4×4).

    Les garde-fous de vraisemblance (champ physiquement crédible, espacement
    dérivé de la mesure) sont ceux de `lateral.py` : la métrologie ne change pas.
    """
    diag = LateralDiagnostics()
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image

    rois = _progressive_rois(w, h)
    diag.rois_tried = rois

    if known_scale and known_scale > 0:
        diag.expected_spacing_px = (marker_spacing_mm or LATERAL_MARKER_SPACING_MM) / known_scale
        diag.expected_radius_px = int(LATERAL_ARUCO_MARKER_MM / 2.0 / known_scale)
        log.info(f"  [lateral·aruco] scale={known_scale:.4f}mm/px · marqueur "
                 f"{LATERAL_ARUCO_MARKER_MM:.0f}mm · spacing attendu "
                 f"{diag.expected_spacing_px:.0f}px")
    else:
        log.warning("  [lateral·aruco] ⚠️ SANS échelle frontale — pas de contrainte d'espacement")

    centers = _marker_centers(gray)
    if len(centers) < 2:
        log.info(f"  [lateral·aruco] ❌ moins de 2 marqueurs du clip détectés "
                 f"({sorted(centers)} trouvés)")
        return [], diag

    c0, c1, path = _pick_pair(centers)
    # Distance calculée sur les centres SUB-PIXEL, puis arrondis pour l'API.
    d_px = float(math.hypot(c1[0] - c0[0], c1[1] - c0[1]))
    markers: List[Point] = [(int(round(c0[0])), int(round(c0[1]))),
                            (int(round(c1[0])), int(round(c1[1])))]

    spacing_mm = _derive_spacing_mm(markers, known_scale)
    if not pair_is_plausible(d_px, spacing_mm, w, h):
        lo, hi = spacing_px_bounds((LATERAL_MARKER_SPACING_MM,
                                    LATERAL_MARKER_SPACING_MM_NEW), w, h)
        log.warning(f"  [lateral·aruco] ⛔ Paire REJETÉE : {d_px:.0f}px pour "
                    f"{spacing_mm:.0f}mm → champ de "
                    f"{field_width_mm(d_px, spacing_mm, w, h):.0f}mm "
                    f"(attendu {lo:.0f}-{hi:.0f}px). Ce n'est pas le clip.")
        return [], diag

    diag.path = path
    diag.spacing_mm_detected = spacing_mm
    diag.roi_used = rois[0]
    log.info(f"  [lateral·aruco] ✅ {path} · IDs {sorted(centers)} · "
             f"{spacing_mm:.0f}mm ({d_px:.1f}px) · markers {markers}")
    return markers, diag
