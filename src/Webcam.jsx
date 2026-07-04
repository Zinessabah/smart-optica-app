import { useRef, useState, useCallback } from 'react'

export default function Webcam({ onCapture, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [facingMode, setFacingMode] = useState('environment') // default: rear camera

  const startCamera = useCallback(async (mode) => {
    try {
      // Stop any existing stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      setError(null)
      const targetMode = mode || facingMode
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: targetMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
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
    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    // Rear camera: no mirror. Front camera: mirror for natural selfie.
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.95)
    onCapture(url)
    stopCamera()
  }, [onCapture, stopCamera, facingMode])

  const isRear = facingMode === 'environment'

  return (
    <div className="rounded-2xl overflow-hidden shadow-lg" style={{ background: '#fff' }}>
      {/* Video / Placeholder */}
      <div className="relative aspect-[4/3]" style={{ background: '#1a1a1a' }}>
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
            <svg className="w-16 h-16 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1}
                d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <p className="text-sm opacity-60">Appuyez pour activer la caméra arrière</p>
          </div>
        )}
        {/* Face guide overlay */}
        {streaming && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-48 h-48 rounded-full border-2 border-dashed opacity-40"
              style={{ borderColor: '#c9975a' }} />
          </div>
        )}

        {/* Camera mode badge */}
        {streaming && (
          <div className="absolute top-3 right-3 px-2 py-1 rounded-full text-[10px] font-medium"
            style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}>
            {isRear ? '📷 Arrière' : '🤳 Selfie'}
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 text-sm text-red-600 bg-red-50 border-t border-red-100">
          {error}
        </div>
      )}

      {/* Controls */}
      <div className="px-4 py-3 flex justify-center gap-3">
        {!streaming ? (
          <button
            onClick={() => startCamera()}
            className="px-6 py-2.5 rounded-full text-white font-medium text-sm transition-all hover:opacity-90"
            style={{ background: '#c9975a' }}
          >
            Activer la caméra arrière
          </button>
        ) : (
          <>
            <button
              onClick={toggleCamera}
              className="px-4 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-80"
              style={{ background: '#f0ede7', color: '#666' }}
              title={isRear ? 'Passer en selfie' : 'Passer en caméra arrière'}
            >
              🔄 {isRear ? 'Selfie' : 'Arrière'}
            </button>
            <button
              onClick={capture}
              className="px-8 py-2.5 rounded-full text-white font-medium text-sm transition-all hover:opacity-90"
              style={{ background: '#c9975a' }}
            >
              📸 Capturer
            </button>
            {onCancel && (
              <button
                onClick={() => { stopCamera(); onCancel() }}
                className="px-4 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-80"
                style={{ background: '#f5e5e5', color: '#c44' }}
              >
                ✕ Annuler
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
