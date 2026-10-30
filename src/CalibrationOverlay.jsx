import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, Check, SkipForward, AlertTriangle, Loader2, Settings2, Camera, Ruler, ZoomIn } from 'lucide-react'
import { analyzeCalibration } from './services/api'
import { resolveValidatedCalibration } from './core/optics'
import { calibrateFromKnownDistance } from './core/noClipCalibration'
import PrecisionLoupe from './components/PrecisionLoupe'

export default function CalibrationOverlay({ imageUrl, onCalibrated, onSkip, onRetake, initialPoints }) {
  const [points, setPoints] = useState([])
  // Mires détectées HORS de la rangée de calibrage : les deux mires hautes du
  // clip (v22.1 et v23.5). Elles ne servent PAS au calibrage — l'échelle se
  // déduit de l'écartement des trois mires de rangée — mais le backend les voit
  // et les mesure. Les taire faisait croire à une détection partielle : l'écran
  // affichait 3 repères quand le détecteur en avait trouvé 5. On les DESSINE,
  // sans les rendre manipulables, pour que l'écran dise la vérité de la mesure
  // sans changer le geste de l'opticien.
  const [infoMarkers, setInfoMarkers] = useState([])
  const [imageSize, setImageSize] = useState(null)
  const [debugInfo, setDebugInfo] = useState(null)
  const [markerSpacing, setMarkerSpacing] = useState(50)
  const [showSpacingInput, setShowSpacingInput] = useState(false)
  const [autoDetecting, setAutoDetecting] = useState(true)
  const [autoFailed, setAutoFailed] = useState(false)
  const backendScaleRef = useRef(null)  // échelle issue de la détection automatique
  const manuallyAdjustedRef = useRef(false)
  const cancelAutoRef = useRef(false)
  const containerRef = useRef(null)
  const imageRef = useRef(null)

  // ── Mode « sans clip » (étalon de dépannage) ──
  const [noClipMode, setNoClipMode] = useState(false)
  const [noClipPoints, setNoClipPoints] = useState([]) // max 2 points
  const [noClipKnownMm, setNoClipKnownMm] = useState(50)

  // ── Pointage assisté ────────────────────────────────────────────────────────
  // Le calibrage est l'étape la plus sensible de la chaîne : son échelle se
  // répercute sur TOUTES les mesures. Le doigt masquant le bord de la cale qu'il
  // vise, on vise d'abord (loupe) et on pose au relâchement.
  // `null` = automatique (l'échec de la détection l'active), true/false = choix
  // explicite de l'utilisateur, qui prime.
  const [assistOverride, setAssistOverride] = useState(null)
  const [aim, setAim] = useState(null)   // { pos, mode: 'points' | 'noclip' }

  // Rectangle réellement affiché à l'écran — source unique pour les coordonnées
  const getImageDisplayRect = useCallback(() => {
    const imgRect = imageRef.current?.getBoundingClientRect()
    if (!imgRect || !containerRef.current) return null
    const cRect = containerRef.current.getBoundingClientRect()
    return {
      left: imgRect.left - cRect.left,
      top: imgRect.top - cRect.top,
      width: imgRect.width,
      height: imgRect.height,
    }
  }, [])

  const toImageCoords = useCallback((clientX, clientY) => {
    const rect = getImageDisplayRect()
    if (!rect || !imageSize) return null
    const x = Math.max(0, Math.min(rect.width, clientX - containerRef.current.getBoundingClientRect().left - rect.left))
    const y = Math.max(0, Math.min(rect.height, clientY - containerRef.current.getBoundingClientRect().top - rect.top))
    return { x: (x / rect.width) * imageSize.width, y: (y / rect.height) * imageSize.height }
  }, [imageSize, getImageDisplayRect])

  // ── Drag state for calibration markers ──
  const [dragTarget, setDragTarget] = useState(null) // { index, startClient, startPos }
  const pointsRef = useRef([])

  // Keep ref in sync
  useEffect(() => { pointsRef.current = points }, [points])

  useEffect(() => {
    const img = new Image()
    img.src = imageUrl
    img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
  }, [imageUrl])

  useEffect(() => {
    if (Array.isArray(initialPoints) && initialPoints.length === 3) {
      setPoints(initialPoints)
    }
  }, [initialPoints])

  const cancelAutoDetect = useCallback(() => {
    cancelAutoRef.current = true
    setAutoDetecting(false)
    setAutoFailed(true)
  }, [])

  useEffect(() => {
    if (!imageUrl) return
    // TOUJOURS appeler l'API backend
    setAutoDetecting(true)
    setAutoFailed(false)
    cancelAutoRef.current = false

    ;(async () => {
      await new Promise(r => setTimeout(r, 200))
      if (cancelAutoRef.current) { setAutoDetecting(false); setAutoFailed(true); return }

      // 1) Backend API /api/analyze-calibration (HoughCircles + checkerboard)
      try {
        const resp = await fetch(imageUrl)
        const blob = await resp.blob()
        if (cancelAutoRef.current) { setAutoDetecting(false); setAutoFailed(true); return }
        const apiResult = await analyzeCalibration(blob)
        // Le backend renvoie 3 mires… 4 sur le clip v19.5, 5 sur le v22.1 (la mire
        // haute a désormais un miroir). Les mires hors rangée servent à
        // l'auto-contrôle des étalons, à la symétrie et à la mesure du roll.
        // Exiger `=== 3` rejetait donc une détection RÉUSSIE sur le clip v19.5.
        // Le calibrage n'utilise que la rangée (les 3 premières, dans l'ordre).
        const detected = Array.isArray(apiResult.markers) ? apiResult.markers : []
        if (cancelAutoRef.current) return
        if (detected.length >= 3) {
          setPoints(detected.slice(0, 3))
          setInfoMarkers(detected.slice(3))
          setAutoDetecting(false)
          const scaleInfo = {
            scalePxToMm: apiResult.scale_mm_per_px,
            pixelDist1: Math.round(apiResult.spacing_px),
            pixelDist2: Math.round(apiResult.spacing_px),
            scaleVariation: 0,
            headRotation: 0,
            poseAssessment: 'Automatique (backend)',
            source: 'backend_auto',
          }
          setDebugInfo({
            ...scaleInfo,
            backendConfidence: apiResult.detection_confidence,
            nClipMarkers: detected.length,
            // Roll du clip (C) : référence MÉCANIQUE (les mires du clip), mesurée
            // sans dépendre d'un visage. Affiché en degrés, pas en %.
            clipRollDeg: apiResult.facial_quad_check?.roll_deg ?? null,
            clipRollOk: apiResult.facial_quad_check?.roll_consistent ?? null,
            // La 4ᵉ mire a-t-elle été VUE puis écartée (géométrie incohérente), ou
            // simplement absente (clip à 3 mires) ? Deux causes différentes, et sans
            // cette nuance l'app afficherait la même chose dans les deux cas.
            quadValid: apiResult.facial_quad_check?.quad_valid ?? null,
            quadNPoints: apiResult.facial_quad_check?.n_points ?? null,
            // ORIENTATION de la prise de vue, LUE SUR les damiers du clip : selfie
            // (image retournée) ou caméra arrière. ⚠️ En selfie, le côté « gauche » de
            // l'image est le côté DROIT du porteur : à ne pas confondre pour l'œil
            // droit et l'œil gauche. `null` = signature illisible, on n'affirme rien.
            imageMirrored: apiResult.image_mirrored ?? null,
            orientationPrise: apiResult.orientation_prise_de_vue ?? null,
          })
          backendScaleRef.current = scaleInfo  // stocker pour confirmCalibration
          return
        }
        // Détection PARTIELLE (moins de 3 mires de rangée) : c'est un échec, pas
        // une attente. Sans ce cas, l'écran restait figé sur « Analyse des mires… »
        // et l'utilisateur n'avait aucun moyen de reprendre la main.
        setAutoDetecting(false)
        setAutoFailed(true)
        setDebugInfo({
          error: `Détection incomplète : ${detected.length} mire(s) sur 3 — pointage manuel`,
        })
        return
      } catch (e) {
        console.error('Calibration API échouée:', e.message)
        if (!cancelAutoRef.current) {
          setAutoDetecting(false)
          setAutoFailed(true)
          // ⚠️ TROIS ÉCHECS DIFFÉRENTS, TROIS MESSAGES DIFFÉRENTS.
          // Avant, tout tombait sur « API indisponible », puis l'écran affichait
          // « Détection infructueuse ». Un HTTP 500 (le serveur a planté pendant
          // l'analyse) était donc présenté comme une détection ratée, et
          // l'opticien recadrait sa photo au lieu de réessayer. Ce défaut a coûté
          // plusieurs heures de diagnostic : la panne était visible dans les
          // journaux, jamais à l'écran.
          //   status    : le serveur a répondu, en erreur — réessayer
          //   network   : pas de réponse du tout — vérifier la connexion
          //   (rien)    : réponse valide mais détection insuffisante — pointer
          setDebugInfo(e.status
            ? { errorKind: 'http', httpStatus: e.status,
                error: `Le serveur n'a pas pu analyser cette photo (HTTP ${e.status})` }
            : { errorKind: 'network',
                error: 'Serveur injoignable — vérifiez la connexion' })
        }
        return
      }
    })()
  }, [imageUrl, markerSpacing])

  const assistOn = assistOverride ?? autoFailed
  // Vérité de la détection des mires : « analyse… » tant qu'on ne sait pas, jamais
  // « ok » d'office. L'API renvoie detection_confidence — on l'affiche au lieu de la
  // garder dans un objet de débogage.
  const detectLabel = autoDetecting
    ? { text: 'Analyse des mires…', color: 'var(--color-text-muted)' }
    : autoFailed
      ? (debugInfo?.errorKind === 'http'
          ? { text: `Serveur en erreur (${debugInfo.httpStatus}) — réessayez, ou pointez à la loupe`,
              color: 'var(--color-red)' }
          : debugInfo?.errorKind === 'network'
            ? { text: 'Serveur injoignable — vérifiez la connexion',
                color: 'var(--color-red)' }
            : { text: 'Détection infructueuse — placez les 3 repères avec la loupe',
                color: 'var(--color-red)' })
      : manuallyAdjustedRef.current
        ? { text: 'Repères placés manuellement', color: 'var(--color-text-muted)' }
        : debugInfo?.backendConfidence != null
          ? {
              text: `Détection serveur · confiance ${Number(debugInfo.backendConfidence).toFixed(2)}`
                + (debugInfo.nClipMarkers === 4 ? ' · 4 mires' : '')
                // ORIENTATION lue sur les damiers du clip : c'est une MESURE, pas ce
                // que le navigateur déclare. En selfie l'image est retournée, donc le
                // côté gauche de l'image est le côté DROIT du porteur — l'afficher
                // évite de se tromper d'œil sur une mesure monoculaire.
                + (debugInfo.imageMirrored === true
                  ? ' · selfie (image retournée)'
                  : debugInfo.orientationPrise === 'normale'
                    ? ' · caméra arrière'
                    : '')
                + (debugInfo.clipRollDeg != null
                  ? ` · clip ${debugInfo.clipRollDeg >= 0 ? '+' : ''}${Number(debugInfo.clipRollDeg).toFixed(1)}°`
                  : debugInfo.quadValid === false && debugInfo.quadNPoints === 4
                    ? ' · 4e mire écartée (géométrie incohérente)'
                    : ''),
              // Le roll vient des mires du CLIP (référence mécanique) : un désaccord
              // entre les deux directions du quadrilatère signale une détection douteuse.
              color: debugInfo.clipRollOk === false ? 'var(--color-red)' : '#22c55e',
            }
          : { text: 'Détection serveur', color: '#22c55e' }

  // Réticule du repère — SOURCE UNIQUE, partagée avec la loupe (qui le grossit du même
  // facteur que l'image). La loupe dessinait sa propre croix, différente du repère.
  const reticleNode = (dragging) => {
    // UN SEUL ACCENT. L'écran portait trois couleurs concurrentes — or, magenta
    // (#ff2dd0) et cyan (#5eead4) — et l'œil ne savait plus ce qui mesure, ce qui
    // informe et ce qui attend un geste. Désormais tout ce qui est MESURÉ est or.
    // La distinction « manipulable / simplement vu » passe par la FORME : anneau
    // plein + croix pour les trois repères, anneau pointillé pour les mires hautes.
    //
    // La croix est volontairement À TROU CENTRAL : une croix pleine masque le
    // damier qu'on vise, alors qu'on demande de poser le repère au centre d'un
    // motif de 2,5 mm.
    const c = dragging ? 'var(--color-gold-light)' : 'var(--color-gold)'
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" className="mx-auto block"
        style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.55))' }}>
        <circle cx="12" cy="12" r="9.5" fill="none" stroke={c} strokeWidth={dragging ? 2 : 1.7} />
        <g stroke={c} strokeWidth="1.5" strokeLinecap="round">
          <line x1="12" y1="2.6" x2="12" y2="6.6" />
          <line x1="12" y1="17.4" x2="12" y2="21.4" />
          <line x1="2.6" y1="12" x2="6.6" y2="12" />
          <line x1="17.4" y1="12" x2="21.4" y2="12" />
        </g>
        <circle cx="12" cy="12" r={dragging ? 1.9 : 1.6} fill={c} />
      </svg>
    )
  }

  // Pose effective d'un repère de calibrage (3 au maximum).
  const addPoint = (pt) => {
    const cp = pointsRef.current
    if (cp.length >= 3) return
    const newPoints = [...cp, pt]
    manuallyAdjustedRef.current = true
    setPoints(newPoints)
    if (newPoints.length === 3) setDebugInfo(calculateScale(newPoints, markerSpacing))
  }

  // Le relâchement pose, selon le mode en cours (repères ou « sans clip »).
  const applyAim = (pt) => {
    if (aim && aim.mode === 'noclip') {
      setNoClipPoints(prev => (prev.length >= 2 ? prev : [...prev, pt]))
    } else {
      addPoint(pt)
    }
    setAim(null)
  }

  const handleContainerPointerMove = (e) => {
    if (!assistOn || !aim) return
    const c = toImageCoords(e.clientX, e.clientY)
    if (c) setAim((a) => ({ pos: { x: Math.round(c.x), y: Math.round(c.y) }, mode: a && a.mode }))
  }

  const handleContainerPointerUp = (e) => {
    if (!assistOn || !aim) return
    const c = toImageCoords(e.clientX, e.clientY)
    applyAim(c ? { x: Math.round(c.x), y: Math.round(c.y) } : aim.pos)
  }

  const handleContainerPointerDown = (e) => {
    // ── Mode « sans clip » : placer 2 points sur une distance connue ──
    if (noClipMode) {
      const coords = toImageCoords(e.clientX, e.clientY)
      if (!coords) return
      const pt = { x: Math.round(coords.x), y: Math.round(coords.y) }
      if (assistOn) { setAim({ pos: pt, mode: 'noclip' }); return }
      setNoClipPoints(prev => (prev.length >= 2 ? prev : [...prev, pt]))
      return
    }

    // Walk up DOM to find a calibration marker
    let target = e.target
    while (target && target !== containerRef.current) {
      if (target.dataset?.markerid !== undefined) {
        const idx = parseInt(target.dataset.markerid, 10)
        const p = pointsRef.current[idx]
        if (!p) return
        e.preventDefault()
        setDragTarget({ index: idx, startClient: { x: e.clientX, y: e.clientY }, startPos: { ...p } })
        return
      }
      target = target.parentElement
    }

    // Tap outside markers → no-op (désactive tout)
    // But if less than 3 markers and not dragging, create new marker
    const cp = pointsRef.current
    if (cp.length >= 3) return // all 3 placed → tap outside does nothing
    const coords = toImageCoords(e.clientX, e.clientY)
    if (!coords) return
    const pt = { x: Math.round(coords.x), y: Math.round(coords.y) }
    // Pointage assisté : on VISE d'abord, on POSE au relâchement.
    if (assistOn) { setAim({ pos: pt, mode: 'points' }); return }
    addPoint(pt)
  }

  // Window-level drag listeners
  useEffect(() => {
    if (!dragTarget) return

    const onMove = (e) => {
      const startImg = toImageCoords(dragTarget.startClient.x, dragTarget.startClient.y)
      const currImg = toImageCoords(e.clientX, e.clientY)
      if (!startImg || !currImg) return
      const dx = currImg.x - startImg.x
      const dy = currImg.y - startImg.y
      const newPos = { x: dragTarget.startPos.x + dx, y: dragTarget.startPos.y + dy }
      const newPoints = [...pointsRef.current]
      newPoints[dragTarget.index] = newPos
      manuallyAdjustedRef.current = true
      setPoints(newPoints)
    }

    const onUp = () => {
      setDragTarget(null)
      // Recalc scale if we have 3
      if (pointsRef.current.length === 3) {
        setDebugInfo(calculateScale(pointsRef.current, markerSpacing))
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragTarget, toImageCoords, markerSpacing])

  const resetPoints = () => {
    setPoints([])
    setDebugInfo(null)
    setAutoFailed(false)
    backendScaleRef.current = null
    manuallyAdjustedRef.current = false
  }

  const confirmCalibration = () => {
    const scaleData = resolveValidatedCalibration(
      points,
      markerSpacing,
      backendScaleRef.current,
      manuallyAdjustedRef.current,
    )
    if (scaleData) onCalibrated(scaleData)
  }

  const allPlaced = points.length === 3

  return (
    <div className="rounded-2xl border overflow-hidden animate-fade-in" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
      {/* Barre d'actions SEULE. L'état était ici ET dans la ligne de détection
          ci-dessous : deux fois la même information, dont une seule était
          actionnable. L'état vit désormais dans la ligne de détection, qui porte
          déjà `data-detect="method"` et dit la vérité de la mesure (y compris
          les échecs) ; cette barre ne contient plus que des gestes. */}
      <div className="px-4 py-2.5 flex items-center justify-end gap-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3">
          {onRetake && (
            <button onClick={onRetake} className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-red)' }}>
              <Camera size={12} /> Reprendre
            </button>
          )}
          <button onClick={() => setAssistOverride(!assistOn)} data-tool="assist" data-assist={assistOn ? '1' : '0'}
            title="Poser les repères à la loupe : on vise, on relâche"
            className="flex items-center gap-1 text-xs transition-all hover:opacity-80"
            style={{ color: assistOn ? 'var(--color-gold)' : 'var(--color-text)' }}>
            <ZoomIn size={12} /> Pointage assisté{assistOn ? ' ✓' : ''}
          </button>
          <button onClick={onSkip} className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-text-muted)' }}>
            <SkipForward size={12} /> Passer
          </button>
        </div>
      </div>

      {/* Auto-detection status */}
      {autoDetecting && (
        <div className="px-4 py-2.5 flex items-center gap-2.5" style={{ background: 'var(--color-gold-bg)', borderBottom: '1px solid var(--color-border)' }}>
          <Loader2 size={14} className="animate-spin-slow" style={{ color: 'var(--color-gold)', animation: 'spin 1s linear infinite' }} />
          <span className="text-xs flex-1" style={{ color: 'var(--color-gold-light)' }}>Recherche automatique des 3 repères…</span>
          <button
            onClick={cancelAutoDetect}
            className="px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-all hover:opacity-90"
            style={{ background: 'var(--color-red)', color: '#fff' }}
          >
            Annuler
          </button>
        </div>
      )}
      {/* Vérité de la détection — même règle que les contrôles objectifs : un état non
            encore connu s'annonce « analyse… », jamais « ok ». */}
        <div data-detect="method" className="px-4 py-2.5 flex items-center justify-between gap-3"
          style={{
            background: autoFailed ? 'var(--color-red-bg)' : 'transparent',
            borderBottom: '1px solid var(--color-border)',
          }}>
          <div className="flex items-center gap-2 min-w-0">
            {autoFailed
              ? <AlertTriangle size={13} style={{ color: 'var(--color-red)' }} />
              : autoDetecting
                ? <Loader2 size={12} className="animate-spin" style={{ color: 'var(--color-gold)' }} />
                : allPlaced
                  ? <span style={{ width: 6, height: 6, borderRadius: '50%',
                      background: 'var(--color-green)', display: 'inline-block', flexShrink: 0 }} />
                  : <span style={{ width: 6, height: 6, borderRadius: '50%',
                      background: 'var(--color-text-dim)', display: 'inline-block', flexShrink: 0 }} />}
            <p className="text-xs truncate" style={{ color: detectLabel.color }}>{detectLabel.text}</p>
          </div>
          <span className="text-[11px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>
            {allPlaced
              ? `${points.length} repères à vérifier`
              : autoDetecting ? '' : '① Gauche · ② Centre · ③ Droite'}
          </span>
        </div>

      {/* Image + markers */}
      <div
        ref={containerRef}
        className="relative select-none overflow-hidden mx-auto"
        style={{
          cursor: allPlaced ? 'default' : 'crosshair',
          touchAction: 'none',
          maxHeight: '60vh',
          width: 'fit-content',
          fontSize: 0,
          lineHeight: 0,
        }}
        onPointerDown={handleContainerPointerDown}
        onPointerMove={handleContainerPointerMove}
        onPointerUp={handleContainerPointerUp}
        onPointerCancel={() => setAim(null)}
        onPointerLeave={() => setAim(null)}
      >
        <img ref={imageRef} src={imageUrl} alt="Calibrage" className="block"
          style={{ maxHeight: '60vh', width: 'auto', touchAction: 'none' }}
          draggable={false} />

        {/* Markers + connection lines — overlay div calé sur l'image (comme PupilMarker) */}
        {imageSize && getImageDisplayRect() && (() => {
          const dr = getImageDisplayRect()
          return (
            <div style={{ position: 'absolute', left: dr.left, top: dr.top, width: dr.width, height: dr.height, zIndex: 10 }}>
              {/* La loupe : pendant la VISÉE, et pendant le glissement d'un repère déjà posé.
                  Aucune échelle n'est encore validée ici → pas de cale 1 mm (on n'afficherait
                  pas un instrument sur une échelle inventée) ; champ resserré à 1,5 %. */}
              <PrecisionLoupe dr={dr} imageSize={imageSize} imageUrl={imageUrl}
                pos={aim?.pos || (dragTarget ? points[dragTarget.index] : null)}
                color={noClipMode ? '#06b6d4' : '#c9a05a'}
                label={dragTarget ? `Repère ${dragTarget.index + 1}`
                  : noClipMode ? 'Sans clip'
                  : `Repère ${Math.min(points.length + 1, 3)}`}
                fallbackPct={1.5}
                reticle={reticleNode(!!dragTarget)} reticleSize={22}
                hint={aim ? 'relâcher' : null} />

              {points.map((p, i) => {
                const leftPct = (p.x / imageSize.width) * 100
                const topPct = (p.y / imageSize.height) * 100
                const isDragging = dragTarget?.index === i
                return (
                  <div key={i} className="absolute transition-none"
                    style={{ left: `${leftPct}%`, top: `${topPct}%`, zIndex: isDragging ? 30 : 10 }}
                    data-markerid={i}>
                    {/* Cible tactile 44 px, centrée sur le point (invisible) */}
                    <div style={{ position: 'absolute', left: 0, top: 0, width: 44, height: 44,
                      transform: 'translate(-50%, -50%)', cursor: 'grab' }} />

                    {/* Le repère est centré SEUL sur le point. Le libellé était dans le même
                        conteneur : le −50 % se calculait alors sur repère + libellé, ce qui
                        dessinait le réticule ~10 px AU-DESSUS de la mesure qu'il représente —
                        on visait un bord de cale et le point enregistré était plus bas. */}
                    <div data-reticle-anchor="1" style={{ position: 'absolute', left: 0, top: 0,
                      transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
                      {reticleNode(isDragging)}
                    </div>

                    {/* Libellé SOUS le point, hors flux : ne participe plus au centrage */}
                    <div data-marker-label="1" className="text-[10px] text-center font-bold tracking-wider px-1 rounded-sm"
                      style={{
                        position: 'absolute', left: 0, top: 14,
                        transform: 'translateX(-50%)', whiteSpace: 'nowrap',
                        color: isDragging ? 'var(--color-gold-light)' : 'var(--color-gold)',
                        opacity: isDragging ? 1 : 0.82,
                        background: 'rgba(10, 10, 12, 0.6)',
                        border: '1px solid rgba(201, 160, 90, 0.22)',
                      }}>
                      {['Gauche','Centre','Droite'][i]}
                    </div>
                  </div>
                )
              })}

              {/* Mires HORS RANGÉE — dessinées, non manipulables.
                  Le trait pointillé les relie entre elles : c'est la base du
                  triangle facial, il rend visible que le clip a bien été vu
                  dans son ensemble et pas seulement sur sa barre. */}
              {infoMarkers.length > 0 && (
                <>
                  {infoMarkers.length === 2 && (
                    <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 4 }}>
                      <line x1={`${(infoMarkers[0].x / imageSize.width) * 100}%`}
                        y1={`${(infoMarkers[0].y / imageSize.height) * 100}%`}
                        x2={`${(infoMarkers[1].x / imageSize.width) * 100}%`}
                        y2={`${(infoMarkers[1].y / imageSize.height) * 100}%`}
                        stroke="var(--color-gold)" strokeOpacity="0.4" strokeWidth="1"
                        strokeDasharray="2 4" />
                    </svg>
                  )}
                  {infoMarkers.map((p, i) => (
                    <div key={`info-${i}`}
                      data-info-marker="1"
                      className="absolute transform -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${(p.x / imageSize.width) * 100}%`,
                               top: `${(p.y / imageSize.height) * 100}%`,
                               zIndex: 18, pointerEvents: 'none' }}>
                      {/* MÊME COULEUR, FORME DIFFÉRENTE : anneau POINTILLÉ, plus fin,
                          sans croix. Une mire haute est VUE, elle n'est pas manipulable —
                          la forme le dit sans introduire une troisième couleur. */}
                      <svg width="20" height="20" viewBox="0 0 20 20" className="mx-auto block"
                        style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.6))' }}>
                        <circle cx="10" cy="10" r="7" fill="none" stroke="var(--color-gold)"
                          strokeWidth="1.4" strokeDasharray="3 2.6" strokeOpacity="0.72" />
                        <circle cx="10" cy="10" r="1.5" fill="var(--color-gold)" fillOpacity="0.72" />
                      </svg>
                      <div className="text-[9px] text-center font-medium tracking-wide"
                        style={{ color: 'var(--color-gold)', opacity: 0.62, whiteSpace: 'nowrap',
                                 textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
                        haute
                      </div>
                    </div>
                  ))}
                </>
              )}

              {/* Connection lines */}
              {points.length >= 2 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
                  <line x1={`${(points[0].x / imageSize.width) * 100}%`}
                    y1={`${(points[0].y / imageSize.height) * 100}%`}
                    x2={`${(points[1].x / imageSize.width) * 100}%`}
                    y2={`${(points[1].y / imageSize.height) * 100}%`}
                    stroke="var(--color-gold)" strokeOpacity="0.45" strokeWidth="1"
                    strokeDasharray="2 4" />
                  {points.length === 3 && (
                    <line x1={`${(points[1].x / imageSize.width) * 100}%`}
                      y1={`${(points[1].y / imageSize.height) * 100}%`}
                      x2={`${(points[2].x / imageSize.width) * 100}%`}
                      y2={`${(points[2].y / imageSize.height) * 100}%`}
                      stroke="rgba(255, 255, 255, 0.7)" strokeWidth="1.2" strokeDasharray="3 3" />
                  )}
                </svg>
              )}
            </div>
          )
        })()}

        {/* Points « sans clip » (2 points) — rendus dans la même zone image */}
        {noClipMode && imageSize && getImageDisplayRect() && (() => {
          const dr = getImageDisplayRect()
          return (
            <div style={{ position: 'absolute', left: dr.left, top: dr.top, width: dr.width, height: dr.height, zIndex: 20 }}>
              {noClipPoints.map((p, i) => {
                const leftPct = (p.x / imageSize.width) * 100
                const topPct = (p.y / imageSize.height) * 100
                return (
                  <div key={i} className="absolute transform -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${leftPct}%`, top: `${topPct}%`, zIndex: 20 }}>
                    <svg width="22" height="22" viewBox="0 0 22 22" className="mx-auto block"
                      style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.5))' }}>
                      <circle cx="11" cy="11" r="9" fill="none" stroke="var(--color-gold)" strokeWidth="2" />
                      <circle cx="11" cy="11" r="2.5" fill="var(--color-gold)" />
                    </svg>
                    <div className="text-[10px] text-center mt-1 font-bold px-1 rounded-sm"
                      style={{ color: 'var(--color-gold)', background: 'rgba(10,10,12,0.6)' }}>
                      {i === 0 ? 'Pt 1' : 'Pt 2'}
                    </div>
                  </div>
                )
              })}
              {noClipPoints.length === 2 && (
                <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 5 }}>
                  <line x1={`${(noClipPoints[0].x / imageSize.width) * 100}%`}
                    y1={`${(noClipPoints[0].y / imageSize.height) * 100}%`}
                    x2={`${(noClipPoints[1].x / imageSize.width) * 100}%`}
                    y2={`${(noClipPoints[1].y / imageSize.height) * 100}%`}
                    stroke="var(--color-gold)" strokeOpacity="0.55" strokeWidth="1.2"
                    strokeDasharray="4 3" />
                </svg>
              )}
            </div>
          )
        })()}

        {/* Guide hint */}
        {!allPlaced && (
          <div className="absolute bottom-3 left-0 right-0 text-center pointer-events-none" style={{ zIndex: 50 }}>
            <span className="inline-block px-3 py-1.5 rounded-full text-xs font-medium"
              style={{ background: 'rgba(0,0,0,0.7)', color: '#ccc', border: '1px solid rgba(255,255,255,0.1)' }}>
              {points.length === 0 ? '① Repère GAUCHE' :
               points.length === 1 ? '② Repère CENTRE' :
               '③ Repère DROITE'}
            </span>
          </div>
        )}

      </div>

      {/* BANDE DE MESURES — les grandeurs vivantes se LISENT au lieu d'être
          devinées dans une puce de pied de page. Le libellé est au-dessus de la
          valeur, en petites capitales : trois colonnes de largeur égale, chiffres
          tabulaires pour qu'ils ne dansent pas d'un rendu à l'autre. */}
      {allPlaced && debugInfo && !autoFailed && (
        <div className="flex border-t" style={{ borderColor: 'var(--color-border)' }}>
          <div className="flex-1 px-3 py-2 text-center" style={{ borderRight: '1px solid var(--color-border)' }}>
            <div className="text-[8px] tracking-[0.12em] uppercase" style={{ color: 'var(--color-text-dim)' }}>écart</div>
            <div className="text-xs font-semibold mt-0.5" style={{ color: 'var(--color-gold)' }}>{markerSpacing},0 mm</div>
          </div>
          <div className="flex-1 px-3 py-2 text-center" style={{ borderRight: '1px solid var(--color-border)' }}>
            <div className="text-[8px] tracking-[0.12em] uppercase" style={{ color: 'var(--color-text-dim)' }}>échelle</div>
            <div className="text-xs font-semibold mt-0.5" style={{ color: 'var(--color-text)' }}>
              {debugInfo.scalePxToMm ? debugInfo.scalePxToMm.toFixed(4) : '—'}
            </div>
          </div>
          <div className="flex-1 px-3 py-2 text-center">
            <div className="text-[8px] tracking-[0.12em] uppercase" style={{ color: 'var(--color-text-dim)' }}>roulis</div>
            <div className="text-xs font-semibold mt-0.5"
              style={{ color: Math.abs(debugInfo.clipRollDeg ?? 0) > 2 ? 'var(--color-red)' : 'var(--color-text)' }}>
              {debugInfo.clipRollDeg != null ? `${debugInfo.clipRollDeg.toFixed(1)}°` : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Spacing + reset + debug */}
      <div className="px-4 py-2 flex justify-between items-center border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => { setShowSpacingInput(!showSpacingInput); setNoClipMode(false) }}
            className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-gold)' }}>
            <Settings2 size={12} /> Écart : {markerSpacing} mm
          </button>
          <button onClick={() => { setNoClipMode(!noClipMode); setShowSpacingInput(false); setNoClipPoints([]) }}
            className={`flex items-center gap-1 text-xs transition-all hover:opacity-80 ${noClipMode ? 'font-bold' : ''}`}
            style={{ color: noClipMode ? 'var(--color-red)' : 'var(--color-text-muted)' }}>
            <Ruler size={12} /> Pas de clip
          </button>
          {/* La valeur mm/px a migré dans la bande de mesures ci-dessus. */}
        </div>
        {points.length > 0 && (
          <button onClick={resetPoints} className="flex items-center gap-1 text-xs transition-all hover:opacity-80" style={{ color: 'var(--color-gold)' }}>
            <RotateCcw size={12} /> Recommencer
          </button>
        )}
      </div>

      {showSpacingInput && (
        <div className="px-4 py-2 flex items-center gap-2 border-t" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Écart entre repères :</span>
          <input type="number" value={markerSpacing} onChange={e => setMarkerSpacing(Number(e.target.value) || 50)}
            className="w-16 px-2 py-1 rounded text-xs text-center border"
            style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }} />
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>mm</span>
        </div>
      )}

      {/* Validation clip standard */}
      {allPlaced && (
        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={confirmCalibration}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-full font-medium text-sm transition-all hover:opacity-90"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
          >
            <Check size={16} /> Valider la calibration ({markerSpacing}mm × 2)
          </button>
        </div>
      )}

      {/* Validation « sans clip » — 2 points + distance réelle connue */}
      {noClipMode && noClipPoints.length === 2 && (
        <div className="px-4 py-3 border-t space-y-2" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Distance réelle entre les 2 points :</span>
            <input type="number" value={noClipKnownMm} onChange={e => setNoClipKnownMm(Number(e.target.value) || 0)}
              className="w-16 px-2 py-1 rounded text-xs text-center border"
              style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)', color: 'var(--color-text)' }} />
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>mm</span>
          </div>
          <button
            onClick={() => {
              const scaleData = calibrateFromKnownDistance(noClipPoints, noClipKnownMm)
              if (scaleData) onCalibrated(scaleData)
            }}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-full font-medium text-sm transition-all hover:opacity-90"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
          >
            <Ruler size={16} /> Valider l'étalon sans clip
          </button>
          <p className="text-[10px] text-center" style={{ color: 'var(--color-text-dim)' }}>
            Placez 2 points sur une dimension connue (largeur de monture, DP connue, objet de référence)
          </p>
        </div>
      )}

      {/* Debug info */}
      {debugInfo && (
        <div className="px-4 py-3 space-y-1 text-xs border-t" style={{ background: 'var(--color-bg)', borderColor: 'var(--color-border)' }}>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Distance (Gauche ➔ Centre) :</span>
            <span style={{ color: 'var(--color-text-dim)' }}>{debugInfo.pixelDist1} px</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Distance (Centre ➔ Droite) :</span>
            <span style={{ color: 'var(--color-text-dim)' }}>{debugInfo.pixelDist2} px</span>
          </div>
          <div className="flex justify-between font-medium">
            <span style={{ color: 'var(--color-text-muted)' }}>Échelle active :</span>
            <span style={{ color: 'var(--color-gold)' }}>1 px = {Math.round(debugInfo.scalePxToMm * 1000) / 1000} mm</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--color-text-muted)' }}>Alignement tête (Symétrie) :</span>
            <span style={{ color: debugInfo.headRotation > 10 ? 'var(--color-red)' : 'var(--color-green)' }}>
              {debugInfo.poseAssessment}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function calculateScale(points, spacing = 50) {
  // Calcul de la distance géométrique directe entre le repère Gauche (0) et le repère Droite (2)
  const dTotal = Math.hypot(points[2].x - points[0].x, points[2].y - points[0].y)
  
  // L'échelle absolue en mm/pixel calculée sur les 100mm totaux du clip (spacing * 2)
  const totalSpacingMm = spacing * 2
  const finalScale = totalSpacingMm / dTotal

  // Pour l'analyse de symétrie (rotation ou inclinaison de la tête du patient)
  const d1 = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) // gauche -> centre
  const d2 = Math.hypot(points[2].x - points[1].x, points[2].y - points[1].y) // centre -> droite
  const ratio = Math.abs(d1 - d2) / ((d1 + d2) / 2)
  const headRotationAngle = Math.round(ratio * 100)

  // Qualité de centrage basée sur la symétrie
  let poseAssessment = 'Excellente (Centrage 100%)'
  if (headRotationAngle > 4) poseAssessment = 'Bonne (Légère inclinaison ' + headRotationAngle + '%)'
  if (headRotationAngle > 10) poseAssessment = 'Correction requise (Tête tournée à ' + headRotationAngle + '%)'

  return {
    scalePxToMm: finalScale,
    pixelDist1: Math.round(d1),
    pixelDist2: Math.round(d2),
    scaleVariation: 0, // Option chirurgicale demandée : 0% d'erreur sur l'échelle de mesure
    headRotation: headRotationAngle,
    poseAssessment: poseAssessment,
    totalSpanMm: totalSpacingMm
  }
}
