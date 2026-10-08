export interface ExternalCapabilitySafeErrorMetadata {
  errorName: string;
  errorCode?: string;
}

/**
 * External capability errors can contain caller filenames, document content,
 * model output, or private Vault paths. Logs retain only non-sensitive error
 * classification so operators can aggregate failures without storing payloads.
 */
export function getExternalCapabilitySafeErrorMetadata(
  error: unknown,
): ExternalCapabilitySafeErrorMetadata {
  if (!(error instanceof Error)) return { errorName: 'UnknownError' };
  const code = (error as NodeJS.ErrnoException).code;
  return {
    errorName: error.name || 'Error',
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  };
}
