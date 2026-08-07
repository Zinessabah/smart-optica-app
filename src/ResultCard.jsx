import { RotateCcw, FileText, CheckCircle2, AlertTriangle, AlertCircle, UserRound, Ruler } from 'lucide-react'

export default function ResultCard({ measurements, imageUrl, profileImageUrl, onRetake }) {
  // --- Validation des mesures ---
  const validation = (() => {
    const issues = []
    const pd = measurements.pd
    const pdOG = measurements.pdMonoculaireGauche
    const pdOD = measurements.pdMonoculaireDroit
    const pont = measurements.pont

    // DP binoculaire : normale entre 50mm et 75mm (adulte)
    if (pd != null) {
      if (pd < 50) issues.push('DP binoculaire anormalement basse (< 50mm)')
      else if (pd > 75) issues.push('DP binoculaire anormalement haute (> 75mm)')
    }

    // DP monoculaires : somme ≈ DP binoculaire
    if (pdOG != null && pdOD != null && pd != null) {
      const sum = pdOG + pdOD
      const diff = Math.abs(sum - pd)
      if (diff > 3) issues.push(`Somme des monoculaires (${sum}mm) incohérente avec la DP (${pd}mm)`)
    }

    // Pont : valeurs réalistes (10-30mm)
    if (pont != null && (pont < 5 || pont > 40)) {
      issues.push('Écart inter-verres (pont) hors norme')
    }

    return {
      valid: issues.length === 0,
      issues,
      level: issues.length === 0 ? 'ok' : issues.some(i => i.includes('incohérente')) ? 'warning' : 'error',
    }
  })()
  const getConfianceColor = (level) => {
    switch (level) {
      case 'haute': return '#15803d'
      case 'moyenne': return '#b45309'
      case 'faible': return '#dc2626'
      default: return '#9ca3af'
    }
  }

  const getConfianceLabel = (level) => {
    switch (level) {
      case 'haute': return 'Précision clinique ✓'
      case 'moyenne': return 'Bonne précision'
      case 'faible': return 'Estimation — à vérifier'
      default: return level
    }
  }

  const getMethodeLabel = (methode) => {
    switch (methode) {
      case 'calibration_monture_reference': return 'Calibration par monture de référence'
      case 'marquage_manuel': return 'Marquage manuel'
      default: return methode
    }
  }

  const handleSavePDF = async () => {
    const el = document.getElementById('result-card-content')
    if (!el) return

    try {
      const { default: html2canvas } = await import('html2canvas')
      const { jsPDF } = await import('jspdf')

      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageW = 210
      const pageH = 297
      const margin = 12

      // Page unique : photo client réduite en haut + carte des mesures en dessous
      // On capture d'abord la carte des mesures (fond clair)
      const measureCanvas = await html2canvas(el, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
      })

      const measureImgData = measureCanvas.toDataURL('image/png')
      const measureAspect = measureCanvas.width / measureCanvas.height

      // Calculer l'espace disponible
      let measureW = pageW - margin * 2
      let measureH = measureW / measureAspect

      // Helper : charger et orienter une image pour le PDF
      const loadPhoto = async (url) => {
        const img = new Image()
        img.src = url
        await new Promise(r => { img.onload = r })
        const orientCanvas = document.createElement('canvas')
        const ctx = orientCanvas.getContext('2d')
        if (img.width > img.height) {
          orientCanvas.width = img.height
          orientCanvas.height = img.width
          ctx.translate(orientCanvas.width / 2, orientCanvas.height / 2)
          ctx.rotate(-Math.PI / 2)
          ctx.drawImage(img, -img.width / 2, -img.height / 2)
        } else {
          orientCanvas.width = img.width
          orientCanvas.height = img.height
          ctx.drawImage(img, 0, 0)
        }
        return orientCanvas.toDataURL('image/jpeg', 0.9)
      }

      // Photos en haut
      const photoUrls = []
      if (imageUrl) photoUrls.push({ url: imageUrl, label: 'Face' })
      if (profileImageUrl) photoUrls.push({ url: profileImageUrl, label: 'Profil D' })

      if (photoUrls.length > 0) {
        const photoMaxH = (pageH - margin * 2) * 0.25
        const photoMaxW = (pageW - margin * 2) / photoUrls.length - 4 // réparti sur la largeur

        const orientedDataUrls = await Promise.all(photoUrls.map(p => loadPhoto(p.url)))

        for (let i = 0; i < orientedDataUrls.length; i++) {
          const imgObj = new Image()
          imgObj.src = orientedDataUrls[i]
          await new Promise(r => { imgObj.onload = r })
          const aspect = imgObj.width / imgObj.height
          let pw = photoMaxW
          let ph = pw / aspect
          if (ph > photoMaxH) {
            ph = photoMaxH
            pw = ph * aspect
          }
          const px = margin + (photoUrls.length === 1
            ? (pageW - pw) / 2 - margin
            : i * ((pageW - margin * 2) / photoUrls.length) + ((pageW - margin * 2) / photoUrls.length - pw) / 2)
          pdf.addImage(orientedDataUrls[i], 'JPEG', px, margin, pw, ph)

          // Label sous la photo
          pdf.setFontSize(6)
          pdf.setTextColor(100, 100, 100)
          pdf.text(photoUrls[i].label, px + pw / 2, margin + ph + 2, { align: 'center' })
        }

        // Espace restant pour les mesures
        const photoSectionH = photoMaxH + 6
        const remainingH = pageH - margin - photoSectionH - margin
        measureH = Math.min(measureH, remainingH)
        if (measureH < 50) measureH = 50

        const measureY = margin + photoSectionH + 2
        pdf.addImage(measureImgData, 'PNG', (pageW - measureW) / 2, measureY, measureW, measureH)
      } else {
        // Sans photo, les mesures prennent toute la page
        if (measureH > pageH - margin * 2) {
          measureH = pageH - margin * 2
          measureW = measureH * measureAspect
        }
        pdf.addImage(measureImgData, 'PNG', (pageW - measureW) / 2, margin, measureW, measureH)
      }

      const dateStr = new Date().toISOString().slice(0, 10)
      pdf.save(`SmartOptica_DP_${dateStr}.pdf`)
    } catch (err) {
      console.error('PDF generation error:', err)
      // Fallback : téléchargement HTML
      fallbackHtmlExport()
    }
  }

  const fallbackHtmlExport = () => {
    // Génération HTML pour impression/export
    const date = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const heure = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Smart Optica — Mesure DP</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #ffffff; color: #1f2937; padding: 20px; max-width: 600px; margin: auto; }
  .card { background: #f9fafb; border-radius: 16px; padding: 24px; border: 1px solid #e5e7eb; margin-bottom: 16px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-icon { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #c9a05a, #a8863a); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; color: #ffffff; }
  .brand-text { font-family: 'Playfair Display', Georgia, serif; font-size: 18px; font-weight: 600; }
  .brand-text span { display: block; font-size: 10px; color: #b45309; text-transform: uppercase; letter-spacing: 1px; font-family: 'Inter', sans-serif; }
  .photo { width: 100%; border-radius: 12px; margin-bottom: 16px; aspect-ratio: 4/3; object-fit: cover; }
  .dp-main { text-align: center; padding: 20px; background: #f3f4f6; border-radius: 12px; margin-bottom: 16px; border: 1px solid #e5e7eb; }
  .dp-main .value { font-size: 56px; font-weight: 700; letter-spacing: -1px; color: #111827; }
  .dp-main .unit { font-size: 20px; color: #9ca3af; margin-left: 2px; }
  .dp-main .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .dp-main .conf { font-size: 10px; color: #15803d; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .grid .box { text-align: center; padding: 14px; background: #f3f4f6; border-radius: 10px; border: 1px solid #e5e7eb; }
  .grid .box .val { font-size: 28px; font-weight: 600; color: #111827; }
  .grid .box .lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; }
  .meta { display: flex; gap: 16px; font-size: 11px; color: #6b7280; padding: 12px; background: #f9fafb; border-radius: 10px; }
  .meta strong { color: #1f2937; }
  .footer { text-align: center; font-size: 10px; color: #9ca3af; padding: 12px; }
  .section-title { font-size: 11px; color: #7c3aed; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .dim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 14px; }
  .dim-item { display: flex; justify-content: space-between; padding: 6px 10px; background: #ffffff; border-radius: 6px; font-size: 11px; }
  .dim-item .lbl { color: #6b7280; }
  .dim-item .val { color: #7c3aed; font-weight: 600; }
  .dim-item .val.green { color: #15803d; }
  @media print { body { background: #fff; } }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="brand-icon">SO</div>
      <div class="brand-text">Smart Optica<span>Centrage Digital</span></div>
    </div>
  </div>

  ${imageUrl || profileImageUrl ? (() => {
    let photosHtml = ''
    if (imageUrl && profileImageUrl) {
      photosHtml = `<div style="display:flex;gap:8px;margin-bottom:16px">
        <img class="photo" src="${imageUrl}" alt="Photo face" style="flex:1" />
        <img class="photo" src="${profileImageUrl}" alt="Photo profil" style="flex:1" />
      </div>`
    } else if (imageUrl) {
      photosHtml = `<img class="photo" src="${imageUrl}" alt="Photo face" />`
    } else if (profileImageUrl) {
      photosHtml = `<img class="photo" src="${profileImageUrl}" alt="Photo profil" />`
    }
    return photosHtml
  })() : ''}

  <div class="card">
    <div class="dp-main">
      <div class="label">Distance Pupillaire Binoculaire</div>
      <div class="value">${measurements.pd}<span class="unit">mm</span></div>
      <div class="conf">Précision clinique ✓</div>
      <div style="font-size:10px;color:#555;margin-top:4px">${date} · ${heure}</div>
    </div>

    <div class="grid">
      <div class="box">
        <div class="val">${measurements.pdMonoculaireGauche}<span style="font-size:14px;color:#555">mm</span></div>
        <div class="lbl">Œil Gauche (OG)${measurements.pontPlace ? ' · Pont → OG' : ''}</div>
      </div>
      <div class="box">
        <div class="val">${measurements.pdMonoculaireDroit}<span style="font-size:14px;color:#555">mm</span></div>
        <div class="lbl">Œil Droit (OD)${measurements.pontPlace ? ' · Pont → OD' : ''}</div>
      </div>
    </div>

    ${measurements.frameOk ? `
    <div class="section-title">📐 Dimensions calibre (boxing)</div>
    <div class="dim-grid">
      <div class="dim-item"><span class="lbl">H. Calibre</span><span class="val">${measurements.hauteurCalibre} mm</span></div>
      <div class="dim-item"><span class="lbl">L. Calibre OD/OG</span><span class="val">${measurements.largeurOD ?? '—'} / ${measurements.largeurOG ?? '—'} mm</span></div>
      <div class="dim-item"><span class="lbl">H. Montage OD</span><span class="val">${measurements.hauteurMontageOG ?? '—'} mm</span></div>
      <div class="dim-item"><span class="lbl">H. Montage OG</span><span class="val">${measurements.hauteurMontageOD ?? '—'} mm</span></div>
    </div>` : ''}

    ${measurements.pont != null ? `
    <div style="text-align:center;padding:10px;background:#f0fdf4;border-radius:10px;margin-bottom:14px;border:1px solid #bbf7d0">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase">Écart inter-verres (Pont)</div>
      <div style="font-size:22px;font-weight:600;color:#15803d">${measurements.pont} mm</div>
    </div>` : ''}

    ${measurements.pantoscopicAngle != null ? `
    <div style="text-align:center;padding:10px;background:#faf5ff;border-radius:10px;margin-bottom:14px;border:1px solid #e9d5ff">
      <div style="display:flex;gap:16px;justify-content:center">
        <div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase">Angle pantoscopique</div>
          <div style="font-size:20px;font-weight:600;color:#7c3aed">${measurements.pantoscopicAngle}°</div>
        </div>
        ${measurements.vertexDistance != null ? `
        <div>
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase">Distance Vertex (D'L)</div>
          <div style="font-size:20px;font-weight:600;color:#7c3aed">${measurements.vertexDistance} mm</div>
        </div>` : ''}
      </div>
    </div>` : ''}

    <div class="meta">
      <div><strong>Méthode :</strong> ${getMethodeLabel(measurements.methode)}</div>
      <div style="color:${getConfianceColor(measurements.confiance)}">
        ● ${getConfianceLabel(measurements.confiance)}
      </div>
    </div>
  </div>

  <div class="footer">Smart Optica © 2026 · Mesure DP de précision · Document généré automatiquement</div>
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SmartOptica_DP_${new Date().toISOString().slice(0, 10)}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Photos preview — face + profil */}
      {(imageUrl || profileImageUrl) && (
        <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
          <div className={`grid ${imageUrl && profileImageUrl ? 'grid-cols-2' : 'grid-cols-1'} gap-0`}>
            {imageUrl && (
              <div>
                <img src={imageUrl} alt="Photo face" className="w-full aspect-[3/4] object-cover" />
                <div className="text-[9px] text-center py-1" style={{ color: 'var(--color-text-dim)', background: 'var(--color-bg)' }}>📸 Face</div>
              </div>
            )}
            {profileImageUrl && (
              <div>
                <img src={profileImageUrl} alt="Photo profil" className="w-full aspect-[3/4] object-cover" />
                <div className="text-[9px] text-center py-1" style={{ color: 'var(--color-text-dim)', background: 'var(--color-bg)' }}>📸 Profil D</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Results card — fond clair pour impression/PDF */}
      <div id="result-card-content" className="rounded-2xl p-6 border" style={{ background: '#ffffff', borderColor: '#d1d5db' }}>
        <h3 className="text-xs uppercase tracking-wider mb-1 flex items-center gap-2" style={{ color: '#b45309' }}>
          <CheckCircle2 size={14} />
          Résultat de la mesure
        </h3>
        <div className="text-[10px] mb-4" style={{ color: '#9ca3af' }}>
          Smart Optica · {new Date().toLocaleDateString('fr-FR')}
        </div>

        {/* Validation banner */}
        {!validation.valid && (
          <div className="rounded-xl px-4 py-3 mb-4 flex items-start gap-2 text-xs border"
            style={{
              background: validation.level === 'error' ? '#fef2f2' : '#fffbeb',
              borderColor: validation.level === 'error' ? '#f87171' : '#fbbf24',
              color: validation.level === 'error' ? '#dc2626' : '#b45309',
            }}>
            {validation.level === 'error' ? <AlertCircle size={14} className="shrink-0 mt-0.5" /> : <AlertTriangle size={14} className="shrink-0 mt-0.5" />}
            <div className="space-y-0.5">
              <span className="font-medium">Mesure suspecte</span>
              {validation.issues.map((msg, i) => (
                <div key={i} className="opacity-80">{msg}</div>
              ))}
            </div>
          </div>
        )}

        {/* ══ SECTION 1 : DONNÉES CLIENT ══ */}
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wide font-bold mb-2 pb-1 border-b flex items-center gap-1.5" style={{ color: '#7c3aed', borderColor: '#e5e7eb' }}>
            <UserRound size={12} /> Données client
          </div>

          {/* Main PD */}
          <div className="text-center py-4 mb-3 rounded-xl" style={{ background: '#f9fafb', border: '1px solid #e5e7eb' }}>
            <div className="text-xs mb-1" style={{ color: '#6b7280' }}>Distance Pupillaire Binoculaire</div>
            <div className="text-5xl font-bold tracking-tight" style={{ color: '#111827' }}>
              {measurements.pd}
              <span className="text-xl ml-1" style={{ color: '#9ca3af' }}>mm</span>
            </div>
            <div className="text-[10px] mt-1" style={{ color: getConfianceColor(measurements.confiance) }}>
              {getConfianceLabel(measurements.confiance)}
            </div>
          </div>

          {/* Monocular */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="text-center py-3 rounded-xl" style={{ background: '#f9fafb', border: '1px solid #e5e7eb' }}>
              <div className="text-xs mb-1" style={{ color: '#6b7280' }}>Œil Gauche (OG)</div>
              <div className="text-2xl font-semibold" style={{ color: '#b45309' }}>
                {measurements.pdMonoculaireGauche}
                <span className="text-sm ml-1" style={{ color: '#9ca3af' }}>mm</span>
              </div>
              {measurements.pontPlace && (
                <div className="text-[9px] mt-0.5" style={{ color: '#15803d' }}>Pont → OG</div>
              )}
            </div>
            <div className="text-center py-3 rounded-xl" style={{ background: '#f9fafb', border: '1px solid #e5e7eb' }}>
              <div className="text-xs mb-1" style={{ color: '#6b7280' }}>Œil Droit (OD)</div>
              <div className="text-2xl font-semibold" style={{ color: '#1d4ed8' }}>
                {measurements.pdMonoculaireDroit}
                <span className="text-sm ml-1" style={{ color: '#9ca3af' }}>mm</span>
              </div>
              {measurements.pontPlace && (
                <div className="text-[9px] mt-0.5" style={{ color: '#15803d' }}>Pont → OD</div>
              )}
            </div>
          </div>

          {/* Vertex (client) */}
          {measurements.vertexDistance != null && (
            <div className="flex justify-between items-center px-4 py-2.5 rounded-xl text-xs mb-2" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <span style={{ color: '#4b5563' }}>Distance Vertex (D'L)</span>
              <span className="font-semibold" style={{ color: '#15803d' }}>{measurements.vertexDistance} mm</span>
            </div>
          )}
        </div>

        {/* ══ SECTION 2 : DONNÉES MONTURE ══ */}
        <div>
          <div className="text-[10px] uppercase tracking-wide font-bold mb-2 pb-1 border-b flex items-center gap-1.5" style={{ color: '#7c3aed', borderColor: '#e5e7eb' }}>
            <Ruler size={12} /> Données monture
          </div>

          {/* Bridge */}
          {measurements.pont != null && (
            <div className="flex justify-between items-center px-4 py-2.5 rounded-xl text-xs mb-2" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <span style={{ color: '#4b5563' }}>Écart inter-verres (Pont)</span>
              <span className="font-semibold" style={{ color: '#15803d' }}>{measurements.pont} mm</span>
            </div>
          )}

          {/* Boxing dimensions */}
          {measurements.frameOk && (
            <div className="rounded-xl px-4 py-3 mb-2 text-xs space-y-1.5" style={{ background: '#faf5ff', border: '1px solid #e9d5ff' }}>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <div className="flex justify-between">
                  <span style={{ color: '#6b7280' }}>H. Calibre :</span>
                  <span className="font-semibold" style={{ color: '#7c3aed' }}>{measurements.hauteurCalibre} mm</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6b7280' }}>L. Calibre OD/OG :</span>
                  <span className="font-semibold" style={{ color: '#7c3aed' }}>{measurements.largeurOD} / {measurements.largeurOG} mm</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6b7280' }}>H. Montage OD :</span>
                  <span className="font-semibold" style={{ color: '#7c3aed' }}>{measurements.hauteurMontageOG} mm</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: '#6b7280' }}>H. Montage OG :</span>
                  <span className="font-semibold" style={{ color: '#7c3aed' }}>{measurements.hauteurMontageOD} mm</span>
                </div>
              </div>
            </div>
          )}

          {/* Pantoscopic angle (monture) */}
          {measurements.pantoscopicAngle != null && (
            <div className="flex justify-between items-center px-4 py-2.5 rounded-xl text-xs mb-2" style={{ background: '#faf5ff', border: '1px solid #e9d5ff' }}>
              <span style={{ color: '#4b5563' }}>Angle pantoscopique</span>
              <span className="font-semibold" style={{ color: '#7c3aed' }}>{measurements.pantoscopicAngle}°</span>
            </div>
          )}
          {(measurements.pantoscopicAngle != null && (measurements.pantoscopicAngle < 5 || measurements.pantoscopicAngle > 15)) && (
            <div className="flex items-center gap-1 mb-2 text-[9px]" style={{ color: '#b45309' }}>
              <AlertTriangle size={10} />
              Angle pantoscopique hors norme (8-12°)
            </div>
          )}
        </div>

        {/* Calibration details */}
        {measurements.calibration && (
          <div className="rounded-xl px-3 py-2 mt-4 text-[10px] space-y-0.5" style={{ background: '#f9fafb', border: '1px solid #e5e7eb' }}>
            <div className="font-medium" style={{ color: '#15803d' }}>
              🎯 Calibration active
            </div>
            <div style={{ color: '#9ca3af' }}>
              Échelle : 1 px = {measurements.calibration.scalePxToMm} mm · Variation : {measurements.calibration.variation}%
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button onClick={onRetake}
          className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-full font-medium text-sm transition-all hover:opacity-80"
          style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          <RotateCcw size={16} /> Refaire
        </button>
        <button onClick={handleSavePDF}
          className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90"
          style={{ background: 'var(--color-gold)' }}>
          <FileText size={16} /> Exporter PDF
        </button>
      </div>

      <div className="text-center">
        <p className="text-xs" style={{ color: 'var(--color-text-dim)' }}>
          Méthode : {getMethodeLabel(measurements.methode)} · La mesure est indicative
        </p>
      </div>
    </div>
  )
}
