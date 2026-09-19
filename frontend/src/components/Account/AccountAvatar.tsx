import { useEffect, useState } from "react";
import type { Account } from "../../types";
import { gravatarUrl } from "../../utils/avatar";

/**
 * The account's avatar — the gravatar registered for its email when there is
 * one, the initial-letter gradient otherwise. The image is probed first, so
 * accounts without one look exactly like before.
 */
export function AccountAvatar({
  account,
  className = "h-12 w-12 text-lg",
}: {
  account: Account;
  className?: string;
}) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = gravatarUrl(account.email);
    if (!url) {
      setAvatarUrl(null);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) setAvatarUrl(url);
    };
    image.onerror = () => {
      if (!cancelled) setAvatarUrl(null);
    };
    image.src = url;
    return () => {
      cancelled = true;
    };
  }, [account.email]);

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 font-semibold text-white ${className}`}
    >
      {(account.firstName || account.email).charAt(0).toUpperCase()}
    </div>
  );
}
