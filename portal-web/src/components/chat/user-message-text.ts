const ATTACHMENT_OCR_EVIDENCE_MARKER =
  "[System: The user pasted image or PDF attachment(s). OCR evidence extracted by Siclaw is below."

export function stripAttachmentOcrEvidence(content: string): string {
  const index = content.indexOf(ATTACHMENT_OCR_EVIDENCE_MARKER)
  if (index < 0) return content
  return content.slice(0, index).trimEnd()
}
