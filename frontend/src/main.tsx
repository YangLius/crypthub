import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
// Astryx 设计系统全局样式（必须在自有 styles.css 之前导入）
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { Theme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
import { themes, defaultThemeSlug } from "./astryx-themes";
import { RouterLink } from "./router-link";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Theme theme={themes[defaultThemeSlug]}>
        <LinkProvider component={RouterLink}>
          <App />
        </LinkProvider>
      </Theme>
    </BrowserRouter>
  </StrictMode>,
);
