import { Component } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--color-bg)' }}>
          <div className="max-w-sm text-center space-y-5">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto"
              style={{ background: 'var(--color-red-bg)' }}>
              <AlertTriangle size={32} style={{ color: 'var(--color-red)' }} />
            </div>
            <div>
              <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--color-text)' }}>
                Une erreur est survenue
              </h2>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {this.state.error?.message || 'L\'application a rencontré un problème inattendu.'}
              </p>
            </div>
            <button onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full font-medium text-sm text-white transition-all hover:opacity-90"
              style={{ background: 'var(--color-gold)' }}>
              <RotateCcw size={16} /> Redémarrer l'application
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
