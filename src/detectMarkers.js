/**
 * Auto-detect 3 calibration markers on the reference frame.
 *
 * Markers: 20mm-diameter circles with black border, containing a 2×2
 * checkerboard pattern (black/white) inside.
 * Spacing: 50mm center-to-center.
 * Background: white matte plastic frame on black background.
 *
 * Strategy:
 * 1. Sobel edge detection → gradient magnitude map
 * 2. Circular Hough transform — find dark-ring features
 * 3. Verify interior checkerboard (2×2 alternating quadrants)
 * 4. Find best horizontal triple with equal spacing
 * 5. Score symmetry & alignment quality
 */

export async function detectCalibrationMarkers(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const result = detectOnCanvas(img)
        resolve(result)
      } catch (e) {
        console.warn('Auto-detect error:', e)
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = imageUrl
  })
}

function detectOnCanvas(img) {
  const w = img.width
  const h = img.height

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data

  // ---- Helpers ----
  function gray(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return 255
    const i = (y * w + x) * 4
    return (data[i] + data[i + 1] + data[i + 2]) / 3
  }

  // ---- Step 1: Compute gradient magnitude (Sobel) ----
  // We compute on a decimated grid for performance
  const grad = new Float32Array(w * h)
  let maxGrad = 0
  const step = 2 // finer step for edge detection

  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      // Sobel X
      const gx =
        -gray(x - 1, y - 1) + gray(x + 1, y - 1)
        - 2 * gray(x - 1, y) + 2 * gray(x + 1, y)
        - gray(x - 1, y + 1) + gray(x + 1, y + 1)
      // Sobel Y
      const gy =
        -gray(x - 1, y - 1) - 2 * gray(x, y - 1) - gray(x + 1, y - 1)
        + gray(x - 1, y + 1) + 2 * gray(x, y + 1) + gray(x + 1, y + 1)

      const mag = Math.sqrt(gx * gx + gy * gy)
      const idx = y * w + x
      grad[idx] = mag
      if (mag > maxGrad) maxGrad = mag
    }
  }

  const edgeThreshold = maxGrad * 0.25

  // ---- Step 2: Circular Hough-like accumulation ----
  // Estimate marker radius range based on image dimensions
  // Markers are ~20mm. For a typical face photo (head ~65% of image),
  // the marker radius is roughly 2-3% of image width.
  const rMin = Math.max(5, Math.round(w * 0.015))
  const rMax = Math.min(80, Math.round(w * 0.05))
  const rStep = Math.max(2, Math.round((rMax - rMin) / 15))

  const accumScale = 2 // accumulate at 1/2 resolution for speed
  const aw = Math.ceil(w / accumScale)
  const ah = Math.ceil(h / accumScale)

  // Accumulator: for each radius candidate, a 2D array
  // We store (score, angleVotes) for each position
  const candidates = []

  // For each radius, accumulate edge votes
  for (let r = rMin; r <= rMax; r += rStep) {
    const accum = new Float32Array(aw * ah)
    const innerR = Math.round(r * 0.55)

    // For each edge pixel, vote for circle centers at distance r
    for (let y = r + 2; y < h - r - 2; y += 1) {
      for (let x = r + 2; x < w - r - 2; x += 1) {
        const idx = y * w + x
        if (grad[idx] < edgeThreshold) continue

        // Edge gradient direction (roughly toward center of dark circle)
        // For a dark ring on lighter background, gradient points outward
        // So circle center is opposite to gradient direction
        // We approximate by sampling in 8 directions from this edge pixel

        // Check if pixel is on a dark-bright edge; look for ring patterns
        // Simplified: check if inside is darker and outside is lighter
        const inside = gray(x - r + innerR, y) + gray(x, y - r + innerR) +
                       gray(x + r - innerR, y) + gray(x, y + r - innerR)
        const outside = gray(x - r - 2, y) + gray(x + r + 2, y) +
                        gray(x, y - r - 2) + gray(x, y + r + 2)

        if (inside / 4 < outside / 4) {
          // Gradient dark→light, this is ON the ring
          // Vote in all plausible center directions
          for (let theta = 0; theta < 8; theta++) {
            const angle = (theta / 8) * Math.PI * 2
            const cx = Math.round((x - r * Math.cos(angle)) / accumScale)
            const cy = Math.round((y - r * Math.sin(angle)) / accumScale)
            if (cx >= 0 && cx < aw && cy >= 0 && cy < ah) {
              accum[cy * aw + cx] += gradientAngleWeight(gx, gy)
            }
          }
        }
      }
    }

    // ---- Find local maxima in accumulator ----
    const threshold = 3 // minimum votes
    for (let cy = 2; cy < ah - 2; cy++) {
      for (let cx = 2; cx < aw - 2; cx++) {
        const accVal = accum[cy * aw + cx]
        if (accVal < threshold) continue

        // Local max check (3x3)
        let isMax = true
        for (let dy = -1; dy <= 1 && isMax; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            if (accum[(cy + dy) * aw + (cx + dx)] >= accVal) {
              isMax = false; break
            }
          }
        }
        if (!isMax) continue

        const centerX = cx * accumScale
        const centerY = cy * accumScale

        // ---- Verify interior checkerboard ----
        const checkerScore = checkCheckerboard(data, w, h, centerX, centerY, innerR)

        const finalScore = accVal * 50 + checkerScore
        if (checkerScore > 10) {
          candidates.push({ x: centerX, y: centerY, score: finalScore, r, innerR, ringScore: accVal, checkerScore })
        }
      }
    }
  }

  if (candidates.length < 3) {
    console.log(`detectMarkers v2: only ${candidates.length} candidates`)
    return null
  }

  // ---- Step 3: Non-maximum suppression (merge nearby) ----
  candidates.sort((a, b) => b.score - a.score)
  const clusters = []
  const used = new Set()

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(i)) continue
    if (clusters.length >= 20) break
    const c = { x: candidates[i].x, y: candidates[i].y, score: candidates[i].score, r: candidates[i].r, members: 1 }
    used.add(i)

    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(j)) continue
      const dx = candidates[j].x - candidates[i].x
      const dy = candidates[j].y - candidates[i].y
      if (dx * dx + dy * dy < 600) { // ~24px radius
        c.x += candidates[j].x
        c.y += candidates[j].y
        c.score += candidates[j].score
        c.members++
        used.add(j)
      }
    }

    if (c.members > 1) {
      c.x = Math.round(c.x / c.members)
      c.y = Math.round(c.y / c.members)
      clusters.push(c)
    }
  }

  if (clusters.length < 3) {
    console.log(`detectMarkers v2: ${clusters.length} clusters`)
    return null
  }

  // ---- Step 4: Find best horizontal triple ----
  clusters.sort((a, b) => b.score - a.score)
  const top = clusters.slice(0, 15)
  const sorted = [...top].sort((a, b) => a.x - b.x)

  let bestTriple = null
  let bestScore = 0

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      for (let k = j + 1; k < sorted.length; k++) {
        const a = sorted[i], b = sorted[j], c = sorted[k]

        // Vertical alignment (should be roughly same row)
        const yMean = (a.y + b.y + c.y) / 3
        const yDev = Math.abs(a.y - yMean) + Math.abs(b.y - yMean) + Math.abs(c.y - yMean)
        if (yDev > 40) continue

        // Horizontal: left < center < right
        if (!(a.x < b.x && b.x < c.x)) continue

        // Spacing roughly equal
        const d1 = b.x - a.x
        const d2 = c.x - b.x
        if (d1 < 20 || d2 < 20) continue

        const ratio = Math.max(d1, d2) / Math.min(d1, d2)
        if (ratio > 1.8) continue

        // Score: marker quality + spacing uniformity + y alignment
        const spacingScore = 100 * Math.min(d1, d2) / Math.max(d1, d2)
        const yScore = Math.max(0, 40 - yDev) * 2
        const composite = a.score + b.score + c.score + spacingScore * 3 + yScore

        if (composite > bestScore) {
          bestScore = composite
          bestTriple = [a, b, c].sort((p, q) => p.x - q.x)
        }
      }
    }
  }

  if (!bestTriple) {
    console.log('detectMarkers v2: no valid triple')
    return null
  }

  const pts = bestTriple
  const sp1 = pts[1].x - pts[0].x
  const sp2 = pts[2].x - pts[1].x
  const consistency = Math.abs(sp1 - sp2) / Math.max(sp1, sp2)
  console.log(`detectMarkers v2: Found @ (${pts.map(p => `${p.x},${p.y}`).join(') (')})  spacing=${sp1},${sp2}  consistency=${(consistency*100).toFixed(0)}%`)

  return pts.map(p => ({ x: p.x, y: p.y }))
}

function gradientAngleWeight(gx, gy) {
  // Higher weight for well-defined gradients
  return Math.min(3, Math.sqrt(gx * gx + gy * gy) / 20)
}

function checkCheckerboard(data, w, h, cx, cy, innerR) {
  // Divide the inner area into 4 quadrants
  const half = innerR * 0.45

  function avgQuadrant(dx, dy) {
    let sum = 0, count = 0
    const sx = Math.round(cx + dx * half)
    const sy = Math.round(cy + dy * half)
    for (let oy = -3; oy <= 3; oy += 2) {
      for (let ox = -3; ox <= 3; ox += 2) {
        const px = sx + ox, py = sy + oy
        if (px < 0 || px >= w || py < 0 || py >= h) { count++; continue }
        const i = (py * w + px) * 4
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3
        count++
      }
    }
    return sum / count
  }

  const nw = avgQuadrant(-1, -1)
  const ne = avgQuadrant(1, -1)
  const sw = avgQuadrant(-1, 1)
  const se = avgQuadrant(1, 1)

  // Checkerboard: should alternate (NW≠NE, NW≠SW, SE≠NE, SE≠SW)
  // i.e., diagonals should be similar, adjacents should differ
  const diffDiag1 = Math.abs(nw - se)
  const diffDiag2 = Math.abs(ne - sw)
  const diffAdj1 = Math.abs(nw - ne)
  const diffAdj2 = Math.abs(nw - sw)
  const diffAdj3 = Math.abs(se - ne)
  const diffAdj4 = Math.abs(se - sw)

  // Expect: diagonals similar (small diff), adjacents differ (large diff)
  const diagScore = Math.min(diffDiag1, diffDiag2)
  const adjScore = (diffAdj1 + diffAdj2 + diffAdj3 + diffAdj4) / 4

  // Count bright and dark quadrants
  const vals = [nw, ne, sw, se]
  const bright = vals.filter(v => v > 150).length
  const dark = vals.filter(v => v < 100).length

  if (bright < 1 || dark < 1) return 0

  return adjScore * 2 + diagScore + bright * 8 + dark * 8
}
