import { useState, useEffect, useCallback, useRef } from 'react'
import { Ruler, Users, Search, UserPlus, KeyRound, Trash2, Edit3, X, Check, Shield } from 'lucide-react'
import AuthScreen from '../src/components/AuthScreen.jsx'
import { getToken, fetchMe, clearSession } from '../src/services/auth.js'
import { listUsers, createUser, updateUser, resetPassword, deleteUser } from '../src/services/admin.js'
import AdminMeasurements from './AdminMeasurements.jsx'

// ── Idle timeout page admin ─────────────────────────────────────────────
// Si l'admin n'interagit pas pendant IDLE_MS (10 min), on se déconnecte.
// Un avertissement (modale + compte à rebours) apparaît WARN_BEFORE_MS avant.
const IDLE_MS = 10 * 60 * 1000        // 10 minutes d'inactivité → déconnexion
const WARN_BEFORE_MS = 30 * 1000      // 30s avant → modale d'avertissement

function useIdleTimeout({ timeoutMs = IDLE_MS, warnBeforeMs = WARN_BEFORE_MS, onIdle, enabled }) {
  const [left, setLeft] = useState(timeoutMs) // ms restantes avant déconnexion
  const timerRef = useRef(null)
  const onIdleRef = useRef(onIdle)
  onIdleRef.current = onIdle

  // Reset du compte à rebours à chaque interaction
  const reset = useCallback(() => {
    if (!enabled) return
    if (timerRef.current) clearInterval(timerRef.current)
    setLeft(timeoutMs)
    timerRef.current = setInterval(() => setLeft(t => {
      if (t - 1000 <= 0) { clearInterval(timerRef.current); return 0 }
      return t - 1000
    }), 1000)
  }, [enabled, timeoutMs])

  const forceLogout = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    onIdleRef.current?.()
  }, [])

  useEffect(() => {
    if (!enabled) return
    const events = ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove']
    const onActivity = () => reset()
    events.forEach(ev => window.addEventListener(ev, onActivity, { passive: true }))
    reset()
    return () => {
      events.forEach(ev => window.removeEventListener(ev, onActivity))
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [enabled, reset])

  // Déconnexion automatique quand le temps est écoulé
  useEffect(() => {
    if (enabled && left <= 0) forceLogout()
  }, [left, enabled, forceLogout])

  const warn = enabled && left > 0 && left <= warnBeforeMs
  return { left, warn, reset, forceLogout }
}
// ────────────────────────────────────────────────────────────────────────

const cardStyle = { background: 'var(--color-card)', border: '1px solid var(--color-border)' }
const btnGold = { background: 'var(--color-gold)', color: 'var(--color-bg)' }
const inputStyle = { background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.6)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-5 animate-fade-in" style={cardStyle} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>{title}</h3>
          <button onClick={onClose} className="p-1" style={{ color: 'var(--color-text-muted)' }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function AdminApp() {
  const [authState, setAuthState] = useState('checking')
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const [tab, setTab] = useState('accounts') // 'accounts' | 'measurements'

  useEffect(() => {
    const check = async () => {
      if (!getToken()) { setAuthState('anon'); return }
      const u = await fetchMe()
      if (u) { setMe(u); setAuthState(u.role === 'admin' ? 'auth' : 'forbidden') }
      else setAuthState('anon')
    }
    check()
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await listUsers({ page, per_page: 20, search })
      setUsers(r.data); setTotal(r.total)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [page, search])

  useEffect(() => { if (authState === 'auth') load() }, [authState, load])

  // ── Idle timeout : se déconnecter après 10 min d'inactivité ──
  const doLogout = useCallback(() => {
    clearSession(); setMe(null); setAuthState('anon')
  }, [])
  const idle = useIdleTimeout({ onIdle: doLogout, enabled: authState === 'auth' })
  const fmt = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000))
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }

  if (authState === 'checking') {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg)' }}>
      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Chargement…</span>
    </div>
  }
  if (authState === 'anon') {
    return <AuthScreen onAuthenticated={async () => {
      const u = await fetchMe()
      setMe(u)
      setAuthState(u?.role === 'admin' ? 'auth' : 'forbidden')
    }} />
  }
  if (authState === 'forbidden') {
    return <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4" style={{ background: 'var(--color-bg)' }}>
      <Shield size={40} style={{ color: 'var(--color-red)' }} />
      <p className="text-sm" style={{ color: 'var(--color-text)' }}>Accès réservé aux administrateurs</p>
      <button onClick={() => { clearSession(); setAuthState('anon') }}
        className="text-xs px-4 py-2 rounded-lg" style={cardStyle}>Se déconnecter</button>
    </div>
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      <header className="sticky top-0 z-30 px-4 py-2.5 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'var(--color-gold)' }}>
            <Ruler size={13} style={{ color: 'var(--color-bg)' }} />
          </div>
          <span className="text-[11px] font-bold tracking-wider uppercase" style={{ color: 'var(--color-text)' }}>Smart Optica</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-gold-bg)', color: 'var(--color-gold)' }}>ADMIN</span>
        </div>
        <div className="flex items-center gap-3">
          {authState === 'auth' && (
            <span className="text-[10px] tabular-nums" style={{ color: idle.warn ? 'var(--color-red)' : 'var(--color-text-muted)' }}>
              ⏱ {fmt(idle.left)}
            </span>
          )}
          <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{me?.name}</span>
          <button onClick={() => { clearSession(); setMe(null); setAuthState('anon') }}
            className="text-[10px] px-2 py-1 rounded-md" style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}>
            Déconnexion
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-4">
        <div className="space-y-4 animate-fade-in">
          {/* Onglets Comptes / Mesures */}
          <div className="flex rounded-xl overflow-hidden border" style={{ borderColor: 'var(--color-border)' }}>
            <button onClick={() => setTab('accounts')} className="flex-1 py-2.5 text-xs font-medium transition-all"
              style={tab === 'accounts'
                ? { background: 'var(--color-gold)', color: 'var(--color-bg)' }
                : { background: 'transparent', color: 'var(--color-text-muted)' }}>
              <Users size={13} className="inline -mt-0.5 mr-1" /> Comptes
            </button>
            <button onClick={() => setTab('measurements')} className="flex-1 py-2.5 text-xs font-medium transition-all"
              style={tab === 'measurements'
                ? { background: 'var(--color-gold)', color: 'var(--color-bg)' }
                : { background: 'transparent', color: 'var(--color-text-muted)' }}>
              <Ruler size={13} className="inline -mt-0.5 mr-1" /> Mesures
            </button>
          </div>

          {tab === 'measurements' && (
            <AdminMeasurements users={users} onBack={() => setTab('accounts')} />
          )}

          {tab === 'accounts' && (
          <div className="space-y-4">
            <div className="text-center">
              <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif'" }}>
                Gestion des comptes
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{total} utilisateur(s) • page {page}</p>
            </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
              <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="Rechercher email / nom…"
                className="w-full pl-9 pr-3 py-2 rounded-lg text-sm outline-none" style={inputStyle} />
            </div>
            <button onClick={() => setCreating(true)} className="px-3 rounded-lg text-xs font-medium flex items-center gap-1.5" style={btnGold}>
              <UserPlus size={14} /> Créer
            </button>
          </div>

          {error && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{error}</div>}

          {loading ? <p className="text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Chargement…</p>
            : users.length === 0 ? <p className="text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Aucun utilisateur</p>
              : (
                <div className="space-y-2">
                  {users.map(u => (
                    <div key={u.id} className="rounded-xl p-3 flex items-center justify-between" style={cardStyle}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{u.name}</span>
                          {u.role === 'admin' && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-gold-bg)', color: 'var(--color-gold)' }}>🛡️ ADMIN</span>}
                          {!u.is_active && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,.15)', color: '#ef4444' }}>INACTIF</span>}
                        </div>
                        <div className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{u.email}</div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => setResetting(u)} title="Reset mot de passe" className="p-2 rounded-lg" style={{ color: 'var(--color-text-muted)' }}><KeyRound size={15} /></button>
                        <button onClick={() => setEditing(u)} title="Modifier" className="p-2 rounded-lg" style={{ color: 'var(--color-text-muted)' }}><Edit3 size={15} /></button>
                        <button onClick={() => u.id !== me?.id && setConfirmDel(u)} disabled={u.id === me?.id}
                          title={u.id === me?.id ? "Vous ne pouvez pas vous supprimer" : "Supprimer"} className="p-2 rounded-lg disabled:opacity-30" style={{ color: '#ef4444' }}><Trash2 size={15} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

          {total > 20 && (
            <div className="flex justify-center gap-2 pt-2">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-lg text-xs" style={{ ...cardStyle, opacity: page <= 1 ? .4 : 1 }}>← Préc.</button>
              <button disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg text-xs" style={{ ...cardStyle, opacity: page * 20 >= total ? .4 : 1 }}>Suiv. →</button>
            </div>
          )}

          {creating && <CreateModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load() }} />}
          {editing && <EditModal user={editing} selfId={me?.id} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />}
          {resetting && <ResetModal user={resetting} onClose={() => setResetting(null)} onDone={() => { setResetting(null); load() }} />}
          {confirmDel && (
            <Modal title="Supprimer le compte" onClose={() => setConfirmDel(null)}>
              <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
                Confirmer la suppression de <strong style={{ color: 'var(--color-text)' }}>{confirmDel.name}</strong> ({confirmDel.email}) ? Irréversible.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDel(null)} className="flex-1 py-2.5 rounded-lg text-sm" style={cardStyle}>Annuler</button>
                <button onClick={async () => { await deleteUser(confirmDel.id); setConfirmDel(null); load() }} className="flex-1 py-2.5 rounded-lg text-sm font-medium" style={{ background: '#ef4444', color: '#fff' }}>Supprimer</button>
              </div>
            </Modal>
          )}

          {idle.warn && (
            <Modal title="Session inactive" onClose={() => idle.reset()}>
              <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
                Vous avez été inactif trop longtemps. La session expirera dans <strong style={{ color: 'var(--color-red)' }}>{fmt(idle.left)}</strong>, vous devrez vous reconnecter.
              </p>
              <div className="flex gap-2">
                <button onClick={() => idle.reset()} className="flex-1 py-2.5 rounded-lg text-sm font-medium" style={btnGold}>Rester connecté</button>
                <button onClick={doLogout} className="flex-1 py-2.5 rounded-lg text-sm" style={cardStyle}>Se déconnecter</button>
              </div>
            </Modal>
          )}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function Field({ label, children }) {
  return <label className="block"><span className="text-[11px] mb-1 block" style={{ color: 'var(--color-text-muted)' }}>{label}</span>{children}</label>
}

function CreateModal({ onClose, onDone }) {
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [password, setPassword] = useState(''); const [role, setRole] = useState('user'); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false)
  const submit = async (e) => { e.preventDefault(); setErr(null); setBusy(true); try { await createUser({ email, name, password, role }); onDone() } catch (e2) { setErr(e2.message) } finally { setBusy(false) } }
  return (
    <Modal title="Créer un compte" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nom / Boutique"><input value={name} onChange={e => setName(e.target.value)} required minLength={2} className="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style={inputStyle} /></Field>
        <Field label="Email"><input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style={inputStyle} /></Field>
        <Field label="Mot de passe (8 min.)"><input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} className="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style={inputStyle} /></Field>
        <Field label="Rôle">
          <select value={role} onChange={e => setRole(e.target.value)} className="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style={inputStyle}>
            <option value="user">Utilisateur</option><option value="admin">Administrateur</option>
          </select>
        </Field>
        {err && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{err}</div>}
        <button type="submit" disabled={busy} className="w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-50" style={btnGold}>{busy ? '…' : 'Créer le compte'}</button>
      </form>
    </Modal>
  )
}

function EditModal({ user, selfId, onClose, onDone }) {
  const [name, setName] = useState(user.name); const [role, setRole] = useState(user.role); const [isActive, setIsActive] = useState(user.is_active); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const isSelf = user.id === selfId
  const submit = async (e) => { e.preventDefault(); setErr(null); setBusy(true); try { await updateUser(user.id, { name, role, is_active: isActive }); onDone() } catch (e2) { setErr(e2.message) } finally { setBusy(false) } }
  return (
    <Modal title={`Modifier ${user.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nom / Boutique"><input value={name} onChange={e => setName(e.target.value)} required minLength={2} className="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style={inputStyle} /></Field>
        <Field label="Rôle">
          <select value={role} onChange={e => setRole(e.target.value)} disabled={isSelf} className="w-full px-3 py-2.5 rounded-lg text-sm outline-none disabled:opacity-50" style={inputStyle}>
            <option value="user">Utilisateur</option><option value="admin">Administrateur</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 pt-1">
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} disabled={isSelf} className="accent-[var(--color-gold)] disabled:opacity-50" />
          <span className="text-xs" style={{ color: 'var(--color-text)' }}>Compte actif</span>
          {isSelf && <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>(vous ne pouvez pas vous désactiver)</span>}
        </label>
        {err && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{err}</div>}
        <button type="submit" disabled={busy} className="w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-50" style={btnGold}>{busy ? '…' : 'Enregistrer'}</button>
      </form>
    </Modal>
  )
}

function ResetModal({ user, onClose, onDone }) {
  const [pwd, setPwd] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false)
  const submit = async (e) => { e.preventDefault(); setErr(null); if (pwd.length < 8) { setErr('8 caractères minimum'); return } setBusy(true); try { await resetPassword(user.id, pwd); onDone() } catch (e2) { setErr(e2.message) } finally { setBusy(false) } }
  return (
    <Modal title={`Reset mot de passe — ${user.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nouveau mot de passe (8 min.)"><input type="password" value={pwd} onChange={e => setPwd(e.target.value)} required minLength={8} className="w-full px-3 py-2.5 rounded-lg text-sm outline-none" style={inputStyle} /></Field>
        {err && <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{err}</div>}
        <button type="submit" disabled={busy} className="w-full py-3 rounded-xl text-sm font-semibold disabled:opacity-50" style={btnGold}>{busy ? '…' : 'Réinitialiser'}</button>
      </form>
    </Modal>
  )
}
