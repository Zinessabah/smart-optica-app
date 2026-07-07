import { useRef, useState, useCallback } from 'react'
import { Camera, RefreshCw, X } from 'lucide-react'

export default function Webcam({ onCapture, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState(null)
  const [facingMode, setFacingMode] = useState('environment')

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
  }, [onCapture, stopCamera, facingMode])

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
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-48 h-48 rounded-full border-2 border-dashed opacity-30" style={{ borderColor: 'var(--color-gold)' }} />
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
