import React from 'react'

export default class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Page render error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="empty">
            <div className="icon">⚠</div>
            <p>Erreur d'affichage sur cette page.</p>
            <p style={{ fontSize: '.85rem', opacity: 0.7 }}>
              {String(this.state.error?.message || this.state.error)}
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
