import React from "react";

function errorMessage(error) {
  if (!error) return "未知错误";
  if (error.stack) return String(error.stack);
  if (error.message) return String(error.message);
  return String(error);
}

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: "" };
  }

  static getDerivedStateFromError(error) {
    return { error: errorMessage(error) };
  }

  componentDidCatch(error, info) {
    this.props.onError?.(error, { componentStack: info?.componentStack || "" });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-error-screen">
          <div>
            <strong>界面渲染失败，已写入调试日志。</strong>
            <pre>{this.state.error}</pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
