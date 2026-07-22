/**
 * Auto-detect 3 calibration markers on the reference frame.
 *
 * Markers: 20mm-diameter circles with black border, containing a 2×2
 * checkerboard pattern (black/white) inside.
 * Spacing: 50mm center-to-center.
 * Background: white matte plastic frame on black background.
 *
 * Strategy:
 * 1. Downsample to max 1200px (E)
 * 2. CLAHE contrast enhancement (A)
 * 3. Sobel edge detection → gradient magnitude map
 * 4. Circular Hough transform — find dark-ring features with adaptive radii (B)
 * 5. Verify interior checkerboard (2×2 alternating quadrants) — relaxed (C)
 * 6. Find best horizontal triple with equal spacing
 * 7. Score symmetry & alignment quality
 * 8. Fallback: Otsu + BFS contour + circularity + checkerboard (D)
 * 9. Map coordinates back to original image scale
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
  const origW = img.width
  const origH = img.height

  // ---- Downsampling (E) : max 1200px côté long ----
  const MAX_DIM = 1200
  let scale = 1
  let w = origW
  let h = origH
  if (Math.max(origW, origH) > MAX_DIM) {
    scale = MAX_DIM / Math.max(origW, origH)
    w = Math.round(origW * scale)
    h = Math.round(origH * scale)
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data

  // ---- Helpers ----
  function gray(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return 255
    const i = (y * w + x) * 4
    return (data[i] + data[i + 1] + data[i + 2]) / 3
  }

  // Map processed coordinates back to original image scale
  function toOrig(x, y) {
    return { x: Math.round(x / scale), y: Math.round(y / scale) }
  }

  // ---- CLAHE (A) : Contraste local adaptatif ----
  // Tiles 16x16, clip limit 2.0, interpolation bilinéaire
  function applyCLAHE() {
    const tileW = 16
    const tileH = 16
    const tilesX = Math.ceil(w / tileW)
    const tilesY = Math.ceil(h / tileH)
    const clipLimit = 2.0

    // Build LUT for each tile
    const lut = new Array(tilesY)
    for (let ty = 0; ty < tilesY; ty++) {
      lut[ty] = new Array(tilesX)
      for (let tx = 0; tx < tilesX; tx++) {
        // Histogram for this tile
        const hist = new Uint32Array(256)
        const x0 = tx * tileW
        const y0 = ty * tileH
        const x1 = Math.min(x0 + tileW, w)
        const y1 = Math.min(y0 + tileH, h)
        let count = 0
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            hist[gray(x, y)]++
            count++
          }
        }
        // Clip histogram
        const maxCount = count * clipLimit / 256
        let excess = 0
        for (let i = 0; i < 256; i++) {
          if (hist[i] > maxCount) {
            excess += hist[i] - maxCount
            hist[i] = maxCount
          }
        }
        // Redistribute excess
        const inc = Math.floor(excess / 256) + 1
        for (let i = 0; i < 256; i++) {
          const add = Math.min(inc, maxCount - hist[i])
          hist[i] += add
          excess -= add
        }
        // CDF
        const cdf = new Uint16Array(256)
        let sum = 0
        for (let i = 0; i < 256; i++) {
          sum += hist[i]
          cdf[i] = Math.round(255 * sum / count)
        }
        lut[ty][tx] = cdf
      }
    }

    // Apply with bilinear interpolation
    const grayImg = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        grayImg[y * w + x] = gray(x, y)
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = (x - tileW / 2) / tileW
        const ty = (y - tileH / 2) / tileH
        const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(tx)))
        const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(ty)))
        const tx1 = Math.min(tx0 + 1, tilesX - 1)
        const ty1 = Math.min(ty0 + 1, tilesY - 1)
        const fx = tx - tx0
        const fy = ty - ty0

        const v = grayImg[y * w + x]
        const v00 = lut[ty0][tx0][v]
        const v10 = lut[ty0][tx1][v]
        const v01 = lut[ty1][tx0][v]
        const v11 = lut[ty1][tx1][v]

        const v0 = v00 * (1 - fx) + v10 * fx
        const v1 = v01 * (1 - fx) + v11 * fx
        grayImg[y * w + x] = Math.round(v0 * (1 - fy) + v1 * fy)
      }
    }

    // Rewrite data with CLAHE-enhanced gray
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const g = grayImg[y * w + x]
        data[i] = data[i + 1] = data[i + 2] = g
      }
    }
  }

  applyCLAHE()

  // ---- Step 1: Compute gradient magnitude (Sobel) ----
  const grad = new Float32Array(w * h)
  let maxGrad = 0
  const step = 2

  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      const gx =
        -gray(x - 1, y - 1) + gray(x + 1, y - 1)
        - 2 * gray(x - 1, y) + 2 * gray(x + 1, y)
        - gray(x - 1, y + 1) + gray(x + 1, y + 1)
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

  // ---- Step 2: Circular Hough-like accumulation with adaptive radii (B) ----
  const minDim = Math.min(w, h)
  // Primary range: ~1.2% - 6% of min dimension
  let rMin = Math.max(6, Math.round(minDim * 0.012))
  let rMax = Math.min(120, Math.round(minDim * 0.06))
  let rStep = Math.max(2, Math.round((rMax - rMin) / 15))

  const accumScale = 2
  const aw = Math.ceil(w / accumScale)
  const ah = Math.ceil(h / accumScale)

  const candidates = []

  // Helper: run Hough for a given radius range
  function runHough(rMinLocal, rMaxLocal, rStepLocal) {
    for (let r = rMinLocal; r <= rMaxLocal; r += rStepLocal) {
      const accum = new Float32Array(aw * ah)
      const innerR = Math.round(r * 0.55)

      for (let y = r + 2; y < h - r - 2; y += 1) {
        for (let x = r + 2; x < w - r - 2; x += 1) {
          const idx = y * w + x
          if (grad[idx] < edgeThreshold) continue

          const inside = gray(x - r + innerR, y) + gray(x, y - r + innerR) +
                         gray(x + r - innerR, y) + gray(x, y + r - innerR)
          const outside = gray(x - r - 2, y) + gray(x + r + 2, y) +
                          gray(x, y - r - 2) + gray(x, y + r + 2)

          if (inside / 4 < outside / 4) {
            for (let theta = 0; theta < 8; theta++) {
              const angle = (theta / 8) * Math.PI * 2
              const cx = Math.round((x - r * Math.cos(angle)) / accumScale)
              const cy = Math.round((y - r * Math.sin(angle)) / accumScale)
              if (cx >= 0 && cx < aw && cy >= 0 && cy < ah) {
                // Recompute gradient at this pixel for weighting
                const gx = -gray(x - 1, y - 1) + gray(x + 1, y - 1)
                  - 2 * gray(x - 1, y) + 2 * gray(x + 1, y)
                  - gray(x - 1, y + 1) + gray(x + 1, y + 1)
                const gy = -gray(x - 1, y - 1) - 2 * gray(x, y - 1) - gray(x + 1, y - 1)
                  + gray(x - 1, y + 1) + 2 * gray(x, y + 1) + gray(x + 1, y + 1)
                accum[cy * aw + cx] += gradientAngleWeight(gx, gy)
              }
            }
          }
        }
      }

      const threshold = 3
      for (let cy = 2; cy < ah - 2; cy++) {
        for (let cx = 2; cx < aw - 2; cx++) {
          const accVal = accum[cy * aw + cx]
          if (accVal < threshold) continue

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

          const checkerScore = checkCheckerboard(data, w, h, centerX, centerY, innerR)
          const finalScore = accVal * 50 + checkerScore
          if (checkerScore > 10) {
            candidates.push({ x: centerX, y: centerY, score: finalScore, r, innerR, ringScore: accVal, checkerScore })
          }
        }
      }
    }
  }

  // Primary pass
  runHough(rMin, rMax, rStep)

  // Retry with expanded range if too few candidates
  if (candidates.length < 3) {
    const rMin2 = Math.max(4, Math.round(rMin * 0.5))
    const rMax2 = Math.min(160, Math.round(rMax * 1.5))
    const rStep2 = Math.max(2, Math.round((rMax2 - rMin2) / 20))
    console.log(`detectMarkers: retry with expanded radii ${rMin2}-${rMax2}`)
    runHough(rMin2, rMax2, rStep2)
  }

  // Fallback contours (D) if still < 3 candidates after Hough
  if (candidates.length < 3) {
    console.log('detectMarkers: Hough failed, trying contour fallback (D)...')
    const contourPts = detectByContourFallback(data, w, h)
    if (contourPts && contourPts.length >= 3) {
      return contourPts.map(p => toOrig(p.x, p.y))
    }
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

  // Map back to original image coordinates
  return pts.map(p => toOrig(p.x, p.y))
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

  // --- Assoupli (C) : contraste relatif + tolérance 1 quadrant ---
  const vals = [nw, ne, sw, se]
  // Seuils adaptatifs basés sur la médiane locale
  const sorted = [...vals].sort((a, b) => a - b)
  const median = (sorted[1] + sorted[2]) / 2
  const CONTRAST_MIN = 30
  const bright = vals.filter(v => v > median + CONTRAST_MIN).length
  const dark = vals.filter(v => v < median - CONTRAST_MIN).length
  // Tolère 1 quadrant sur 4 dans la zone grise (ombre/reflet)
  if (bright + dark < 3) return 0

  return adjScore * 2 + diagScore + bright * 8 + dark * 8
}

// ============================================================
// FALLBACK CONTOURS (D) — Otsu + BFS + circularité + damier
// ============================================================
function detectByContourFallback(data, w, h) {
  // 1. Seuillage Otsu sur luminance
  const grayData = new Uint8Array(w * h)
  let hist = new Array(256).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const g = (data[i] + data[i + 1] + data[i + 2]) / 3
      grayData[y * w + x] = g
      hist[g]++
    }
  }
  // Otsu threshold
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0, wB = 0, wF = 0, maxVar = 0, thresh = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    wF = w * h - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const varBetween = wB * wF * (mB - mF) * (mB - mF)
    if (varBetween > maxVar) { maxVar = varBetween; thresh = t }
  }

  // 2. Image binaire (noir = mire, blanc = fond)
  const bin = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) bin[i] = grayData[i] < thresh ? 1 : 0

  // 3. Composantes connexes (BFS) + bords
  const visited = new Uint8Array(w * h)
  const components = []
  const minDim = Math.min(w, h)
  const minArea = Math.PI * Math.pow(minDim * 0.004, 2) // ~0.4% minDim
  const maxArea = Math.PI * Math.pow(minDim * 0.07, 2)   // ~7% minDim

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x
      if (bin[idx] !== 1 || visited[idx]) continue

      // BFS flood-fill
      const stack = [idx]
      visited[idx] = 1
      const pixels = []
      let minX = x, maxX = x, minY = y, maxY = y

      while (stack.length) {
        const p = stack.pop()
        const py = Math.floor(p / w), px = p % w
        pixels.push({ x: px, y: py })
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py

        // 4-neighbors
        const nbs = [p - w, p + w, p - 1, p + 1]
        for (const nb of nbs) {
          const ny = Math.floor(nb / w), nx = nb % w
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && bin[nb] === 1 && !visited[nb]) {
            visited[nb] = 1
            stack.push(nb)
          }
        }
      }

      const area = pixels.length
      if (area < minArea || area > maxArea) continue

      // 4. Circularité (4πA / P²) — calcul du périmètre via bord
      let perimeter = 0
      for (const { x, y } of pixels) {
        // Pixel de bord si voisin 4-dir est blanc
        if (bin[(y - 1) * w + x] === 0 ||
            bin[(y + 1) * w + x] === 0 ||
            bin[y * w + (x - 1)] === 0 ||
            bin[y * w + (x + 1)] === 0) {
          perimeter++
        }
      }
      if (perimeter === 0) continue
      const circularity = (4 * Math.PI * area) / (perimeter * perimeter)
      if (circularity < 0.65) continue // cercles purs ~0.85–0.95

      // Centre géométrique
      let cx = 0, cy = 0
      for (const p of pixels) { cx += p.x; cy += p.y }
      cx = Math.round(cx / area)
      cy = Math.round(cy / area)
      const eqRadius = Math.sqrt(area / Math.PI)

      components.push({ x: cx, y: cy, area, perimeter, circularity, eqRadius })
    }
  }

  if (components.length < 3) return null

  // 5. Vérifier damier sur chaque composante (réutilise checkCheckerboard)
  const scored = []
  for (const c of components) {
    const innerR = Math.round(c.eqRadius * 0.55)
    const checkerScore = checkCheckerboard(data, w, h, c.x, c.y, innerR)
    if (checkerScore > 10) {
      scored.push({ ...c, checkerScore, score: checkerScore * 10 })
    }
  }

  if (scored.length < 3) return null

  // 6. Cluster + meilleurs triplets horizontaux (même logique que Hough)
  scored.sort((a, b) => b.score - a.score)
  const clusters = []
  const used = new Set()

  for (let i = 0; i < scored.length; i++) {
    if (used.has(i)) continue
    if (clusters.length >= 15) break
    const cluster = { ...scored[i], members: 1 }
    used.add(i)
    for (let j = i + 1; j < scored.length; j++) {
      if (used.has(j)) continue
      const dx = scored[j].x - scored[i].x
      const dy = scored[j].y - scored[i].y
      if (dx * dx + dy * dy < 600) { // ~24px
        cluster.x += scored[j].x
        cluster.y += scored[j].y
        cluster.score += scored[j].score
        cluster.members++
        used.add(j)
      }
    }
    if (cluster.members > 1) {
      cluster.x = Math.round(cluster.x / cluster.members)
      cluster.y = Math.round(cluster.y / cluster.members)
      clusters.push(cluster)
    } else {
      clusters.push(cluster)
    }
  }

  if (clusters.length < 3) return null

  // 7. Triplets horizontaux
  clusters.sort((a, b) => b.score - a.score)
  const top = clusters.slice(0, 12)
  const sorted = [...top].sort((a, b) => a.x - b.x)

  let bestTriple = null, bestScore = 0
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      for (let k = j + 1; k < sorted.length; k++) {
        const a = sorted[i], b = sorted[j], c = sorted[k]
        const yMean = (a.y + b.y + c.y) / 3
        const yDev = Math.abs(a.y - yMean) + Math.abs(b.y - yMean) + Math.abs(c.y - yMean)
        if (yDev > 40) continue
        if (!(a.x < b.x && b.x < c.x)) continue
        const d1 = b.x - a.x, d2 = c.x - b.x
        if (d1 < 20 || d2 < 20) continue
        const ratio = Math.max(d1, d2) / Math.min(d1, d2)
        if (ratio > 1.8) continue
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

  if (!bestTriple) return null

  console.log(`detectMarkers: contour fallback found ${bestTriple.length} pts`)
  return bestTriple.map(p => ({ x: p.x, y: p.y }))
}