/** Loading skeleton primitives + empty-state card. */

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
  icon = "📄",
  title,
  body,
  action,
}: {
  icon?: string;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
