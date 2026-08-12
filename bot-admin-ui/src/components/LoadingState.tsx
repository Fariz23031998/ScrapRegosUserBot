export default function LoadingState({ message = "Загрузка…" }: { message?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-busy="true">
      <span className="process-spinner" aria-hidden="true" />
      <p className="loading-state__text">{message}</p>
    </div>
  );
}
