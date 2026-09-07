import unittest
import cv2
import numpy as np

from geometry import reproject_points


class ReprojectPointsTest(unittest.TestCase):
    def test_recovers_original_points_after_image_rotation(self):
        center = (320.0, 240.0)
        forward = cv2.getRotationMatrix2D(center, 12.0, 1.0)
        inverse = cv2.invertAffineTransform(forward)
        original = np.array([[100.0, 150.0], [320.0, 120.0], [540.0, 150.0]])
        homogeneous = np.c_[original, np.ones(len(original))]
        rotated = homogeneous @ forward.T

        restored = reproject_points(
            [{"x": float(x), "y": float(y)} for x, y in rotated],
            inverse,
        )

        for actual, expected in zip(restored, original):
            self.assertAlmostEqual(actual["x"], expected[0], places=5)
            self.assertAlmostEqual(actual["y"], expected[1], places=5)

    def test_leaves_points_unchanged_without_transform(self):
        points = [{"x": 10, "y": 20}]
        self.assertEqual(reproject_points(points, None), points)


if __name__ == "__main__":
    unittest.main()
