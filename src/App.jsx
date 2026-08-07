import { useState, useCallback, useEffect } from 'react'
import { Ruler, Camera, Upload } from 'lucide-react'
import PhotoPicker from './PhotoPicker'
import ProfileMeasure from './ProfileMeasure'
import CalibrationOverlay from './CalibrationOverlay'
import PupilMarker from './PupilMarker'
import ResultCard from './ResultCard'
import { analyzeImage, checkHealth } from './services/api'

// ── Écran d'accueil simplifié ──
function HomeScreen({ onStart }) {
  const card = "flex flex-col items-center rounded-2xl border cursor-pointer transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
  return (
    <div className="space-y-4 animate-fade-in">
      <div className="text-center space-y-1 mb-2">
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
          Smart Optica
        </h1>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Centrage digital de précision
        </p>
      </div>

      <button onClick={() => onStart('camera')} className={card}
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div className="flex flex-col items-center py-12 px-6" style={{ minHeight: 180 }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Camera size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <span className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Prendre 2 photos</span>
          <span className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Face + Profil avec l'appareil</span>
        </div>
      </button>

      <button onClick={() => onStart('upload')} className={card}
        style={{ background: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
        <div className="flex flex-col items-center py-12 px-6" style={{ minHeight: 180 }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--color-gold-bg)' }}>
            <Upload size={28} style={{ color: 'var(--color-gold)' }} />
          </div>
          <span className="text-base font-medium" style={{ color: 'var(--color-text)' }}>Télécharger 2 photos</span>
          <span className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Face + Profil depuis la galerie</span>
        </div>
      </button>
    </div>
  )
}

export default function App() {
  const [step, setStep] = useState('home')
  const [photoSource, setPhotoSource] = useState(null) // 'camera' | 'upload'
  const [measurements, setMeasurements] = useState(null)
  const [imageData, setImageData] = useState(null)
  const [profileImageUrl, setProfileImageUrl] = useState(null)
  const [calibration, setCalibration] = useState(null)
  const [faceData, setFaceData] = useState(null)
  const [serverConnected, setServerConnected] = useState(false)

  useEffect(() => {
    const check = async () => setServerConnected(await checkHealth())
    check()
    const interval = setInterval(check, 15000)
    return () => clearInterval(interval)
  }, [])

  const handleStart = useCallback((source) => {
    setPhotoSource(source)
    setStep('photo')
  }, [])

  // Photo face → photo latérale (les 2 photos d'abord)
  const handleCapture = useCallback(async (imageUrl) => {
    setImageData(imageUrl)
    setStep('photo-lateral')
    try {
      const blob = await (await fetch(imageUrl)).blob()
      const result = await analyzeImage(blob)
      if (result?.face_detected) setFaceData(result)
    } catch { /* API hors-ligne toléré */ }
  }, [])

  // Photo latérale → calibration
  const handleProfileCapture = useCallback((imageUrl) => {
    setProfileImageUrl(imageUrl)
    setStep('calibrate')
  }, [])

  // Calibration → mesures faciales
  const handleCalibrated = useCallback((scale) => { setCalibration(scale); setStep('pupils') }, [])
  const handleSkipCalibration = useCallback(() => { setCalibration(null); setStep('pupils') }, [])

  // Mesures faciales → mesures latérales
  const handlePupilsConfirmed = useCallback((data) => {
    setMeasurements(data)
    setStep(profileImageUrl ? 'profile-measure' : 'result')
  }, [profileImageUrl])

  // Mesures latérales → résultat
  const handleProfileMeasured = useCallback((profileData) => {
    setMeasurements(prev => prev ? { ...prev, pantoscopicAngle: profileData.pantoscopic_angle, vertexDistance: profileData.vertex_distance } : prev)
    setStep('result')
  }, [])
  const handleProfileSkip = useCallback(() => { setStep('result') }, [])

  // Reset complet
  const handleReset = useCallback(() => {
    setStep('home'); setMeasurements(null); setImageData(null)
    setProfileImageUrl(null); setCalibration(null)
    setFaceData(null); setPhotoSource(null)
  }, [])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/* Header minimal */}
      <header className="sticky top-0 z-30 px-4 py-2.5 flex items-center justify-between"
        style={{ background: 'var(--color-bg)', borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'var(--color-gold)' }}>
            <Ruler size={13} style={{ color: 'var(--color-bg)' }} />
          </div>
          <span className="text-[11px] font-bold tracking-wider uppercase" style={{ color: 'var(--color-text)' }}>
            Smart Optica
          </span>
        </div>
        {step !== 'home' && (
          <span className="flex items-center gap-1 text-[9px] font-mono"
            style={{ color: serverConnected ? 'var(--color-green)' : 'var(--color-red)' }}>
            <span className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: serverConnected ? 'var(--color-green)' : 'var(--color-red)' }} />
            {serverConnected ? 'API' : 'HS'}
          </span>
        )}
      </header>

      <main className={`flex-1 w-full px-4 py-4 animate-fade-in ${step === 'home' ? '' : 'max-w-2xl mx-auto'}`}>
        {step === 'home' && <HomeScreen onStart={handleStart} />}

        {step === 'photo' && (
          <div className="space-y-4">
            <div className="text-center">
              <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
                Photo de FACE
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Patient avec le clip de calibration
              </p>
            </div>
            <PhotoPicker onCapture={handleCapture} onCancel={handleReset} initialMode={photoSource} />
          </div>
        )}

        {step === 'photo-lateral' && (
          <div className="space-y-4">
            <div className="text-center">
              <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
                Photo de PROFIL (côté DROIT)
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Patient de profil — angle pantoscopique & vertex
              </p>
            </div>
            <PhotoPicker onCapture={handleProfileCapture} onCancel={() => setStep('photo')} initialMode={photoSource === 'camera' ? 'camera' : 'upload'} />
          </div>
        )}

        {step === 'calibrate' && imageData && (
          <CalibrationOverlay
            imageUrl={imageData}
            onCalibrated={handleCalibrated}
            onSkip={handleSkipCalibration}
            onRetake={handleReset}
            initialPoints={faceData?.calibration}
          />
        )}

        {step === 'pupils' && imageData && (
          <PupilMarker
            imageUrl={imageData}
            calibration={calibration}
            onConfirm={handlePupilsConfirmed}
            onBack={() => setStep('calibrate')}
            onRetake={handleReset}
            initialLeftEye={faceData?.left_eye}
            initialRightEye={faceData?.right_eye}
            initialBridge={faceData?.nose}
          />
        )}

        {step === 'profile-measure' && profileImageUrl && (
          <ProfileMeasure
            imageUrl={profileImageUrl}
            calibrationScale={calibration?.scalePxToMm}
            onCapture={handleProfileMeasured}
            onSkip={handleProfileSkip}
            onBack={() => setStep('pupils')}
          />
        )}

        {step === 'result' && measurements && (
          <ResultCard
            measurements={measurements}
            imageUrl={imageData}
            profileImageUrl={profileImageUrl}
            onRetake={handleReset}
          />
        )}
      </main>
    </div>
  )
}
