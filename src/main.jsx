import React from "react";
import ReactDOM from "react-dom/client";
import InfraAgentPlatform from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div style={{ padding: 24, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 1200 }}>
        <InfraAgentPlatform />
      </div>
    </div>
  </React.StrictMode>
);
