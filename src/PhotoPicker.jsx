import { useState, useRef, useCallback } from 'react'
import { Camera, Upload, ArrowLeft } from 'lucide-react'
import Webcam from './Webcam'

export default function PhotoPicker({ onCapture }) {
  const [mode, setMode] = useState(null)
  const fileInputRef = useRef(null)

  const handleFileSelected = useCallback((e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onCapture(ev.target.result)
    reader.readAsDataURL(file)
  }, [onCapture])

  if (mode === 'camera') {
    return <Webcam onCapture={onCapture} onCancel={() => setMode(null)} />
  }

  if (mode === 'upload') {
    return (
      <div className="rounded-2xl border overflow-hidden animate-fade-in" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div
          className="flex flex-col items-center justify-center py-16 px-6 cursor-pointer select-none"
          style={{ minHeight: 240 }}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Upload size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <p className="text-base font-medium mb-1" style={{ color: 'var(--color-text)' }}>
            Télécharger une photo
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Photo du visage avec la monture de référence
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelected}
          />
          <button
            className="mt-5 px-6 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-90 cursor-pointer"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click() }}
          >
            Choisir une image
          </button>
        </div>
        <div className="px-4 py-3 flex justify-center border-t" style={{ borderColor: 'var(--color-border)' }}>
          <button
            onClick={() => setMode(null)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full font-medium text-sm transition-all hover:opacity-80"
            style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}
          >
            <ArrowLeft size={14} /> Retour
          </button>
        </div>
      </div>
    )
  }

  // Mode selection screen
  return (
    <div className="space-y-4 animate-fade-in">
      {/* Camera option */}
      <div
        className="rounded-2xl border overflow-hidden cursor-pointer select-none transition-all hover:border-[var(--color-gold)] hover:shadow-lg hover:shadow-[var(--color-gold)]/5"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        onClick={() => setMode('camera')}
      >
        <div className="flex flex-col items-center py-12 px-6" style={{ minHeight: 180 }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Camera size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>
            Prendre une photo
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Utiliser la caméra arrière
          </p>
        </div>
      </div>

      {/* Upload option */}
      <div
        className="rounded-2xl border overflow-hidden cursor-pointer select-none transition-all hover:border-[var(--color-gold)] hover:shadow-lg hover:shadow-[var(--color-gold)]/5"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        onClick={() => setMode('upload')}
      >
        <div className="flex flex-col items-center py-12 px-6" style={{ minHeight: 180 }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Upload size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>
            Télécharger une photo
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Depuis la galerie ou les fichiers
          </p>
        </div>
      </div>
    </div>
  )
}
