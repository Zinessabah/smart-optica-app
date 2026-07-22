/**
 * Hook unifié pour la conversion de coordonnées écran ↔ image
 * Élimine la duplication entre CalibrationOverlay, PupilMarker, BoxingRect
 */

import { useCallback, useRef, useEffect } from 'react'

/**
 * Hook pour gérer les coordonnées entre :
 * - Écran (clientX, clientY)
 * - Conteneur React (containerRef)
 * - Image affichée (imageRef) avec letterboxing
 * - Image naturelle (imageSize: {width, height})
 * 
 * @param {Object} options
 * @param {React.RefObject} options.imageRef - Ref sur l'élément <img>
 * @param {React.RefObject} options.containerRef - Ref sur le conteneur
 * @param {Object|null} options.imageSize - { width, height } de l'image naturelle
 * @returns {Object} { toImageCoords, getImageDisplayRect, imagePointToScreen }
 */
export function useImageCoordinates({ imageRef, containerRef, imageSize }) {
  // Rectangle réellement affiché de l'image dans le conteneur
  const getImageDisplayRect = useCallback(() => {
    const imgRect = imageRef.current?.getBoundingClientRect()
    const contRect = containerRef.current?.getBoundingClientRect()
    if (!imgRect || !contRect) return null

    return {
      left: imgRect.left - contRect.left,
      top: imgRect.top - contRect.top,
      width: imgRect.width,
      height: imgRect.height
    }
  }, [imageRef, containerRef])

  // Convertit coordonnées écran → coordonnées image naturelle
  const toImageCoords = useCallback((clientX, clientY) => {
    const dr = getImageDisplayRect()
    if (!dr || !imageSize) return null

    const x = Math.max(0, Math.min(dr.width, clientX - dr.left))
    const y = Math.max(0, Math.min(dr.height, clientY - dr.top))

    return {
      x: (x / dr.width) * imageSize.width,
      y: (y / dr.height) * imageSize.height
    }
  }, [getImageDisplayRect, imageSize])

  // Convertit point image (pourcentage) → coordonnées écran
  const imagePointToScreen = useCallback((point) => {
    const dr = getImageDisplayRect()
    if (!dr || !imageSize) return null

    return {
      left: ((point.x / imageSize.width) * dr.width) + dr.left,
      top: ((point.y / imageSize.height) * dr.height) + dr.top
    }
  }, [getImageDisplayRect, imageSize])

  return {
    toImageCoords,
    getImageDisplayRect,
    imagePointToScreen
  }
}

/**
 * Hook pour drag & drop de marqueurs via data-markerid
 * Pattern unifié : window listeners + refs sync
 * 
 * @param {Object} options
 * @param {React.RefObject} options.containerRef
 * @param {Function} options.toImageCoords - du useImageCoordinates
 * @param {Object} options.currentPosRef - { bridge, left, right, boxOG, boxOD, ... }
 * @param {Function} options.onDragStart - (markerId, startPos) => void
 * @param {Function} options.onDragMove - (markerId, newPos) => void
 * @param {Function} options.onDragEnd - (markerId, finalPos) => void
 * @param {Set} options.lockedRef - Set des marqueurs verrouillés
 * @returns {Object} { handlePointerDown, handlePointerMove, handlePointerLeave }
 */
export function useMarkerDrag({
  containerRef,
  toImageCoords,
  currentPosRef,
  onDragStart,
  onDragMove,
  onDragEnd,
  lockedRef
}) {
  const dragRef = useRef(null) // { markerId, startClient, startPos }

  // Nettoyage listeners
  useEffect(() => {
    if (!dragRef.current) return

    const onMove = (e) => {
      if (!dragRef.current) return
      const { markerId } = dragRef.current
      if (lockedRef.current.has(markerId)) {
        dragRef.current = null
        return
      }
      const currImg = toImageCoords(e.clientX, e.clientY)
      if (!currImg) return
      const startImg = toImageCoords(dragRef.current.startClient.x, dragRef.current.startClient.y)
      if (!startImg) return
      const dx = currImg.x - startImg.x
      const dy = currImg.y - startImg.y
      const newPos = {
        x: dragRef.current.startPos.x + dx,
        y: dragRef.current.startPos.y + dy
      }
      onDragMove(markerId, newPos)
    }

    const onUp = () => {
      if (dragRef.current) {
        onDragEnd(dragRef.current.markerId, currentPosRef.current[dragRef.current.markerId])
        dragRef.current = null
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragRef, toImageCoords, onDragMove, onDragEnd, currentPosRef, lockedRef])

  const handlePointerDown = useCallback((e) => {
    // 1. Cherche un marqueur via data-markerid
    let target = e.target
    while (target && target !== containerRef.current) {
      if (target.dataset?.markerid) {
        const markerId = target.dataset.markerid
        const pos = currentPosRef.current[markerId]
        if (pos && !lockedRef.current.has(markerId)) {
          e.preventDefault()
          onDragStart(markerId, pos)
          dragRef.current = { markerId, startClient: { x: e.clientX, y: e.clientY }, startPos: { ...pos } }
          return
        }
      }
      target = target.parentElement
    }

    // 2. Tap hors marqueur → géré par le composant parent
  }, [containerRef, currentPosRef, lockedRef, onDragStart])

  const handlePointerMove = useCallback(() => {
    if (!containerRef.current) return
    // Pour loupe, etc.
  }, [containerRef])

  const handlePointerLeave = useCallback(() => {
    // Loupe hide, etc.
  }, [])

  return { handlePointerDown, handlePointerMove, handlePointerLeave }
}

/**
 * Hook pour loupe avec compensation letterboxing
 * @param {Object} options
 * @param {Function} options.getImageDisplayRect - du useImageCoordinates
 * @param {Object} options.imageSize
 * @param {number} options.zoom
 * @param {number} options.size
 * @returns {Object} { loupeStyle, loupeBgSize, loupeBgPos }
 */
export function useLoupe({ getImageDisplayRect, imageSize, zoom = 3, size = 140, pos }) {
  const half = size / 2

  if (!pos || !imageSize || !getImageDisplayRect) return { style: { display: 'none' } }

  const dr = getImageDisplayRect()
  if (!dr || dr.width <= 0 || dr.height <= 0) return { style: { display: 'none' } }

  const mouseInImageX = pos.x - dr.left
  const mouseInImageY = pos.y - dr.top

  if (mouseInImageX < 0 || mouseInImageX > dr.width || mouseInImageY < 0 || mouseInImageY > dr.height) {
    return { style: { display: 'none' } }
  }

  const bgSizeW = dr.width * zoom
  const bgSizeH = dr.height * zoom
  const bgX = -(mouseInImageX * zoom) + half
  const bgY = -(mouseInImageY * zoom) + half

  return {
    style: {
      position: 'absolute',
      left: pos.x - half,
      top: pos.y - half,
      width: size,
      height: size,
      borderRadius: '50%',
      border: '2px solid var(--color-gold)',
      boxShadow: '0 0 0 4px rgba(0,0,0,0.4), 0 0 24px rgba(0,0,0,0.5)',
      backgroundImage: `url(${pos.imageUrl})`,
      backgroundSize: `${bgSizeW}px ${bgSizeH}px`,
      backgroundPosition: `${bgX}px ${bgY}px`,
      backgroundRepeat: 'no-repeat',
      overflow: 'hidden',
      zIndex: 100,
      pointerEvents: 'none'
    }
  }
}