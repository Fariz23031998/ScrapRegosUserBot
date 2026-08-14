import { useEffect, useState } from "react";

export function initialsFromName(name: unknown): string {
  const value = String(name || "").trim().replace(/^@/, "");
  if (!value) return "?";
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase() || "?";
  }
  return value.slice(0, 2).toUpperCase();
}

type EntityAvatarProps = {
  src?: string | null;
  name?: string | null;
  size?: "sm" | "md";
  className?: string;
};

export default function EntityAvatar({ src, name, size = "md", className = "" }: EntityAvatarProps) {
  const photo = String(src || "").trim();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [photo]);

  const showPhoto = Boolean(photo) && !failed;
  const initials = initialsFromName(name);
  const classes = ["entity-avatar", `entity-avatar--${size}`, className].filter(Boolean).join(" ");

  return (
    <span className={classes} title={String(name || "").trim() || undefined} aria-hidden="true">
      {showPhoto ? (
        <img
          className="entity-avatar__img"
          src={photo}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="entity-avatar__initials">{initials}</span>
      )}
    </span>
  );
}
