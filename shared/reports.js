// Why someone can report a message. Used by the report dialog and checked again by the server.
export const REPORT_REASONS = [
  { value: 'spam', label: 'Spam or a scam' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate', label: 'Hate or discrimination' },
  { value: 'sexual', label: 'Sexual content' },
  { value: 'violence', label: 'Violence or threats' },
  { value: 'selfharm', label: 'Self-harm' },
  { value: 'other', label: 'Something else' },
];
export const REPORT_REASON_LABELS = Object.fromEntries(REPORT_REASONS.map((r) => [r.value, r.label]));
