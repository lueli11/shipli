export default function NotFound() {
  return (
    <main className="grid place-items-center p-4 pt-16">
      <section className="card rise w-full max-w-md p-6 text-center">
        <h1 className="font-display text-3xl leading-none font-extrabold">Nicht gefunden</h1>
        <p className="mt-3 text-sm text-muted">Diese Seite gibt es nicht (mehr).</p>
        <a className="btn-primary mt-6" href="/">Zur Übersicht</a>
      </section>
    </main>
  );
}
