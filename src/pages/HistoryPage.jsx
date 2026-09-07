import { useState, useEffect, useCallback } from 'react'
import { History, Search, Trash2, Eye, ArrowLeft, FileText, UserRound, Calendar, Ruler, X } from 'lucide-react'
import { listMeasurements, deleteMeasurement, getMeasurement } from '../services/measurements'
import { getStoredUser } from '../services/auth'

const cardStyle = { background: 'var(--color-card)', border: '1px solid var(--color-border)' }

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) }
  catch { return iso }
}

export default function HistoryPage({ onBackToHome }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [detail, setDetail] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const [user, setUser] = useState(null)

  useEffect(() => { setUser(getStoredUser()) }, [])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await listMeasurements({ limit: 100 })
      setItems(r)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const openDetail = async (id) => {
    try {
      const d = await getMeasurement(id)
      setDetail(d)
    } catch (e) { setError(e.message) }
  }

  const doDelete = async (id) => {
    await deleteMeasurement(id)
    setConfirmDel(null)
    if (detail?.id === id) setDetail(null)
    load()
  }

  if (detail) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <button onClick={() => setDetail(null)} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            <ArrowLeft size={14} /> Retour
          </button>
          <button onClick={() => doDelete(detail.id)} className="flex items-center gap-1.5 text-xs" style={{ color: '#ef4444' }}>
            <Trash2 size={14} /> Supprimer
          </button>
        </div>

        <div className="rounded-2xl p-4" style={cardStyle}>
          <div className="flex items-center gap-2 mb-3">
            <UserRound size={16} style={{ color: 'var(--color-gold)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{detail.patient_name || 'Patient sans nom'}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] mb-4" style={{ color: 'var(--color-text-muted)' }}>
            <Calendar size={12} /> {fmtDate(detail.created_at)}
          </div>

          {/* Photos */}
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

          {/* Mesures clés */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Row label="DP binoculaire" value={detail.pd != null ? `${detail.pd} mm` : '—'} />
            <Row label="Pont" value={detail.pont != null ? `${detail.pont} mm` : '—'} />
            <Row label="Pantoscopique" value={detail.pantoscopic_angle != null ? `${detail.pantoscopic_angle}°` : '—'} />
            <Row label="Vertex" value={detail.vertex_distance != null ? `${detail.vertex_distance} mm` : '—'} />
          </div>

          <button onClick={() => window.print()} className="mt-4 w-full py-2.5 rounded-xl text-sm font-medium flex items-center justify-center gap-1.5" style={{ background: 'var(--color-gold)', color: 'var(--color-bg)' }}>
            <FileText size={15} /> Imprimer / PDF
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="text-center">
        {user?.name && (
          <div className="flex items-center justify-center gap-1.5 text-xs mb-1" style={{ color: 'var(--color-gold)' }}>
            <UserRound size={13} />
            <span className="font-medium">{user.name}</span>
            <span className="text-[10px] font-normal" style={{ color: 'var(--color-text-muted)' }}>· opticien</span>
          </div>
        )}
        <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)', fontFamily: "'Playfair Display', Georgia, serif'" }}>
          Historique des mesures
        </h2>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{items.length} mesure(s) enregistrée(s)</p>
      </div>

      {onBackToHome && (
        <button onClick={onBackToHome} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <ArrowLeft size={14} /> Retour au centrage
        </button>
      )}

      {error && <div className="rounded-lg px-3 py-2 text-xs text-center" style={{ background: 'rgba(239,68,68,.12)', color: '#ef4444' }}>{error}</div>}

      {loading ? <p className="text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Chargement…</p>
        : items.length === 0 ? <p className="text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>Aucune mesure enregistrée</p>
          : (
            <div className="space-y-2">
              {items.map(m => (
                <div key={m.id} className="rounded-xl p-3 flex items-center gap-3" style={cardStyle}>
                  {/* Miniatures Face + Profil */}
                  <div className="flex gap-1.5 shrink-0" onClick={() => openDetail(m.id)} role="button">
                    {m.face_image_url ? (
                      <img src={m.face_image_url} alt="Face" className="w-12 h-12 rounded-lg object-cover" style={{ border: '1px solid var(--color-border)' }} />
                    ) : (
                      <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ background: 'var(--color-bg)' }}><UserRound size={18} style={{ color: 'var(--color-text-muted)' }} /></div>
                    )}
                    {m.profile_image_url ? (
                      <img src={m.profile_image_url} alt="Profil" className="w-12 h-12 rounded-lg object-cover" style={{ border: '1px solid var(--color-border)' }} />
                    ) : (
                      <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ background: 'var(--color-bg)' }}><UserRound size={18} style={{ color: 'var(--color-text-muted)' }} /></div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1" onClick={() => openDetail(m.id)} role="button">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{m.patient_name || 'Patient sans nom'}</span>
                    </div>
                    <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{fmtDate(m.created_at)}</div>
                    <div className="text-xs mt-1 flex items-center gap-3" style={{ color: 'var(--color-text-muted)' }}>
                      {m.pd != null && <span><Ruler size={11} className="inline" /> {m.pd} mm</span>}
                      {m.pont != null && <span>Pont {m.pont} mm</span>}
                      {m.frame_ref && <span>· {m.frame_ref}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openDetail(m.id)} title="Voir" className="p-2 rounded-lg" style={{ color: 'var(--color-text-muted)' }}><Eye size={15} /></button>
                    <button onClick={() => setConfirmDel(m)} title="Supprimer" className="p-2 rounded-lg" style={{ color: '#ef4444' }}><Trash2 size={15} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.6)' }} onClick={() => setConfirmDel(null)}>
          <div className="w-full max-w-sm rounded-2xl p-5" style={cardStyle} onClick={e => e.stopPropagation()}>
            <p className="text-sm mb-4" style={{ color: 'var(--color-text)' }}>
              Supprimer la mesure de <strong>{confirmDel.patient_name || 'Patient sans nom'}</strong> ?
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDel(null)} className="flex-1 py-2.5 rounded-lg text-sm" style={cardStyle}>Annuler</button>
              <button onClick={() => doDelete(confirmDel.id)} className="flex-1 py-2.5 rounded-lg text-sm font-medium" style={{ background: '#ef4444', color: '#fff' }}>Supprimer</button>
            </div>
          </div>
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
