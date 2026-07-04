export default function ResultCard({ measurements, imageUrl, onRetake }) {
  const getConfianceColor = (level) => {
    switch (level) {
      case 'haute': return '#28a745'
      case 'moyenne': return '#c9975a'
      case 'faible': return '#dc3545'
      default: return '#888'
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

  const handleSave = () => {
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
  body { font-family: Georgia, serif; background: #faf9f6; color: #2d2d2d; padding: 20px; max-width: 600px; margin: auto; }
  .card { background: #fff; border-radius: 16px; padding: 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); margin-bottom: 16px; }
  .brand { font-size: 20px; font-weight: 600; letter-spacing: -0.3px; }
  .brand span { color: #c9975a; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; display: block; }
  .photo { width: 100%; border-radius: 12px; margin-bottom: 16px; aspect-ratio: 4/3; object-fit: cover; }
  .dp-main { text-align: center; padding: 20px; background: #faf9f6; border-radius: 12px; margin-bottom: 16px; }
  .dp-main .value { font-size: 56px; font-weight: 700; letter-spacing: -1px; }
  .dp-main .unit { font-size: 20px; color: #aaa; margin-left: 2px; }
  .dp-main .label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 1px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .grid .box { text-align: center; padding: 14px; background: #faf9f6; border-radius: 10px; }
  .grid .box .val { font-size: 28px; font-weight: 600; }
  .grid .box .lbl { font-size: 10px; color: #999; text-transform: uppercase; }
  .meta { display: flex; gap: 16px; font-size: 11px; color: #888; padding: 12px; background: #f5f0e8; border-radius: 10px; }
  .meta strong { color: #2d2d2d; }
  .conf { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
  .conf .dot { width: 8px; height: 8px; border-radius: 50%; }
  .footer { text-align: center; font-size: 10px; color: #bbb; padding: 12px; }
  @media print { body { background: #fff; } }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      Smart Optica
      <span>Centrage Digital</span>
    </div>
  </div>

  ${imageUrl ? `<img class="photo" src="${imageUrl}" alt="Photo client" />` : ''}

  <div class="card">
    <div class="dp-main">
      <div class="label">Distance Pupillaire Binoculaire</div>
      <div class="value">${measurements.pd}<span class="unit">mm</span></div>
      <div style="font-size:10px;color:#bbb;margin-top:4px">Date: ${date} · ${heure}</div>
    </div>

    <div class="grid">
      <div class="box">
        <div class="val">${measurements.pdMonoculaireDroit}<span style="font-size:14px;color:#bbb">mm</span></div>
        <div class="lbl">Œil Droit (OD)${measurements.pontPlace ? ' · Pont → OD' : ''}</div>
      </div>
      <div class="box">
        <div class="val">${measurements.pdMonoculaireGauche}<span style="font-size:14px;color:#bbb">mm</span></div>
        <div class="lbl">Œil Gauche (OG)${measurements.pontPlace ? ' · Pont → OG' : ''}</div>
      </div>
    </div>

    ${measurements.pont != null ? `
    <div class="card" style="background:#f0fdf4">
      <div style="text-align:center">
        <div style="font-size:10px;color:#999;text-transform:uppercase">Écart inter-verres (Pont)</div>
        <div style="font-size:24px;font-weight:600;color:#166534">${measurements.pont} mm</div>
      </div>
    </div>` : ''}

    <div class="meta">
      <div><strong>Méthode :</strong> ${getMethodeLabel(measurements.methode)}</div>
      <div class="conf" style="color:${getConfianceColor(measurements.confiance)}">
        <span class="dot" style="background:${getConfianceColor(measurements.confiance)}"></span>
        ${getConfianceLabel(measurements.confiance)}
      </div>
    </div>
  </div>

  <div class="footer">Smart Optica © 2026 · Mesure DP de précision · Ce document est généré automatiquement</div>
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
    <div className="space-y-5 animate-in fade-in duration-300">
      {/* Photo preview */}
      {imageUrl && (
        <div className="rounded-2xl overflow-hidden shadow-lg" style={{ background: '#fff' }}>
          <img
            src={imageUrl}
            alt="Photo client"
            className="w-full aspect-[4/3] object-cover"
          />
        </div>
      )}

      {/* Measurement card */}
      <div className="rounded-2xl p-6 shadow-lg" style={{ background: '#fff' }}>
        <h3 className="text-sm uppercase tracking-wider mb-4" style={{ color: '#c9975a' }}>
          Résultat de la mesure
        </h3>

        {/* Main PD value */}
        <div className="text-center py-4 mb-4 rounded-xl" style={{ background: '#faf9f6' }}>
          <div className="text-xs mb-1" style={{ color: '#999' }}>Distance Pupillaire Binoculaire</div>
          <div className="text-5xl font-bold tracking-tight" style={{ color: '#2d2d2d' }}>
            {measurements.pd}
            <span className="text-xl ml-1" style={{ color: '#aaa' }}>mm</span>
          </div>
        </div>

        {/* Monocular breakdown */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="text-center py-3 rounded-xl" style={{ background: '#faf9f6' }}>
            <div className="text-xs mb-1" style={{ color: '#999' }}>Œil Droit (OD)</div>
            <div className="text-2xl font-semibold" style={{ color: '#2d2d2d' }}>
              {measurements.pdMonoculaireDroit}
              <span className="text-sm ml-1" style={{ color: '#bbb' }}>mm</span>
            </div>
            {measurements.pontPlace && (
              <div className="text-[9px] mt-0.5" style={{ color: '#22c55e' }}>Pont → OD</div>
            )}
          </div>
          <div className="text-center py-3 rounded-xl" style={{ background: '#faf9f6' }}>
            <div className="text-xs mb-1" style={{ color: '#999' }}>Œil Gauche (OG)</div>
            <div className="text-2xl font-semibold" style={{ color: '#2d2d2d' }}>
              {measurements.pdMonoculaireGauche}
              <span className="text-sm ml-1" style={{ color: '#bbb' }}>mm</span>
            </div>
            {measurements.pontPlace && (
              <div className="text-[9px] mt-0.5" style={{ color: '#22c55e' }}>Pont → OG</div>
            )}
          </div>
        </div>

        {/* Bridge value */}
        {measurements.pont != null && (
          <div className="text-center py-2 mb-3 rounded-lg" style={{ background: '#f0fdf4' }}>
            <div className="text-xs" style={{ color: '#999' }}>Écart inter-verres (Pont)</div>
            <div className="text-lg font-semibold" style={{ color: '#166534' }}>{measurements.pont} mm</div>
          </div>
        )}

        {/* Frame / lens dimensions (boxing) */}
        {measurements.frameOk && (
          <div className="rounded-xl p-3 mb-3 space-y-2 text-xs" style={{ background: '#f5f3ff', border: '1px solid #e9e3ff' }}>
            <div className="text-[10px] uppercase tracking-wide font-medium" style={{ color: '#7c3aed' }}>📐 Dimensions calibre (boxing)</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <div className="flex justify-between">
                <span style={{ color: '#888' }}>H. Calibre :</span>
                <span style={{ color: '#7c3aed' }}>{measurements.hauteurCalibre} mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#888' }}>L. Calibre G/D :</span>
                <span style={{ color: '#7c3aed' }}>{measurements.largeurG} / {measurements.largeurD} mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#888' }}>H. Montage OG :</span>
                <span style={{ color: '#7c3aed' }}>{measurements.hauteurMontageOG} mm</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#888' }}>H. Montage OD :</span>
                <span style={{ color: '#7c3aed' }}>{measurements.hauteurMontageOD} mm</span>
              </div>
            </div>
          </div>
        )}

        {/* Confidence badge */}
        <div className="flex items-center gap-2 text-xs mb-3" style={{ color: getConfianceColor(measurements.confiance) }}>
          <div className="w-2 h-2 rounded-full" style={{ background: getConfianceColor(measurements.confiance) }} />
          {getConfianceLabel(measurements.confiance)}
        </div>

        {/* Calibration details */}
        {measurements.calibration && (
          <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: '#f0f8f0' }}>
            <div className="font-medium" style={{ color: '#2d7d2d' }}>
              🎯 Calibration active
            </div>
            <div style={{ color: '#666' }}>
              Échelle : 1 px = {measurements.calibration.scalePxToMm} mm · Variation : {measurements.calibration.variation}%
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={onRetake}
          className="flex-1 py-3 rounded-full font-medium text-sm transition-all hover:opacity-80"
          style={{ background: '#f0ede7', color: '#666' }}
        >
          ↺ Refaire la mesure
        </button>
        <button
          onClick={handleSave}
          className="flex-1 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90"
          style={{ background: '#c9975a' }}
        >
          📋 Enregistrer
        </button>
      </div>

      {/* Info */}
      <div className="text-center">
        <p className="text-xs" style={{ color: '#bbb' }}>
          Méthode : {getMethodeLabel(measurements.methode)} · La mesure est indicative
        </p>
      </div>
    </div>
  )
}
