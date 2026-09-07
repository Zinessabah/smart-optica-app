/**
 * Sélection des photos à embarquer dans l'export PDF — fonctions pures.
 * Priorise l'image annotée (avec marqueurs) pour le bordereau de centrage.
 */

export interface PdfPhotoSource {
  annotatedImageUrl?: string | null
  imageUrl?: string | null
  profileImageUrl?: string | null
}

export interface PdfPhoto {
  url: string
  label: string
}

/**
 * Choisit la meilleure photo de face : l'annotée si dispo, sinon la brute.
 */
export function selectPdfPhoto(annotatedImageUrl: string | null | undefined, imageUrl: string | null | undefined): string | null {
  if (annotatedImageUrl) return annotatedImageUrl
  if (imageUrl) return imageUrl
  return null
}

/**
 * Construit la liste ordonnée des photos pour le PDF.
 */
export function buildPdfPhotoList(src: PdfPhotoSource): PdfPhoto[] {
  const list: PdfPhoto[] = []
  const faceUrl = selectPdfPhoto(src.annotatedImageUrl, src.imageUrl)
  if (faceUrl) list.push({ url: faceUrl, label: 'Face' })
  if (src.profileImageUrl) list.push({ url: src.profileImageUrl, label: 'Profil D' })
  return list
}
