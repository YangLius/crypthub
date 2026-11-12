/** react-router 适配器：供 Astryx 组件（LinkProvider / TopNavItem as=…）使用，保持 SPA 内导航不整页刷新。 */
import { Link } from "react-router-dom";
import type { CSSProperties, ReactNode } from "react";

export function RouterLink(props: {
  href?: string;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Link to={props.href ?? "/"} className={props.className} style={props.style}>
      {props.children}
    </Link>
  );
}
