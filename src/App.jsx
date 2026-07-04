import { useState, useCallback } from 'react'
import Webcam from './Webcam'
import CalibrationOverlay from './CalibrationOverlay'
import PupilMarker from './PupilMarker'
import ResultCard from './ResultCard'

export default function App() {
  const [step, setStep] = useState('photo') // photo | calibrate | pupils | result
  const [measurements, setMeasurements] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [calibration, setCalibration] = useState(null)

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

  const stepLabel = {
    photo: 'Mesure DP',
    calibrate: 'Calibration',
    pupils: 'Centrage',
    result: 'Résultat',
  }

  return (
    <div className="min-h-screen" style={{ background: '#faf9f6' }}>
      {/* Header */}
      <header className="px-6 py-4 flex items-center justify-between border-b" style={{ borderColor: '#e8e6e0' }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #c9975a, #a67c3a)' }}>
            <span className="text-white font-bold text-lg">S</span>
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight" style={{ color: '#2d2d2d', fontFamily: 'Georgia, serif' }}>
              Smart Optica
            </h1>
            <p className="text-xs tracking-wider uppercase" style={{ color: '#c9975a' }}>
              Centrage Digital
            </p>
          </div>
        </div>
        <div className="text-xs" style={{ color: '#999' }}>
          {stepLabel[step]}
        </div>
      </header>

      {/* Main */}
      <main className="max-w-2xl mx-auto px-4 py-6">
        {step === 'photo' && (
          <div className="space-y-4">
            <div className="text-center mb-2">
              <h2 className="text-2xl font-semibold mb-1" style={{ color: '#2d2d2d', fontFamily: 'Georgia, serif' }}>
                Mesure de Distance Pupillaire
              </h2>
              <p className="text-sm" style={{ color: '#888' }}>
                Positionnez le visage du client avec la monture de référence et prenez une photo
              </p>
            </div>
            <Webcam onCapture={handleCapture} onCancel={handleRetake} />
          </div>
        )}

        {step === 'calibrate' && imageData && (
          <div className="space-y-4">
            <div className="text-center mb-2">
              <h2 className="text-xl font-semibold mb-1" style={{ color: '#2d2d2d', fontFamily: 'Georgia, serif' }}>
                Calibration — Monture de référence
              </h2>
              <p className="text-sm" style={{ color: '#888' }}>
                Touchez les 3 repères espacés de 5 cm pour une précision clinique
              </p>
            </div>
            <CalibrationOverlay
              imageUrl={imageData}
              onCalibrated={handleCalibrated}
              onSkip={handleSkipCalibration}
            />
          </div>
        )}

        {step === 'pupils' && imageData && (
          <PupilMarker
            imageUrl={imageData}
            calibration={calibration}
            onConfirm={handlePupilsConfirmed}
            onBack={handleBackToCalibrate}
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

      {/* Footer */}
      <footer className="text-center py-4 text-xs" style={{ color: '#bbb' }}>
        Smart Optica © 2026 · Mesure DP de précision
      </footer>
    </div>
  )
}
