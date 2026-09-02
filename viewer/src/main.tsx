import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty">
          <h2>The viewer crashed</h2>
          <pre className="small">{String(this.state.error.stack ?? this.state.error.message)}</pre>
          <button onClick={() => this.setState({ error: null })}>try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
