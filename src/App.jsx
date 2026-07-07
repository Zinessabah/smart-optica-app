import { useState, useCallback } from 'react'
import { Camera, Upload, Ruler, CheckCircle2, ChevronLeft, RotateCcw } from 'lucide-react'
import PhotoPicker from './PhotoPicker'
import CalibrationOverlay from './CalibrationOverlay'
import PupilMarker from './PupilMarker'
import ResultCard from './ResultCard'

const STEPS = [
  { key: 'photo',       label: 'Photo',        icon: Camera },
  { key: 'calibrate',   label: 'Calibration',   icon: Ruler },
  { key: 'pupils',      label: 'Centrage',      icon: Ruler },
  { key: 'result',      label: 'Résultat',      icon: CheckCircle2 },
]

export default function App() {
  const [step, setStep] = useState('photo')
  const [measurements, setMeasurements] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [calibration, setCalibration] = useState(null)

  const stepIndex = STEPS.findIndex(s => s.key === step)

  const handleCapture = useCallback((imageUrl) => {
    setImageData(imageUrl)
    setStep('calibrate')
  }, [])

  const handleCalibrated = useCallback((scale) => {
    setCalibration(scale)
    setStep('pupils')
  }, [])

  const handleSkipCalibration = useCallback(() => {
    setCalibration(null)
    setStep('pupils')
  }, [])

  const handlePupilsConfirmed = useCallback((data) => {
    setMeasurements(data)
    setStep('result')
  }, [])

  const handleBackToCalibrate = useCallback(() => {
    setStep('calibrate')
  }, [])

  const handleRetake = () => {
    setStep('photo')
    setMeasurements(null)
    setImageData(null)
    setCalibration(null)
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--color-bg)' }}>
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 border-b" style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)', backdropFilter: 'blur(12px)' }}>
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, var(--color-gold), var(--color-gold-dark))' }}>
              <span className="text-[var(--color-bg)] font-bold text-xs">SO</span>
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
                Smart Optica
              </h1>
              <p className="text-[10px] tracking-wider uppercase" style={{ color: 'var(--color-gold)' }}>
                Centrage Digital
              </p>
            </div>
          </div>

          {/* Step badge */}
          <div className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
            {STEPS[stepIndex].label}
          </div>
        </div>

        {/* Step indicator */}
        <div className="max-w-2xl mx-auto px-4 pb-2.5">
          <div className="flex items-center gap-1.5">
            {STEPS.map((s, i) => {
              const StepIcon = s.icon
              const isActive = i === stepIndex
              const isDone = i < stepIndex
              const isFuture = i > stepIndex
              return (
                <div key={s.key} className="flex-1 flex items-center gap-1.5 min-w-0">
                  <div
                    className="flex items-center gap-1.5 px-2 py-1 rounded-full transition-all duration-200"
                    style={{
                      background: isActive ? 'var(--color-gold-bg)' : isDone ? 'var(--color-green-bg)' : 'transparent',
                      border: isActive ? '1px solid var(--color-gold)' : isDone ? '1px solid var(--color-green)' : '1px solid var(--color-border)',
                      opacity: isFuture ? 0.4 : 1,
                    }}
                  >
                    {isDone ? (
                      <CheckCircle2 size={12} style={{ color: 'var(--color-green)' }} />
                    ) : (
                      <StepIcon size={12} style={{ color: isActive ? 'var(--color-gold)' : 'var(--color-text-dim)' }} />
                    )}
                    <span className="text-[10px] font-medium leading-none hidden sm:inline" style={{
                      color: isActive ? 'var(--color-gold)' : isDone ? 'var(--color-green)' : 'var(--color-text-dim)',
                    }}>
                      {s.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div
                      className="flex-1 h-px min-w-[8px]"
                      style={{ background: isDone ? 'var(--color-green)' : 'var(--color-border)' }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
        {step === 'photo' && (
          <div className="space-y-5">
            <div className="text-center">
              <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
                Mesure de Distance Pupillaire
              </h2>
              <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                Prenez une photo du visage avec la monture de référence
              </p>
            </div>
            <PhotoPicker onCapture={handleCapture} onCancel={handleRetake} />
          </div>
        )}

        {step === 'calibrate' && imageData && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-1 h-8 rounded-full shrink-0" style={{ background: 'linear-gradient(to bottom, var(--color-gold), var(--color-gold-light))' }} />
              <div>
                <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
                  Calibration
                </h2>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  Placez les 3 repères espacés de 5 cm
                </p>
              </div>
            </div>
            <CalibrationOverlay
              imageUrl={imageData}
              onCalibrated={handleCalibrated}
              onSkip={handleSkipCalibration}
              onRetake={handleRetake}
            />
          </div>
        )}

        {step === 'pupils' && imageData && (
          <PupilMarker
            imageUrl={imageData}
            calibration={calibration}
            onConfirm={handlePupilsConfirmed}
            onBack={handleBackToCalibrate}
            onRetake={handleRetake}
          />
        )}

        {step === 'result' && measurements && (
          <ResultCard
            measurements={measurements}
            imageUrl={imageData}
            onRetake={handleRetake}
          />
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="text-center py-6 text-[10px]" style={{ color: 'var(--color-text-dim)' }}>
        Smart Optica © 2026 · Mesure DP de précision
      </footer>
    </div>
  )
}
