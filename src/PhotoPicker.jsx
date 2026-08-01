import { useState, useRef, useCallback } from 'react'
import { Camera, Upload, ArrowLeft, AlertTriangle } from 'lucide-react'
import Webcam from './Webcam'

export default function PhotoPicker({ onCapture, onCancel, initialMode }) {
  const [mode, setMode] = useState(initialMode || null) // null=sélection, 'camera', 'upload'
  const [error, setError] = useState(null)
  const fileInputRef = useRef(null)

  const readFile = useCallback((file) => {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('Fichier non valide'))
      const reader = new FileReader()
      reader.onload = (ev) => resolve(ev.target.result)
      reader.onerror = () => reject(new Error('Lecture impossible'))
      reader.readAsDataURL(file)
    })
  }, [])

  const handleFileSelected = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const dataUrl = await readFile(file)
      onCapture(dataUrl)
    } catch (err) {
      setError(err.message)
    }
    e.target.value = ''
  }, [onCapture, readFile])

  // Webcam
  if (mode === 'camera') {
    return <Webcam onCapture={(url) => onCapture(url)} onCancel={onCancel || (() => setMode(null))} />
  }

  // Upload depuis fichiers
  if (mode === 'upload') {
    return (
      <div className="rounded-2xl border overflow-hidden animate-fade-in" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div className="flex flex-col items-center justify-center py-16 px-6 cursor-pointer select-none" style={{ minHeight: 240 }}
          onClick={() => fileInputRef.current?.click()}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Upload size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <p className="text-base font-medium mb-1" style={{ color: 'var(--color-text)' }}>Télécharger une photo</p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Photo du visage avec la monture de référence</p>
          {error && (
            <div className="rounded-xl px-3 py-2 mt-3 flex items-start gap-2 text-xs w-full max-w-sm"
              style={{ background: 'var(--color-red-bg)', color: 'var(--color-red)', borderColor: 'rgba(255,107,107,0.25)' }}>
              <AlertTriangle size={12} className="shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelected} />
          <button className="mt-5 px-6 py-2.5 rounded-full font-medium text-sm transition-all hover:opacity-90 cursor-pointer"
            style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}
            onClick={(e) => { e.stopPropagation(); setError(null); fileInputRef.current?.click() }}>
            {error ? 'Réessayer' : 'Choisir une image'}
          </button>
        </div>
        <div className="px-4 py-3 flex justify-center border-t" style={{ borderColor: 'var(--color-border)' }}>
          <button onClick={() => setMode(null)} className="flex items-center gap-1.5 px-4 py-2 rounded-full font-medium text-sm transition-all hover:opacity-80"
            style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            <ArrowLeft size={14} /> Retour
          </button>
        </div>
      </div>
    )
  }

  // Écran de sélection (mode = null)
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="rounded-2xl border overflow-hidden cursor-pointer select-none transition-all hover:border-[var(--color-gold)]"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        onClick={() => setMode('camera')}>
        <div className="flex flex-col items-center py-12 px-6" style={{ minHeight: 180 }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Camera size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Prendre une photo</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Caméra avec guide visuel</p>
        </div>
      </div>
      <div className="rounded-2xl border overflow-hidden cursor-pointer select-none transition-all hover:border-[var(--color-gold)]"
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        onClick={() => setMode('upload')}>
        <div className="flex flex-col items-center py-12 px-6" style={{ minHeight: 180 }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Upload size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <p className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Télécharger une photo</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Depuis la galerie ou les fichiers</p>
        </div>
      </div>
    </div>
  )
}
