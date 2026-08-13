import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section className="card page--centered">
        <p className="message error">Не удалось загрузить раздел.</p>
        <p>{this.state.error.message || "Неизвестная ошибка."}</p>
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          Обновить
        </button>
      </section>
    );
  }
}
