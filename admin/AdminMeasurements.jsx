import { useState, useEffect, useCallback } from 'react'
import { BarChart3, UserRound, Eye, ArrowLeft, Calendar, Ruler, FileText } from 'lucide-react'
import { listAllMeasurements } from '../src/services/measurements'

const cardStyle = { background: 'var(--color-card)', border: '1px solid var(--color-border)' }

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) }
  catch { return iso }
}

export default function AdminMeasurements({ users, onBack }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filterUserId, setFilterUserId] = useState('')
  const [detail, setDetail] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await listAllMeasurements({ user_id: filterUserId || undefined, limit: 200 })
      setItems(r)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [filterUserId])

  useEffect(() => { load() }, [load])

  if (detail) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <button onClick={() => setDetail(null)} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <ArrowLeft size={14} /> Retour
          </button>
        </div>
        <div className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-2 mb-1">
            <UserRound size={16} style={{ color: 'var(--color-gold)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{detail.patient_name || 'Patient sans nom'}</span>
          </div>
          <div className="text-[11px] mb-3" style={{ color: 'var(--color-text-muted)' }}>
            Opticien : <strong style={{ color: 'var(--color-text)' }}>{detail.user_name || '—'}</strong> · {detail.user_email}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] mb-4" style={{ color: 'var(--color-text-muted)' }}>
            <Calendar size={12} /> {fmtDate(detail.created_at)}
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {detail.face_image_url && (
              <div>
                <p className="text-[10px] mb-1" style={{ color: 'var(--color-text-muted)' }}>Face</p>
                <img src={detail.face_image_url} alt="Face" className="w-full rounded-lg" style={{ border: '1px solid var(--color-border)' }} />
              </div>
            )}
            {detail.profile_image_url && (
              <div>
                <p className="text-[10px] mb-1" style={{ color: 'var(--color-text-muted)' }}>Profil</p>
                <img src={detail.profile_image_url} alt="Profil" className="w-full rounded-lg" style={{ border: '1px solid var(--color-border)' }} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Row label="DP binoculaire" value={detail.pd != null ? `${detail.pd} mm` : '—'} />
            <Row label="Pont" value={detail.pont != null ? `${detail.pont} mm` : '—'} />
            <Row label="Pantoscopique" value={detail.pantoscopic_angle != null ? `${detail.pantoscopic_angle}°` : '—'} />
            <Row label="Vertex" value={detail.vertex_distance != null ? `${detail.vertex_distance} mm` : '—'} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="text-center">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif'" }}>
          Mesures des opticiens
        </h2>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{items.length} mesure(s) — vue globale admin</p>
      </div>

      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <ArrowLeft size={14} /> Retour aux comptes
        </button>
      )}

      {/* Filtre par opticien */}
      <div className="relative">
        <UserRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
        <select
          value={filterUserId}
          onChange={e => setFilterUserId(e.target.value)}
          className="w-full pl-8 pr-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
        >
          <option value="">Tous les opticiens</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
        </select>
      </div>

      {error && <div className="rounded-lg px-3 py-2 text-xs text-center" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{error}</div>}

      {loading ? <p className="text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Chargement…</p>
        : items.length === 0 ? <p className="text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Aucune mesure</p>
          : (
            <div className="space-y-2">
              {items.map(m => (
                <div key={m.id} className="rounded-xl p-3 flex items-center gap-3" style={cardStyle}>
                  <div className="flex gap-1.5 shrink-0" onClick={() => setDetail(m)} role="button">
                    {m.face_image_url ? <img src={m.face_image_url} alt="Face" className="w-12 h-12 rounded-lg object-cover" style={{ border: '1px solid var(--color-border)' }} />
                      : <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ background: 'var(--color-bg)' }}><UserRound size={18} style={{ color: 'var(--color-text-muted)' }} /></div>}
                    {m.profile_image_url ? <img src={m.profile_image_url} alt="Profil" className="w-12 h-12 rounded-lg object-cover" style={{ border: '1px solid var(--color-border)' }} />
                      : <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ background: 'var(--color-bg)' }}><UserRound size={18} style={{ color: 'var(--color-text-muted)' }} /></div>}
                  </div>
                  <div className="min-w-0 flex-1" onClick={() => setDetail(m)} role="button">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{m.patient_name || 'Patient sans nom'}</span>
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-gold)' }}>
                      <UserRound size={11} className="inline" /> {m.user_name || 'N/A'}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{fmtDate(m.created_at)}</div>
                    <div className="text-xs mt-1 flex items-center gap-3" style={{ color: 'var(--color-text-muted)' }}>
                      {m.pd != null && <span><Ruler size={11} className="inline" /> {m.pd} mm</span>}
                      {m.pont != null && <span>Pont {m.pont} mm</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setDetail(m)} title="Voir" className="p-2 rounded-lg" style={{ color: 'var(--color-text-muted)' }}><Eye size={15} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: 'var(--color-bg)' }}>
      <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <div className="font-semibold" style={{ color: 'var(--color-text)' }}>{value}</div>
    </div>
  )
}
