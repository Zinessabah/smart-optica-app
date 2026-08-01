import { useRef, useState, useCallback, useEffect } from 'react'
import { Camera, RefreshCw, X, CheckCircle2, AlertTriangle } from 'lucide-react'

export default function Webcam({ onCapture, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [facingMode, setFacingMode] = useState('environment')
  const [faceStatus, setFaceStatus] = useState(null) // null | 'checking' | 'ok' | 'bad'
  const checkIntervalRef = useRef(null)

  // Vérification périodique de la présence d'un visage
  const checkFace = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    try {
      if (typeof window.FaceDetector === 'undefined') {
        setFaceStatus(null) // API non dispo → pas de check
        return
      }
      setFaceStatus('checking')
      const detector = new window.FaceDetector({ maxDetectedFaces: 1, fastMode: true })
      const faces = await detector.detect(video)
      if (faces.length > 0) {
        const f = faces[0]
        const box = f.boundingBox
        // Vérifie que le visage couvre 10-50% de l'image et n'est pas trop excentré
        const area = (box.width * box.height) / (video.videoWidth * video.videoHeight)
        const cx = (box.x + box.width / 2) / video.videoWidth
        const cy = (box.y + box.height / 2) / video.videoHeight
        if (area > 0.08 && area < 0.55 && cx > 0.25 && cx < 0.75 && cy > 0.2 && cy < 0.7) {
          setFaceStatus('ok')
        } else {
          setFaceStatus('bad')
        }
      } else {
        setFaceStatus('bad')
      }
    } catch {
      setFaceStatus(null)
    }
  }, [])

  // Lance la vérification périodique quand la caméra est active
  useEffect(() => {
    if (!streaming) {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current)
        checkIntervalRef.current = null
      }
      setFaceStatus(null)
      return
    }
    // Première vérification après 500ms (laisse le temps au flux de démarrer)
    const t1 = setTimeout(() => checkFace(), 500)
    // Puis toutes les 2s
    checkIntervalRef.current = setInterval(checkFace, 2000)
    return () => {
      clearTimeout(t1)
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current)
        checkIntervalRef.current = null
      }
    }
  }, [streaming, checkFace])

  const startCamera = useCallback(async (mode) => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      setError(null)
      const targetMode = mode || facingMode
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: targetMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      videoRef.current.srcObject = stream
      streamRef.current = stream
      setFacingMode(targetMode)
      setStreaming(true)
    } catch (err) {
      setError("Impossible d'accéder à la caméra. Vérifiez les permissions.")
      console.error(err)
    }
  }, [facingMode])

  const toggleCamera = useCallback(() => {
    const newMode = facingMode === 'environment' ? 'user' : 'environment'
    startCamera(newMode)
  }, [facingMode, startCamera])

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    setStreaming(false)
  }, [])

  const capture = useCallback(() => {
    if (!videoRef.current) return
    // Vérification rapide : si FaceDetector disponible et visage mal positionné
    if (faceStatus === 'bad') {
      setError("Aucun visage détecté dans le cadre. Ajustez la position et réessayez.")
      return
    }
    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.95)
    onCapture(url)
    stopCamera()
  }, [onCapture, stopCamera, facingMode, faceStatus])

  const isRear = facingMode === 'environment'

  return (
    <div className="rounded-2xl border overflow-hidden animate-fade-in" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
      <div className="relative aspect-[4/3]" style={{ background: '#08080a' }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{
            display: streaming ? 'block' : 'none',
            transform: facingMode === 'user' ? 'scaleX(-1)' : 'none',
          }}
        />
        {!streaming && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white gap-4">
            <Camera size={48} className="opacity-20" />
            <p className="text-sm opacity-40">Activez la caméra pour commencer</p>
          </div>
        )}
        {streaming && (
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>
            {/* Cadre visage (ovale) */}
            <svg className="absolute inset-0 w-full h-full">
              <ellipse cx="50%" cy="44%" rx="28%" ry="34%"
                fill="none" stroke="rgba(201,160,90,0.15)" strokeWidth="1.5" strokeDasharray="6 4" />

              {/* Niveau à bulle — horizontale */}
              <line x1="15%" y1="38%" x2="85%" y2="38%"
                stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeDasharray="4 3" />
              {/* Bulle centrale */}
              <circle cx="50%" cy="38%" r="4" fill="rgba(201,160,90,0.6)" />
              <circle cx="50%" cy="38%" r="1.5" fill="#fff" />

              {/* Axe vertical (nez) — doublé pour contraste */}
              <line x1="50%" y1="8%" x2="50%" y2="82%"
                stroke="rgba(0,255,127,0.5)" strokeWidth="1.5" strokeDasharray="4 3" />
              <line x1="49.5%" y1="8%" x2="49.5%" y2="82%"
                stroke="rgba(255,255,255,0.3)" strokeWidth="1" strokeDasharray="4 3" />

              {/* Zone clip calibration (au-dessus des yeux) */}
              <rect x="25%" y="18%" width="50%" height="12%" rx="4"
                fill="rgba(201,160,90,0.15)" stroke="rgba(201,160,90,0.6)" strokeWidth="1.5" strokeDasharray="5 3" />
            </svg>

            {/* Bordure lumineuse cadre — statut visage */}
            <div style={{
              position: 'absolute', inset: 0,
              border: '3px solid',
              borderColor: faceStatus === 'ok' ? 'rgba(34,197,94,0.6)' : faceStatus === 'bad' ? 'rgba(255,107,107,0.5)' : 'transparent',
              borderRadius: 4,
              transition: 'border-color 0.3s ease',
            }} />

            {/* Texte guide + statut visage */}
            <div className="absolute inset-x-0 bottom-4 flex justify-center">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-medium"
                style={{ background: 'rgba(0,0,0,0.7)', color: faceStatus === 'ok' ? 'var(--color-green)' : faceStatus === 'bad' ? 'var(--color-red)' : 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.1)' }}>
                {faceStatus === 'ok' && <CheckCircle2 size={10} />}
                {faceStatus === 'bad' && <AlertTriangle size={10} />}
                {faceStatus === 'ok' ? '✅ Visage détecté' :
                 faceStatus === 'bad' ? '⚠️ Aucun visage — Ajustez le cadre' :
                 'Alignez le visage dans le cadre · Placez le clip de calibration'}
              </span>
            </div>
          </div>
        )}
        {streaming && (
          <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[10px] font-medium"
            style={{ background: 'rgba(0,0,0,0.7)', color: 'var(--color-text-muted)', border: '1px solid var(--color-border)' }}>
            {isRear ? 'Arrière' : 'Selfie'}
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm border-t" style={{ color: 'var(--color-red)', background: 'var(--color-red-bg)', borderColor: 'var(--color-border)' }}>
          {error}
        </div>
      )}

      <div className="px-4 py-3 flex justify-center gap-3">
        {!streaming ? (
          <button
            onClick={() => startCamera()}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-90"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
          >
            <Camera size={16} /> Activer la caméra
          </button>
        ) : (
          <>
            <button
              onClick={toggleCamera}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-80"
              style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}
            >
              <RefreshCw size={14} /> {isRear ? 'Selfie' : 'Arrière'}
            </button>
            <button
              onClick={capture}
              className="flex items-center gap-1.5 px-8 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-90"
              style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
            >
              <Camera size={16} /> Capturer
            </button>
            {onCancel && (
              <button
                onClick={() => { stopCamera(); onCancel() }}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-80"
                style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)' }}
              >
                <X size={14} /> Annuler
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
