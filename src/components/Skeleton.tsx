/** Loading skeleton primitives + empty-state card. */
import type { ReactNode } from "react";
import { FileText, type LucideIcon } from "lucide-react";

export function Skel({ w = "100%", h, className = "" }: { w?: string | number; h?: string; className?: string }) {
  return (
    <div
      className={`skel ${h ?? ""} ${className}`.trim()}
      style={{ width: typeof w === "number" ? `${w}px` : w }}
    />
  );
}

/** A row of 5 shimmers for table-loading state. */
export function SkelRows({ count = 4 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div className="skel-row" key={i}>
          <Skel />
          <Skel />
          <Skel />
          <Skel />
          <Skel />
        </div>
      ))}
    </div>
  );
}

export function Empty({
  icon: Icon = FileText,
  title,
  body,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon size={22} /></div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
