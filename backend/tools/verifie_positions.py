"""Les positions rendues sont-elles bien SUR les damiers ? On les dessine.

Usage :  venv/bin/python tools/verifie_positions.py photo_face.jpg

Nécessaire : les écartements peuvent être justes même si TOUTES les mires sont
décalées du même montant (un décalage uniforme les préserve). Or c'est la position
absolue qui décide si les 4 quadrants sont lus au bon endroit — donc si l'orientation
de prise de vue peut être déduite de la signature du damier.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402

import main  # noqa: E402

img = cv2.imread(sys.argv[1] if len(sys.argv) > 1 else "/tmp/IMG_1061.jpg")
h, w = img.shape[:2]
rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
mp_img = main.mp.Image(image_format=main.mp.ImageFormat.SRGB, data=rgb)
lm = main.landmarker.detect(mp_img).face_landmarks[0]
brow_y = min(lm[105].y, lm[334].y)
x0 = max(0, int(lm[234].x * w))
x1 = min(w, int(lm[454].x * w))
marge = int(0.05 * max(1, x1 - x0))
x0, x1 = max(0, x0 - marge), min(w, x1 + marge)
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
r = main.detect_facial_quadruplet(gray, int(brow_y * h), x0, x1, None)

vis = img.copy()
for i, m in enumerate(r["markers"]):
    cx, cy = int(m["x"]), int(m["y"])
    cv2.circle(vis, (cx, cy), 58, (0, 0, 255), 7)
    cv2.putText(vis, str(i), (cx - 20, cy - 72), cv2.FONT_HERSHEY_SIMPLEX,
                3.0, (0, 0, 255), 8)

ys = [int(m["y"]) for m in r["markers"]]
xs = [int(m["x"]) for m in r["markers"]]
xa, xb = max(0, min(xs) - 120), min(w, max(xs) + 120)
ya, yb = max(0, min(ys) - 170), min(h, max(ys) + 130)
cv2.imwrite("/tmp/verif_positions.jpg", vis[ya:yb, xa:xb])
print("marqueurs :", list(zip(xs, ys)))
print("orientation:", r["orientation_prise_de_vue"], "| miroir:", r["image_mirrored"])
print("zoom      : /tmp/verif_positions.jpg")
