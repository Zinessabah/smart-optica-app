export function computeContainedImageRect(containerWidth, containerHeight, imageWidth, imageHeight) {
  if (![containerWidth, containerHeight, imageWidth, imageHeight].every(v => Number.isFinite(v) && v > 0)) return null
  const containerAspect = containerWidth / containerHeight
  const imageAspect = imageWidth / imageHeight
  if (imageAspect > containerAspect) {
    const height = containerWidth / imageAspect
    return { left: 0, top: (containerHeight - height) / 2, width: containerWidth, height }
  }
  const width = containerHeight * imageAspect
  return { left: (containerWidth - width) / 2, top: 0, width, height: containerHeight }
}

export function screenPointToImage(clientX, clientY, containerRect, displayRect, imageSize) {
  if (!containerRect || !displayRect || !imageSize) return null
  const x = clientX - containerRect.left - displayRect.left
  const y = clientY - containerRect.top - displayRect.top
  if (x < 0 || y < 0 || x > displayRect.width || y > displayRect.height) return null
  return {
    x: (x / displayRect.width) * imageSize.width,
    y: (y / displayRect.height) * imageSize.height,
  }
}
