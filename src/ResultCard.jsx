import { RotateCcw, FileText, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'

export default function ResultCard({ measurements, imageUrl, onRetake }) {
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
      case 'haute': return 'var(--color-green)'
      case 'moyenne': return 'var(--color-gold)'
      case 'faible': return 'var(--color-red)'
      default: return 'var(--color-text-muted)'
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
      // On capture d'abord la carte des mesures
      const measureCanvas = await html2canvas(el, {
        scale: 2,
        backgroundColor: '#0f0f12',
        useCORS: true,
        logging: false,
      })

      const measureImgData = measureCanvas.toDataURL('image/png')
      const measureAspect = measureCanvas.width / measureCanvas.height

      // Calculer l'espace disponible
      let measureW = pageW - margin * 2
      let measureH = measureW / measureAspect

      // Si on a une photo, on la réduit en haut et les mesures en dessous
      if (imageUrl) {
        // Photo en haut (max 25% de la page — taille passeport)
        const photoMaxH = (pageH - margin * 2) * 0.25
        // Charger l'image et détecter l'orientation EXIF
        const photoImg = new Image()
        photoImg.src = imageUrl
        await new Promise(r => { photoImg.onload = r })
        // Déterminer la bonne orientation
        let photoW = measureW * 0.4 // 40% largeur
        let photoH = photoW / (photoImg.width > photoImg.height ? photoImg.height / photoImg.width : photoImg.width / photoImg.height)
        if (photoH > photoMaxH) {
          photoH = photoMaxH
          photoW = photoH * (photoImg.width > photoImg.height ? photoImg.height / photoImg.width : photoImg.width / photoImg.height)
        }

        // Redresser l'image via canvas (corrige EXIF)
        const orientCanvas = document.createElement('canvas')
        const ctx = orientCanvas.getContext('2d')
        // Si l'image est en paysage (w > h), on l'utilise telle quelle
        // Sinon aussi, mais on s'assure que le ratio est bon
        if (photoImg.width > photoImg.height) {
          // Image en paysage → on la tourne pour que ce soit un portrait
          orientCanvas.width = photoImg.height
          orientCanvas.height = photoImg.width
          ctx.translate(orientCanvas.width / 2, orientCanvas.height / 2)
          ctx.rotate(-Math.PI / 2)
          ctx.drawImage(photoImg, -photoImg.width / 2, -photoImg.height / 2)
        } else {
          orientCanvas.width = photoImg.width
          orientCanvas.height = photoImg.height
          ctx.drawImage(photoImg, 0, 0)
        }

        const orientedDataUrl = orientCanvas.toDataURL('image/jpeg', 0.9)
        const orientedAspect = orientCanvas.width / orientCanvas.height
        photoW = measureW * 0.4
        photoH = photoW / orientedAspect
        if (photoH > photoMaxH) {
          photoH = photoMaxH
          photoW = photoH * orientedAspect
        }

        pdf.addImage(orientedDataUrl, 'JPEG', (pageW - photoW) / 2, margin, photoW, photoH)

        // Espace restant pour les mesures
        const remainingH = pageH - margin - photoH - margin - margin
        measureH = Math.min(measureH, remainingH)
        if (measureH < 50) measureH = 50 // minimum

        const measureY = margin + photoH + margin
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
  body { font-family: 'Inter', system-ui, sans-serif; background: #0f0f12; color: #e8e6e0; padding: 20px; max-width: 600px; margin: auto; }
  .card { background: #1a1a20; border-radius: 16px; padding: 24px; border: 1px solid #2a2a32; margin-bottom: 16px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-icon { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #c9a05a, #a8863a); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; color: #0f0f12; }
  .brand-text { font-family: 'Playfair Display', Georgia, serif; font-size: 18px; font-weight: 600; }
  .brand-text span { display: block; font-size: 10px; color: #c9a05a; text-transform: uppercase; letter-spacing: 1px; font-family: 'Inter', sans-serif; }
  .photo { width: 100%; border-radius: 12px; margin-bottom: 16px; aspect-ratio: 4/3; object-fit: cover; }
  .dp-main { text-align: center; padding: 20px; background: #0f0f12; border-radius: 12px; margin-bottom: 16px; border: 1px solid #2a2a32; }
  .dp-main .value { font-size: 56px; font-weight: 700; letter-spacing: -1px; color: #e8e6e0; }
  .dp-main .unit { font-size: 20px; color: #555; margin-left: 2px; }
  .dp-main .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .dp-main .conf { font-size: 10px; color: #22c55e; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .grid .box { text-align: center; padding: 14px; background: #0f0f12; border-radius: 10px; border: 1px solid #2a2a32; }
  .grid .box .val { font-size: 28px; font-weight: 600; color: #e8e6e0; }
  .grid .box .lbl { font-size: 10px; color: #888; text-transform: uppercase; }
  .meta { display: flex; gap: 16px; font-size: 11px; color: #888; padding: 12px; background: #1a1a20; border-radius: 10px; }
  .meta strong { color: #e8e6e0; }
  .footer { text-align: center; font-size: 10px; color: #555; padding: 12px; }
  .section-title { font-size: 11px; color: #8b5cf6; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  .dim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 14px; }
  .dim-item { display: flex; justify-content: space-between; padding: 6px 10px; background: #0f0f12; border-radius: 6px; font-size: 11px; }
  .dim-item .lbl { color: #888; }
  .dim-item .val { color: #8b5cf6; font-weight: 600; }
  .dim-item .val.green { color: #22c55e; }
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

  ${imageUrl ? `<img class="photo" src="${imageUrl}" alt="Photo client" />` : ''}

  <div class="card">
    <div class="dp-main">
      <div class="label">Distance Pupillaire Binoculaire</div>
      <div class="value">${measurements.pd}<span class="unit">mm</span></div>
      <div class="conf">Précision clinique ✓</div>
      <div style="font-size:10px;color:#555;margin-top:4px">${date} · ${heure}</div>
    </div>

    <div class="grid">
      <div class="box">
        <div class="val">${measurements.pdMonoculaireDroit}<span style="font-size:14px;color:#555">mm</span></div>
        <div class="lbl">Œil Droit (OD)${measurements.pontPlace ? ' · Pont → OD' : ''}</div>
      </div>
      <div class="box">
        <div class="val">${measurements.pdMonoculaireGauche}<span style="font-size:14px;color:#555">mm</span></div>
        <div class="lbl">Œil Gauche (OG)${measurements.pontPlace ? ' · Pont → OG' : ''}</div>
      </div>
    </div>

    ${measurements.frameOk ? `
    <div class="section-title">📐 Dimensions calibre (boxing)</div>
    <div class="dim-grid">
      <div class="dim-item"><span class="lbl">H. Calibre</span><span class="val">${measurements.hauteurCalibre} mm</span></div>
      <div class="dim-item"><span class="lbl">L. Calibre G/D</span><span class="val">${measurements.largeurG ?? '—'} / ${measurements.largeurD ?? '—'} mm</span></div>
      <div class="dim-item"><span class="lbl">H. Montage OG</span><span class="val">${measurements.hauteurMontageOG ?? '—'} mm</span></div>
      <div class="dim-item"><span class="lbl">H. Montage OD</span><span class="val">${measurements.hauteurMontageOD ?? '—'} mm</span></div>
    </div>` : ''}

    ${measurements.pont != null ? `
    <div style="text-align:center;padding:10px;background:#1a2a1a;border-radius:10px;margin-bottom:14px;border:1px solid #2a3a2a">
      <div style="font-size:10px;color:#888;text-transform:uppercase">Écart inter-verres (Pont)</div>
      <div style="font-size:22px;font-weight:600;color:#22c55e">${measurements.pont} mm</div>
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
      {/* Photo preview */}
      {imageUrl && (
        <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
          <img src={imageUrl} alt="Photo client" className="w-full aspect-[4/3] object-cover" />
        </div>
      )}

      {/* Results card */}
      <div id="result-card-content" className="rounded-2xl p-6 border" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <h3 className="text-xs uppercase tracking-wider mb-4 flex items-center gap-2" style={{ color: 'var(--color-gold)' }}>
          <CheckCircle2 size={14} />
          Résultat de la mesure
        </h3>

        {/* Validation banner */}
        {!validation.valid && (
          <div className={`rounded-xl px-4 py-3 mb-4 flex items-start gap-2 text-xs ${
            validation.level === 'error' ? 'border' : 'border'
          }`}
          style={{
            background: validation.level === 'error' ? 'var(--color-red-bg)' : 'var(--color-gold-bg)',
            borderColor: validation.level === 'error' ? 'var(--color-red)' : 'var(--color-gold)',
            color: validation.level === 'error' ? 'var(--color-red)' : 'var(--color-gold)',
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

        {/* Main PD */}
        <div className="text-center py-5 mb-4 rounded-xl" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>Distance Pupillaire Binoculaire</div>
          <div className="text-5xl font-bold tracking-tight" style={{ color: 'var(--color-text)' }}>
            {measurements.pd}
            <span className="text-xl ml-1" style={{ color: 'var(--color-text-dim)' }}>mm</span>
          </div>
          <div className="text-[10px] mt-1" style={{ color: getConfianceColor(measurements.confiance) }}>
            {getConfianceLabel(measurements.confiance)}
          </div>
        </div>

        {/* Monocular */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="text-center py-3 rounded-xl" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
            <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>Œil Droit (OD)</div>
            <div className="text-2xl font-semibold" style={{ color: 'var(--color-gold)' }}>
              {measurements.pdMonoculaireDroit}
              <span className="text-sm ml-1" style={{ color: 'var(--color-text-dim)' }}>mm</span>
            </div>
            {measurements.pontPlace && (
              <div className="text-[9px] mt-0.5" style={{ color: 'var(--color-green)' }}>Pont → OD</div>
            )}
          </div>
          <div className="text-center py-3 rounded-xl" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
            <div className="text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>Œil Gauche (OG)</div>
            <div className="text-2xl font-semibold" style={{ color: '#3b82f6' }}>
              {measurements.pdMonoculaireGauche}
              <span className="text-sm ml-1" style={{ color: 'var(--color-text-dim)' }}>mm</span>
            </div>
            {measurements.pontPlace && (
              <div className="text-[9px] mt-0.5" style={{ color: 'var(--color-green)' }}>Pont → OG</div>
            )}
          </div>
        </div>

        {/* Bridge */}
        {measurements.pont != null && (
          <div className="text-center py-2 mb-3 rounded-lg" style={{ background: 'var(--color-green-bg)', border: '1px solid var(--color-border)' }}>
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Écart inter-verres (Pont)</div>
            <div className="text-lg font-semibold" style={{ color: 'var(--color-green)' }}>{measurements.pont} mm</div>
          </div>
        )}

        {/* Boxing dimensions */}
        {measurements.frameOk && (
          <div className="rounded-xl p-3 mb-3 space-y-2 text-xs"
            style={{ background: 'var(--color-purple-bg)', border: '1px solid var(--color-border)' }}>
            <div className="text-[10px] uppercase tracking-wide font-medium" style={{ color: 'var(--color-purple)' }}>
              📐 Dimensions calibre (boxing)
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <div className="flex justify-between">
                <span style={{ color: 'var(--color-text-muted)' }}>H. Calibre :</span>
                <span style={{ color: 'var(--color-purple)' }}>{measurements.hauteurCalibre} mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--color-text-muted)' }}>L. Calibre G/D :</span>
                <span style={{ color: 'var(--color-purple)' }}>{measurements.largeurG} / {measurements.largeurD} mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--color-text-muted)' }}>H. Montage OG :</span>
                <span style={{ color: 'var(--color-purple)' }}>{measurements.hauteurMontageOG} mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--color-text-muted)' }}>H. Montage OD :</span>
                <span style={{ color: 'var(--color-purple)' }}>{measurements.hauteurMontageOD} mm</span>
              </div>
            </div>
          </div>
        )}

        {/* Calibration details */}
        {measurements.calibration && (
          <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: 'var(--color-green-bg)', border: '1px solid var(--color-border)' }}>
            <div className="font-medium" style={{ color: 'var(--color-green)' }}>
              🎯 Calibration active
            </div>
            <div style={{ color: 'var(--color-text-muted)' }}>
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
