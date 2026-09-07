import { useState } from 'react'
import { Ruler, Mail, Lock, User as UserIcon, Eye, EyeOff, LogIn, UserPlus } from 'lucide-react'
import { login, register } from '../services/auth'

/**
 * Écran de connexion / inscription — Smart Optica SaaS
 * Design dark cohérent (variables CSS du thème).
 */
export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login') // 'login' | 'register'
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const inputStyle = {
    background: 'var(--color-card)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-text)',
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'register') {
        if (password.length < 8) throw new Error('Mot de passe : 8 caractères minimum')
        await register(email, name, password)
        // Connexion automatique après inscription
        await login(email, password)
        onAuthenticated()
      } else {
        await login(email, password)
        onAuthenticated()
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: 'var(--color-bg)' }}>
      {/* Logo */}
      <div className="flex items-center gap-2 mb-8">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--color-gold)' }}>
          <Ruler size={20} style={{ color: 'var(--color-bg)' }} />
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight"
            style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif" }}>
            Smart Optica
          </h1>
          <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
            Centrage digital de précision
          </p>
        </div>
      </div>

      {/* Carte */}
      <form onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl p-6 space-y-4"
        style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>

        <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
          <button type="button" onClick={() => { setMode('login'); setError(null) }}
            className="flex-1 py-2 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
            style={mode === 'login'
              ? { background: 'var(--color-gold-bg)', color: 'var(--color-gold)' }
              : { color: 'var(--color-text-muted)' }}>
            <LogIn size={13} /> Connexion
          </button>
          <button type="button" onClick={() => { setMode('register'); setError(null) }}
            className="flex-1 py-2 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
            style={mode === 'register'
              ? { background: 'var(--color-gold-bg)', color: 'var(--color-gold)' }
              : { color: 'var(--color-text-muted)' }}>
            <UserPlus size={13} /> Inscription
          </button>
        </div>

        {mode === 'register' && (
          <label className="block">
            <span className="text-[11px] mb-1 block" style={{ color: 'var(--color-text-muted)' }}>
              Nom / Boutique
            </span>
            <div className="relative">
              <UserIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--color-text-muted)' }} />
              <input value={name} onChange={(e) => setName(e.target.value)} required
                minLength={2} placeholder="Optique Driss"
                className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none focus:border-gold"
                style={inputStyle} />
            </div>
          </label>
        )}

        <label className="block">
          <span className="text-[11px] mb-1 block" style={{ color: 'var(--color-text-muted)' }}>Email</span>
          <div className="relative">
            <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--color-text-muted)' }} />
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              placeholder="vous@boutique.ma" autoComplete="email"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none"
              style={inputStyle} />
          </div>
        </label>

        <label className="block">
          <span className="text-[11px] mb-1 block" style={{ color: 'var(--color-text-muted)' }}>
            Mot de passe{mode === 'register' && ' (8 caractères min.)'}
          </span>
          <div className="relative">
            <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--color-text-muted)' }} />
            <input type={showPwd ? 'text' : 'password'} value={password}
              onChange={(e) => setPassword(e.target.value)} required
              minLength={mode === 'register' ? 8 : undefined}
              placeholder="••••••••" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              className="w-full pl-9 pr-10 py-2.5 rounded-lg text-sm outline-none"
              style={inputStyle} />
            <button type="button" onClick={() => setShowPwd(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--color-text-muted)' }} aria-label="Afficher le mot de passe">
              {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>

        {error && (
          <div className="rounded-lg px-3 py-2 text-xs"
            style={{ background: 'var(--color-red-bg, rgba(239,68,68,.12))', color: 'var(--color-red, #ef4444)' }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={busy}
          className="w-full py-3 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-50"
          style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}>
          {busy ? '…' : mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
        </button>
      </form>

      <p className="text-[10px] mt-4" style={{ color: 'var(--color-text-muted)' }}>
        Chaque compte accède uniquement à ses propres mesures
      </p>
    </div>
  )
}
