export function ErrorBox({ error }: { error?: string | string[] }) {
  return error ? <p className="notice-bad mb-4" role="alert">{String(error)}</p> : null;
}
